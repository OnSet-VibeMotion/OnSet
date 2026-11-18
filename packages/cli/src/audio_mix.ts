import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '@onset/engine/fsutil';
import { goRound } from '@onset/engine/gofmt';
import { marshal, marshalIndent } from '@onset/engine/gojson';
import { lockFile } from '@onset/engine/hyperframes';
import { mixProgram, MixOutputs, MixSampleRate, newToolchain, patchVoice, type MixCue } from '@onset/engine/mediaprobe';
import { rejectSymlinkPath } from '@onset/engine/project';
import { loadInventory } from '@onset/engine/reads';
import { audioTargetsOf, canvasOf, contained, parsePhraseTimeline } from '@onset/engine/scene';
import { sha256File } from '@onset/engine/toolinstall';
import { envMap } from '@onset/engine/envutil';
import { bool, projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

const outputNames = [...MixOutputs, 'machine-qc.json'] as const;
const hash = (value: unknown) => crypto.createHash('sha256').update(marshal(value)).digest('hex');

function inputFile(root: string, relative: string): string {
  const file = contained(root, relative, '混音输入');
  const parts = path.relative(root, file).split(path.sep);
  if (parts.some(part => part.startsWith('.')) || !fs.statSync(file).isFile()) throw new Error(`混音输入必须是项目内的非隐藏文件：${relative}`);
  return file;
}

function readJSON(root: string, name: string): unknown {
  return JSON.parse(fs.readFileSync(inputFile(root, name), 'utf8'));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}

function frame(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`${label} 必须是至少为 ${min} 的整数帧数`);
  return value;
}

function readCues(root: string, file: string, fps: number, frames: number): MixCue[] {
  const sheet = object(readJSON(root, file), 'cue sheet');
  if (sheet.schema !== 1 || !Array.isArray(sheet.cues)) throw new Error('cue sheet 需要 schema: 1 和 cues 数组');
  let events: Map<string, number> | undefined;
  let phrases: Map<string, number> | undefined;
  const parseStart = (cue: Record<string, unknown>, label: string): number => {
    if (cue.kind === 'music') return frame(cue.start_frame ?? 0, label + ' start_frame');
    if (typeof cue.event_id === 'string' && cue.event_id && !cue.phrase_id) {
      if (!events) {
        const inventory = loadInventory(inputFile(root, 'production/visible-event-inventory.json'));
        if (inventory.fps !== fps) throw new Error('可见事件清单帧率与画幅不符');
        events = new Map(inventory.events.map(event => [event.event_id, event.enter_frame]));
      }
      return frame(events.get(cue.event_id), label + ' event_id 的起始帧');
    }
    if (typeof cue.phrase_id === 'string' && cue.phrase_id && !cue.event_id) {
      phrases ??= new Map(parsePhraseTimeline(fs.readFileSync(inputFile(root, 'production/phrase-timeline.json')), fps).phrases!.map(phrase => [phrase.phrase_id, phrase.start_frame]));
      return frame(phrases.get(cue.phrase_id), label + ' phrase_id 的起始帧');
    }
    throw new Error(label + ' 需要一个有效的 event_id 或 phrase_id');
  };
  const samples = (f: number) => goRound(f / fps * MixSampleRate);
  return sheet.cues.map((item, i) => {
    const label = `cue ${i + 1}`, cue = object(item, label);
    if (cue.kind !== 'music' && cue.kind !== 'sfx') throw new Error(label + ' kind 必须是 music 或 sfx');
    if (typeof cue.asset !== 'string' || !cue.asset) throw new Error(label + ' 缺少 asset');
    const start = parseStart(cue, label);
    if (cue.start_frame !== undefined && cue.start_frame !== start) throw new Error(label + ' start_frame 与绑定的事件不一致');
    const length = frame(cue.duration_frames, label + ' duration_frames', 1);
    if (start + length > frames) throw new Error(label + ' 越过节目终点');
    const sourceStart = frame(cue.source_start_frame ?? 0, label + ' source_start_frame');
    const gain = cue.gain_db ?? (cue.kind === 'music' ? -18 : -12);
    if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < -90 || gain > 12) throw new Error(label + ' gain_db 必须在 -90 到 12 之间');
    const fadeIn = frame(cue.fade_in_frames ?? 0, label + ' fade_in_frames');
    const fadeOut = frame(cue.fade_out_frames ?? 0, label + ' fade_out_frames');
    if (fadeIn + fadeOut > length) throw new Error(label + ' 淡入淡出超过 cue 长度');
    return { kind: cue.kind, file: inputFile(root, cue.asset), start: samples(start), length: samples(start + length) - samples(start),
      sourceStart: samples(sourceStart), gainDB: gain, fadeIn: samples(fadeIn), fadeOut: samples(fadeOut) };
  });
}

function publish(audio: string, work: string): void {
  const backup = fs.mkdtempSync(path.join(audio, 'mix-previous-'));
  const moved: string[] = [], installed: string[] = [];
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
空 cues 只保留人声。音效 kind 用 sfx，以 event_id 或 phrase_id 为起点。可从 source_start_frame 开始剪取素材。
自动压低人声下的音乐、两遍响度、检查 AAC 解码真峰与采样数。相同输入复用校验通过的候选。不同输入要显式 replace=true，原候选会归档。`,
  examples: ['audio_mix()', 'audio_mix({"replace":true})'],
  params: {
    project_root: projectRoot,
    cue_sheet: { type: 'string', description: '当前确认的音频 cue sheet', default: 'production/audio/cue-sheet.json' },
    primary_music: { type: 'string', description: '纯音乐项目用已确认的整首音乐，不剪接或变速' },
    expect_frames: { type: 'integer', description: '使用主音乐时传确认的总帧数' },
    replace: { type: 'boolean', description: '显式替换并保留先前的候选与音轨' },
  },
  run: async (p, { out, signal }) => {
    const root = fs.realpathSync(str(p.project_root)), audio = path.join(root, 'production/audio');
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
      const timing = primaryMusic ? undefined : object(readJSON(root, 'production/timing-report.json'), '时长报告');
      const frames = frame(timing?.total_frames ?? p.expect_frames, '节目总帧数', 1);
      if (timing && (timing.fps !== fps || timing.target_samples_per_channel !== goRound(frames / fps * MixSampleRate) || timing.sample_rate !== MixSampleRate)) {
        throw new Error('时长报告与项目画幅或采样数不符');
      }
      const { integratedLUFS, tolerance: loudnessTolerance, truePeakMax } = audioTargetsOf(root, 'frame.md');
      const voice = primaryMusic ? undefined : inputFile(root, 'production/audio/voice.wav');
      const video = inputFile(root, 'production/silent-master.mp4');
      const sheet = str(p.cue_sheet);
      const cues = readCues(root, sheet, fps, frames);
      const inputs = [...new Set([voice ?? primaryMusic!, video, ...cues.map(cue => cue.file)])];
      if (outputNames.some(name => inputs.includes(path.join(audio, name)))) throw new Error('混音输出不能作为 cue 源素材');
      const hashes = async (files: readonly string[]) => {
        const result: string[] = [];
        for (const file of files) { signal.throwIfAborted(); result.push(await sha256File(file)); }
        return result;
      };
      const sourceHashes = await hashes(inputs);
      const signature = hash({ recipe: 1, primaryMusic: !!primaryMusic, fps, frames, integratedLUFS, loudnessTolerance, truePeakMax, cues, sourceHashes });
      const receipt = path.join(audio, 'machine-qc.json');
      const data = { candidate: 'production/audio/candidate.mp4', report: 'production/audio/machine-qc.json', total_frames: frames };
      const outputs = MixOutputs.map(name => path.join(audio, name));
      if (fs.existsSync(receipt) && outputs.every(file => fs.existsSync(file))) {
        let previous: { ok?: boolean; signature?: string; outputs?: string[] } | null = null;
        try {
          previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        if (previous?.ok === true && previous.signature === signature && marshal(previous.outputs) === marshal(await hashes(outputs))) {
          out.write('输入与候选一致，复用已校验的混音\n');
          return { data: { ...data, reused: true } };
        }
      }
      if (!bool(p.replace) && outputNames.some(name => fs.existsSync(path.join(audio, name)))) throw new Error('存在不同的混音产物，要生成新候选请传 replace=true');
      // 只在持锁的新一轮混音开始时清理临时目录，保留本轮失败的工作文件和正式归档。
      for (const entry of fs.readdirSync(audio, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\.mix-[A-Za-z0-9]{6}$/.test(entry.name)) {
          fs.rmSync(path.join(audio, entry.name), { recursive: true, force: true });
        }
      }
      const work = fs.mkdtempSync(path.join(audio, '.mix-'));
      try {
        const report = await mixProgram(newToolchain(envMap()), { directory: work, voice, primaryMusic, video, fps, frames, cues, integratedLUFS, loudnessTolerance, truePeakMax, signal });
        atomicWrite(path.join(work, 'machine-qc.json'), marshalIndent({ ...report, signature, outputs: await hashes(MixOutputs.map(name => path.join(work, name))) }) + '\n');
        if (!report.ok) throw new Error(report.problems.join('；'));
        if (marshal(await hashes(inputs)) !== marshal(sourceHashes) || marshal(readCues(root, sheet, fps, frames)) !== marshal(cues)) {
          throw new Error('混音输入在执行期间发生变化');
        }
        signal.throwIfAborted();
        publish(audio, work);
        for (const hint of report.hints) out.write(`提示：${hint}\n`);
        out.write('已输出 production/audio/candidate.mp4，编码后真峰与采样数校验通过\n');
        fs.rmSync(work, { recursive: true, force: true });
        return { data: { ...data, reused: false } };
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
  description: '用整数帧指定已核对的起止边界。短补录用静音补齐，长补录报错。原配音与区间外采样保持原样，结果写进新的试听目录。',
  examples: ['audio_patch_voice({"replacement":"production/audio/take-02.wav","start_frame":120,"end_frame_exclusive":180,"output_dir":"production/audio/voice-patch-02"})'],
  params: {
    project_root: projectRoot,
    original: { type: 'string', description: '原配音（48kHz 双声道 PCM16 WAV）', default: 'production/audio/voice.wav' },
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
    if (!relative.startsWith('production/audio/') || relative.split('/').some(part => part.startsWith('.'))) {
      throw new Error('output_dir 必须是 production/audio 下的新试听目录');
    }
    rejectSymlinkPath(root, path.resolve(root, requested));
    if (fs.existsSync(target)) throw new Error('试听目录已经存在，请用新的版本目录');
    const original = inputFile(root, str(p.original)), replacement = inputFile(root, str(p.replacement));
    const { fps } = canvasOf(root, 'frame.md');
    const startSample = goRound(frame(p.start_frame, '补录开始帧') / fps * MixSampleRate);
    const endSample = goRound(frame(p.end_frame_exclusive, '补录结束帧', 1) / fps * MixSampleRate);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const work = fs.mkdtempSync(path.join(path.dirname(target), '.voice-patch-'));
    try {
      const report = await patchVoice(newToolchain(envMap()), { directory: work, original, replacement, startSample, endSample, signal });
      atomicWrite(path.join(work, 'report.json'), marshalIndent(report) + '\n');
      signal.throwIfAborted();
      if (fs.existsSync(target)) throw new Error('试听目录已由另一操作创建');
      fs.renameSync(work, target);
      out.write(`已生成 ${relative}/voice.wav 与前后试听。配音总采样数一致。\n`);
      return { data: { audio: relative + '/voice.wav', before: relative + '/before.wav', after: relative + '/after.wav', report: relative + '/report.json' } };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
});
