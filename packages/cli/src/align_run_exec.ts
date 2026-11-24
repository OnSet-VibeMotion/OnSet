/**
 * 本地对齐的候选复用校验、锁管理、模型进程执行（单段/分段）与规范路径发布。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as align from '@onset/engine/align';
import { formatFixed } from '@onset/engine/gofmt';
import { marshalIndent } from '@onset/engine/gojson';
import type * as mediaprobe from '@onset/engine/mediaprobe';
import { start } from '@onset/engine/procgroup';
import { type AutoChunk, inputPath, roundMs, sha, writeJsonFile } from './align_run_chunks';

/** 读取并校验候选目录内已通过独立校验的 verified.json；若产物被改过则报错。 */
export function loadVerifiedCandidate(base: string, manifest: string, digest: string): Record<string, any> | null {
  if (!fs.existsSync(manifest)) return null;
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const keys = ['align', 'srt', 'phrases', 'report', 'audio_check'];
  const valid =
    data.digest === digest &&
    data.paths &&
    data.hashes &&
    keys.every((key) => typeof data.paths[key] === 'string' && Object.hasOwn(data.hashes, data.paths[key])) &&
    Object.entries(data.hashes as Record<string, string>).every(
      ([file, hash]) => !path.isAbsolute(file) && sha(inputPath(base, file)) === hash,
    );
  if (!valid) throw Error('已验证候选产物发生变化，保留现场；请检查输入与候选目录');
  return {
    ...data,
    attempt: path.dirname(inputPath(base, data.paths.align)),
    paths: Object.fromEntries(keys.map((key) => [key, inputPath(base, data.paths[key])])),
    hashes: Object.fromEntries(Object.entries(data.hashes).map(([file, hash]) => [inputPath(base, file), hash])),
  };
}

/** 独占获取候选目录的运行锁；retry=true 且原进程已退出时允许接管陈旧锁。 */
export function acquireRunLock(base: string, retry: boolean): { fd: number; lock: string } {
  const lock = path.join(base, 'running.lock');
  let fd: number;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let stale = false;
    if (retry) {
      try {
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
          } catch (e) {
            stale = (e as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }
      } catch {
        // 不清理归属不明的锁。
      }
    }
    if (!stale) throw Error('同一输入已有任务或待诊断的锁，请等待原任务，勿重复提交：' + base);
    fs.unlinkSync(lock);
    fd = fs.openSync(lock, 'wx');
  }
  try {
    fs.writeFileSync(fd, marshalIndent({ pid: process.pid, started_at: new Date().toISOString() }));
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore close failure
    }
    try {
      fs.unlinkSync(lock);
    } catch {
      // ignore unlink failure
    }
    throw err;
  }
  return { fd, lock };
}

export interface ChunkRunOptions {
  root: string;
  attempt: string;
  wav: string;
  raw: string;
  scriptPath: string;
  source: string;
  provider: 'funasr' | 'mlx';
  model: string;
  runnerCommand: string;
  env: Record<string, string>;
  seconds: number;
  chain: ReturnType<typeof mediaprobe.newToolchain>;
  chunks: readonly AutoChunk[];
  signal: AbortSignal;
}

/** 按 TTS 段落边界逐段切音并调用本地模型对齐，最后按段起始偏移合并字级时间轴。 */
export async function runChunkedAlignment(opts: ChunkRunOptions): Promise<void> {
  if (opts.provider === 'funasr') fs.writeFileSync(opts.scriptPath, opts.source);
  const merged: Array<{ text: string; start: number; end: number }> = [];
  const log = fs.openSync(path.join(opts.attempt, 'python.log'), 'wx');
  try {
    for (const chunk of opts.chunks) {
      opts.signal.throwIfAborted();
      const tag = String(chunk.index + 1).padStart(3, '0');
      const chunkWav = path.join(opts.attempt, `chunk-${tag}.wav`);
      const chunkOut = path.join(opts.attempt, `chunk-${tag}.json`);
      await opts.chain.transcode(
        chunkWav,
        [
          '-ss',
          formatFixed(chunk.start, 6),
          '-t',
          formatFixed(chunk.end - chunk.start, 6),
          '-i',
          opts.wav,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
        ],
        opts.signal,
      );
      let args: string[];
      if (opts.provider === 'mlx') {
        args = [
          '--model',
          opts.model,
          '--audio',
          chunkWav,
          '--text',
          chunk.text,
          '--language',
          'Chinese',
          '--output-path',
          chunkOut.slice(0, -5),
          '--format',
          'json',
        ];
      } else {
        const chunkTextFile = path.join(opts.attempt, `chunk-${tag}.txt`);
        fs.writeFileSync(chunkTextFile, chunk.text + '\n');
        args = [opts.scriptPath, opts.model, chunkWav, chunkTextFile, chunkOut];
      }
      const timeoutSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(Math.ceil(opts.seconds * 1000))]);
      const child = await start(opts.runnerCommand, args, {
        cwd: opts.root,
        env: { ...opts.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1' },
        stdio: ['ignore', log, log],
        signal: timeoutSignal,
      });
      await child.wait();
      for (const item of align.loadEvidence(chunkOut)) {
        merged.push({
          text: item.text,
          start: roundMs(item.start + chunk.start),
          end: roundMs(item.end + chunk.start),
        });
      }
    }
  } finally {
    fs.closeSync(log);
  }
  writeJsonFile(opts.raw, merged);
}

export interface SingleRunOptions {
  root: string;
  attempt: string;
  audio: string;
  wav: string;
  raw: string;
  text: string;
  textFile: string;
  scriptPath: string;
  source: string;
  requests: string;
  segments: unknown | null;
  provider: 'funasr' | 'mlx';
  model: string;
  runnerCommand: string;
  env: Record<string, string>;
  seconds: number;
  signal: AbortSignal;
}

/** 单次调用本地对齐模型（整片或 FunASR 原始分段清单模式）。 */
export async function runSingleAlignment(opts: SingleRunOptions): Promise<void> {
  if (opts.segments) writeJsonFile(opts.requests, opts.segments);
  let args: string[];
  if (opts.provider === 'mlx') {
    args = [
      '--model',
      opts.model,
      '--audio',
      opts.wav,
      '--text',
      opts.text,
      '--language',
      'Chinese',
      '--output-path',
      opts.raw.slice(0, -5),
      '--format',
      'json',
    ];
  } else {
    fs.writeFileSync(opts.textFile, opts.text + '\n');
    fs.writeFileSync(opts.scriptPath, opts.source);
    args = [
      opts.scriptPath,
      opts.model,
      opts.segments ? opts.audio : opts.wav,
      opts.textFile,
      opts.raw,
      ...(opts.segments ? [opts.requests] : []),
    ];
  }
  const timeoutSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(Math.ceil(opts.seconds * 1000))]);
  const log = fs.openSync(path.join(opts.attempt, 'python.log'), 'wx');
  try {
    const child = await start(opts.runnerCommand, args, {
      cwd: opts.root,
      env: { ...opts.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1' },
      stdio: ['ignore', log, log],
      signal: timeoutSignal,
    });
    await child.wait();
  } finally {
    fs.closeSync(log);
  }
}

/** 首次生成时把候选文件原子拷贝到项目规范路径；若已有确认分镜/镜头或规范文件则拒绝。 */
export function publishAlignedCandidate(
  root: string,
  manifest: string,
  paths: Record<string, string>,
  legacyWindows: boolean,
): void {
  const production = path.join(root, 'production');
  if (fs.readdirSync(production).some((name) => /(?:storyboard|scene|shot)[-_]approval.*\.json$/i.test(name))) {
    throw Error('已有确认的分镜或镜头，保留规范输入，仅返回候选');
  }
  const approvals = path.join(root, 'production/approvals');
  const scenes = path.join(root, 'scenes');
  if (
    (fs.existsSync(approvals) && fs.readdirSync(approvals).some((name) => /storyboard|scene|shot/i.test(name))) ||
    (fs.existsSync(scenes) &&
      fs.readdirSync(scenes).some((id) => fs.existsSync(path.join(scenes, id, '.onset-render.json'))))
  ) {
    throw Error('已有确认的分镜或镜头，保留规范输入，仅返回候选');
  }
  const targets: Array<[string, string]> = [
    [paths.align, 'production/audio/align.json'],
    [paths.srt, 'production/audio/voice.srt'],
    [paths.phrases, 'production/phrase-timeline.json'],
    [paths.report, 'production/audio/align-report.json'],
  ];
  if (legacyWindows) targets.push([paths.srt, 'transcription-production.srt']);
  else targets.push([paths.audio_check, 'production/audio/voice-check.json']);
  if (
    fs.existsSync(path.join(root, 'transcription-production.srt')) ||
    targets.some(([, rel]) => fs.existsSync(path.join(root, rel)))
  ) {
    throw Error('已有规范输出，保留原文件，仅返回已验证候选：' + manifest);
  }
  const created: string[] = [];
  try {
    for (const [source, relative] of targets) {
      const target = path.join(root, relative);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      created.push(target);
    }
  } catch (error) {
    for (const file of created) fs.unlinkSync(file);
    throw error;
  }
}

export interface SealCandidateOptions {
  base: string;
  manifest: string;
  digest: string;
  inputs: Record<string, unknown>;
  attempt: string;
  seconds: number;
  summary: Record<string, unknown>;
  paths: { align: string; srt: string; phrases: string; report: string; audio_check: string };
  extraHashFiles: string[];
}

/** 计算候选目录全部产物哈希并写入相对路径形式的 verified.json，返回绝对路径版本供本次运行使用。 */
export function sealVerifiedCandidate(opts: SealCandidateOptions): Record<string, any> {
  const hashFiles = [
    opts.paths.align,
    opts.paths.srt,
    opts.paths.phrases,
    opts.paths.report,
    opts.paths.audio_check,
    ...opts.extraHashFiles,
  ];
  const cached: Record<string, any> = {
    digest: opts.digest,
    inputs: opts.inputs,
    attempt: opts.attempt,
    seconds: opts.seconds,
    summary: opts.summary,
    paths: opts.paths,
    hashes: Object.fromEntries(hashFiles.map((file) => [file, sha(file)])),
  };
  writeJsonFile(opts.manifest, {
    ...cached,
    attempt: path.relative(opts.base, opts.attempt),
    paths: Object.fromEntries(
      Object.entries(cached.paths as Record<string, string>).map(([key, file]) => [
        key,
        path.relative(opts.base, file),
      ]),
    ),
    hashes: Object.fromEntries(
      Object.entries(cached.hashes as Record<string, string>).map(([file, hash]) => [
        path.relative(opts.base, file),
        hash,
      ]),
    ),
  });
  return cached;
}
