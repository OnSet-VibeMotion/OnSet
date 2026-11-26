import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '@onset/engine/envutil';
import { atomicWrite } from '@onset/engine/fsutil';
import { goRound } from '@onset/engine/gofmt';
import { marshal, marshalIndent } from '@onset/engine/gojson';
import { lockFile } from '@onset/engine/hyperframes';
import { MixOutputs, MixSampleRate, mixProgram, newToolchain, patchVoice } from '@onset/engine/mediaprobe';
import { rejectSymlinkPath } from '@onset/engine/project';
import { audioTargetsOf, canvasOf, contained } from '@onset/engine/scene';
import { sha256File } from '@onset/engine/toolinstall';
import { asObject, expectFrame, inputFile, readMixCues, readProjectJSON } from './audio_mix_cues';
import { bool, projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

const outputNames = [...MixOutputs, 'machine-qc.json'] as const;
const hash = (value: unknown) => crypto.createHash('sha256').update(marshal(value)).digest('hex');

function publish(audio: string, work: string): void {
  const backup = fs.mkdtempSync(path.join(audio, 'mix-previous-'));
  const moved: string[] = [],
    installed: string[] = [];
  try {
    for (const name of outputNames) {
      const target = path.join(audio, name);
      if (!fs.existsSync(target)) continue;
      fs.renameSync(target, path.join(backup, name));
      moved.push(name);
    }
    for (const name of outputNames) {
      fs.renameSync(path.join(work, name), path.join(audio, name));
      installed.push(name);
    }
  } catch (err) {
    for (const name of installed.reverse()) fs.renameSync(path.join(audio, name), path.join(work, name));
    for (const name of moved.reverse()) fs.renameSync(path.join(backup, name), path.join(audio, name));
    throw err;
  } finally {
    if (fs.readdirSync(backup).length === 0) fs.rmdirSync(backup);
  }
}

defineOp({
  name: 'audio_mix',
  cli: ['audio', 'mix'],
  summary: '按已确认的声音 cue 混音并校验候选成片',
  description: `读取静音母版、配音、时长报告与 cue-sheet.json，以 48kHz 双声道输出 music.wav、sfx.wav、premaster.wav 与 candidate.mp4。
cue sheet：{"schema":1,"cues":[{"kind":"music","asset":"assets/music.wav","start_frame":0,"duration_frames":240,"gain_db":-18,"fade_in_frames":12,"fade_out_frames":24}]}。
空 cues 只保留人声。音效 kind 用 sfx，可以 event_id、phrase_id 或 anchor_id / anchor_frame + peak_seconds 绑定：按峰值时刻自动反推入点，负入点自动截断至 0 并换算起播位置。可从 source_start_frame 或 trim_start_seconds 开始剪取素材。
自动压低人声下的音乐、单条 cue 入轨真峰值防削波夹取、两遍响度串联末端 alimiter 砖墙限幅、检查 AAC 解码真峰与采样数。相同输入复用校验通过的候选。不同输入要显式 replace=true，原候选会归档。`,
  examples: ['audio_mix()', 'audio_mix({"replace":true})'],
  params: {
    project_root: projectRoot,
    cue_sheet: { type: 'string', description: '当前确认的音频 cue sheet', default: 'production/audio/cue-sheet.json' },
    anchors: {
      type: 'string',
      description: '可选命名锚点表（默认 production/beat/anchors.json，用于解析 SFX anchor_id）',
    },
    primary_music: { type: 'string', description: '纯音乐项目用已确认的整首音乐，不剪接或变速' },
    expect_frames: { type: 'integer', description: '使用主音乐时传确认的总帧数' },
    allow_cue_clip: { type: 'boolean', description: '全局关闭入轨 cue 真峰值防削波夹取（仅用于兼容旧行为）' },
    replace: { type: 'boolean', description: '显式替换并保留先前的候选与音轨' },
  },
  run: async (p, { out, signal }) => {
    const root = fs.realpathSync(str(p.project_root)),
      audio = path.join(root, 'production/audio');
    rejectSymlinkPath(root, audio);
    for (const name of outputNames) {
      const target = path.join(audio, name);
      rejectSymlinkPath(root, target);
      if (fs.existsSync(target) && !fs.statSync(target).isFile()) throw new Error(`混音目标必须是普通文件：${name}`);
    }
    const unlock = await lockFile(path.join(audio, '.mix.lock'), signal);
    try {
      signal.throwIfAborted();
      const { fps } = canvasOf(root, 'frame.md');
      const primaryMusic = str(p.primary_music) ? inputFile(root, str(p.primary_music)) : undefined;
      const timing = primaryMusic
        ? undefined
        : asObject(readProjectJSON(root, 'production/timing-report.json'), '时长报告');
      const frames = expectFrame(timing?.total_frames ?? p.expect_frames, '节目总帧数', 1);
      if (
        timing &&
        (timing.fps !== fps ||
          timing.target_samples_per_channel !== goRound((frames / fps) * MixSampleRate) ||
          timing.sample_rate !== MixSampleRate)
      ) {
        throw new Error('时长报告与项目画幅或采样数不符');
      }
      const { integratedLUFS, tolerance: loudnessTolerance, truePeakMax } = audioTargetsOf(root, 'frame.md');
      const voice = primaryMusic ? undefined : inputFile(root, 'production/audio/voice.wav');
      const video = inputFile(root, 'production/silent-master.mp4');
      const sheet = str(p.cue_sheet);
      const anchorsFile = str(p.anchors) || undefined;
      const cues = readMixCues(root, sheet, fps, frames, { anchorsFile });
      const inputs = [...new Set([voice ?? primaryMusic!, video, ...cues.map((cue) => cue.file)])];
      if (outputNames.some((name) => inputs.includes(path.join(audio, name))))
        throw new Error('混音输出不能作为 cue 源素材');
      const hashes = async (files: readonly string[]) => {
        const result: string[] = [];
        for (const file of files) {
          signal.throwIfAborted();
          result.push(await sha256File(file));
        }
        return result;
      };
      const sourceHashes = await hashes(inputs);
      const allowCueClip = bool(p.allow_cue_clip);
      const signature = hash({
        recipe: 2,
        primaryMusic: !!primaryMusic,
        fps,
        frames,
        integratedLUFS,
        loudnessTolerance,
        truePeakMax,
        allowCueClip,
        cues,
        sourceHashes,
      });
      const receipt = path.join(audio, 'machine-qc.json');
      const data = {
        candidate: 'production/audio/candidate.mp4',
        report: 'production/audio/machine-qc.json',
        total_frames: frames,
      };
      const outputs = MixOutputs.map((name) => path.join(audio, name));
      if (fs.existsSync(receipt) && outputs.every((file) => fs.existsSync(file))) {
        let previous: { ok?: boolean; signature?: string; outputs?: string[] } | null = null;
        try {
          previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        if (
          previous?.ok === true &&
          previous.signature === signature &&
          marshal(previous.outputs) === marshal(await hashes(outputs))
        ) {
          out.write('输入与候选一致，复用已校验的混音\n');
          return { data: { ...data, reused: true } };
        }
      }
      if (!bool(p.replace) && outputNames.some((name) => fs.existsSync(path.join(audio, name))))
        throw new Error('存在不同的混音产物，要生成新候选请传 replace=true');
      // 只在持锁的新一轮混音开始时清理临时目录，保留本轮失败的工作文件和正式归档。
      for (const entry of fs.readdirSync(audio, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\.mix-[A-Za-z0-9]{6}$/.test(entry.name)) {
          fs.rmSync(path.join(audio, entry.name), { recursive: true, force: true });
        }
      }
      const work = fs.mkdtempSync(path.join(audio, '.mix-'));
      try {
        const report = await mixProgram(newToolchain(envMap()), {
          directory: work,
          voice,
          primaryMusic,
          video,
          fps,
          frames,
          cues,
          integratedLUFS,
          loudnessTolerance,
          truePeakMax,
          allowCueClip,
          signal,
        });
        atomicWrite(
          path.join(work, 'machine-qc.json'),
          marshalIndent({
            ...report,
            signature,
            outputs: await hashes(MixOutputs.map((name) => path.join(work, name))),
          }) + '\n',
        );
        if (!report.ok) throw new Error(report.problems.join('；'));
        if (
          marshal(await hashes(inputs)) !== marshal(sourceHashes) ||
          marshal(readMixCues(root, sheet, fps, frames, { anchorsFile })) !== marshal(cues)
        ) {
          throw new Error('混音输入在执行期间发生变化');
        }
        signal.throwIfAborted();
        publish(audio, work);
        for (const hint of report.hints) out.write(`提示：${hint}\n`);
        out.write('已输出 production/audio/candidate.mp4，编码后真峰与采样数校验通过\n');
        fs.rmSync(work, { recursive: true, force: true });
        return {
          data: {
            ...data,
            reused: false,
            ...(report.clamped_cues.length > 0 ? { clamped_cues: report.clamped_cues } : {}),
          },
        };
      } catch (err) {
        throw new Error(`混音未发布：${(err as Error).message}。工作文件在 ${work}`, { cause: err });
      }
    } finally {
      unlock();
    }
  },
});

defineOp({
  name: 'audio_patch_voice',
  cli: ['audio', 'patch-voice'],
  summary: '把局部补录拼回原配音的指定区间并生成前后试听片段',
  description:
    '用整数帧指定已核对的起止边界。短补录用静音补齐，长补录报错。原配音与区间外采样保持原样，结果写进新的试听目录。',
  examples: [
    'audio_patch_voice({"replacement":"production/audio/take-02.wav","start_frame":120,"end_frame_exclusive":180,"output_dir":"production/audio/voice-patch-02"})',
  ],
  params: {
    project_root: projectRoot,
    original: {
      type: 'string',
      description: '原配音（48kHz 双声道 PCM16 WAV）',
      default: 'production/audio/voice.wav',
    },
    replacement: { type: 'string', description: '本次局部补录的音频', required: true },
    start_frame: { type: 'integer', description: '已核对的开始帧', required: true },
    end_frame_exclusive: { type: 'integer', description: '已核对的结束帧（不含）', required: true },
    output_dir: { type: 'string', description: 'production/audio 下的新试听目录', required: true },
  },
  run: async (p, { out, signal }) => {
    const root = fs.realpathSync(str(p.project_root));
    const requested = str(p.output_dir);
    const target = contained(root, requested, '补录输出');
    const relative = path.relative(root, target).split(path.sep).join('/');
    if (!relative.startsWith('production/audio/') || relative.split('/').some((part) => part.startsWith('.'))) {
      throw new Error('output_dir 必须是 production/audio 下的新试听目录');
    }
    rejectSymlinkPath(root, path.resolve(root, requested));
    if (fs.existsSync(target)) throw new Error('试听目录已经存在，请用新的版本目录');
    const original = inputFile(root, str(p.original)),
      replacement = inputFile(root, str(p.replacement));
    const { fps } = canvasOf(root, 'frame.md');
    const startSample = goRound((expectFrame(p.start_frame, '补录开始帧') / fps) * MixSampleRate);
    const endSample = goRound((expectFrame(p.end_frame_exclusive, '补录结束帧', 1) / fps) * MixSampleRate);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const work = fs.mkdtempSync(path.join(path.dirname(target), '.voice-patch-'));
    try {
      const report = await patchVoice(newToolchain(envMap()), {
        directory: work,
        original,
        replacement,
        startSample,
        endSample,
        signal,
      });
      atomicWrite(path.join(work, 'report.json'), marshalIndent(report) + '\n');
      signal.throwIfAborted();
      if (fs.existsSync(target)) throw new Error('试听目录已由另一操作创建');
      fs.renameSync(work, target);
      out.write(`已生成 ${relative}/voice.wav 与前后试听。配音总采样数一致。\n`);
      return {
        data: {
          audio: relative + '/voice.wav',
          before: relative + '/before.wav',
          after: relative + '/after.wav',
          report: relative + '/report.json',
        },
      };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
});
