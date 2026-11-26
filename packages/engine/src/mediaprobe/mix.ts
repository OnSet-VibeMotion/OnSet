import path from 'node:path';
import { formatFixed, goRound } from './gofmt';
import { parseLoudnorm, SilenceFloorDB } from './loudness';
import { AudioAbsent, AudioPresent } from './mediaprobe';
import { commandError } from './run';
import type { Toolchain } from './toolchain';

export const MixSampleRate = 48_000;
export const MixOutputs = ['music.wav', 'sfx.wav', 'premaster.wav', 'candidate.mp4'] as const;
export const DefaultMixIntegratedLUFS = -14;
export const DefaultMixTruePeakMax = -1.0;
export const DefaultMixLoudnessTolerance = 1.5;
export const DefaultCuePeakCeilingDB = -1.0;

export interface MixCue {
  kind: 'music' | 'sfx';
  file: string;
  start: number;
  length: number;
  sourceStart: number;
  gainDB: number;
  fadeIn: number;
  fadeOut: number;
  /** 显式关闭本条 cue 的入轨真峰值防削波夹取（默认 false，保持防护开启）。 */
  allowClip?: boolean;
}

export interface CueClampRecord {
  index: number;
  kind: 'music' | 'sfx';
  file: string;
  source_true_peak_dbtp: number;
  clamped_from_db: number;
  applied_gain_db: number;
  ceiling_db: number;
  reason: string;
}

export interface MixOptions {
  directory: string;
  voice?: string;
  primaryMusic?: string;
  video: string;
  fps: number;
  frames: number;
  cues: readonly MixCue[];
  /** 目标积分响度（LUFS），默认 -14。 */
  integratedLUFS?: number;
  /** 目标真峰值上限（dBTP），默认 -1.0。 */
  truePeakMax?: number;
  /** 积分响度允许偏差（LU），默认 1.5。 */
  loudnessTolerance?: number;
  /** 单条入轨 cue 的真峰值防削波上限（dBFS/dBTP），默认 -1.0。 */
  cuePeakCeilingDB?: number;
  /** 全局关闭入轨真峰值防削波夹取（兼容旧行为），默认 false。 */
  allowCueClip?: boolean;
  signal?: AbortSignal;
}

const format = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
const pad = (samples: number) => `apad=whole_len=${samples},atrim=end_sample=${samples}`;
const pcm = ['-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le'];
const reEbuTruePeak = /True peak:[\t\n\f\r ]+Peak:[\t ]+([+-]?(?:\d+(?:\.\d+)?|\.\d+)|-inf)[\t ]+dBFS/i;

/** 从 ebur128=peak=true 的 stderr 汇总块提取真峰值（dBFS）。 */
export function parseEbur128TruePeak(stderr: string): number | null {
  const idx = stderr.lastIndexOf('Summary:');
  const tail = idx >= 0 ? stderr.slice(idx) : stderr;
  const match = reEbuTruePeak.exec(tail);
  if (!match) return null;
  if (/^-inf$/i.test(match[1])) return SilenceFloorDB;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.max(SilenceFloorDB, value) : null;
}

/** 构造末端砖墙限幅滤镜：关闭自动增益（level=false）并补偿前瞻延迟（latency=true）。 */
export function buildLimiterFilter(limitDB: number): string {
  const clampedDB = Math.min(-0.05, Math.max(-24, limitDB));
  const linear = Math.min(1, Math.max(0.0625, 10 ** (clampedDB / 20)));
  return `alimiter=limit=${linear.toFixed(6)}:attack=5:release=50:level=false:latency=true`;
}

async function probeCueTruePeak(t: Toolchain, cue: MixCue, signal?: AbortSignal): Promise<number | null> {
  const trim = `atrim=start_sample=${cue.sourceStart}:end_sample=${cue.sourceStart + cue.length}`;
  const ran = await t.runAsync(
    t.ffmpegPath(),
    [
      '-hide_banner',
      '-nostats',
      '-nostdin',
      '-i',
      cue.file,
      '-vn',
      '-af',
      `${format},${trim},asetpts=PTS-STARTPTS,ebur128=peak=true`,
      '-f',
      'null',
      '-',
    ],
    { signal, captureStderr: true },
  );
  if (ran.error) return null;
  return parseEbur128TruePeak(ran.stderr.toString('utf8'));
}

async function applyCuePeakGuard(
  t: Toolchain,
  cues: readonly MixCue[],
  ceilingDB: number,
  allowAllClip: boolean,
  signal?: AbortSignal,
): Promise<{ cues: MixCue[]; clamped: CueClampRecord[]; hints: string[] }> {
  const guarded: MixCue[] = [];
  const clamped: CueClampRecord[] = [];
  const hints: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (allowAllClip || cue.allowClip) {
      guarded.push(cue);
      continue;
    }
    const sourcePeak = await probeCueTruePeak(t, cue, signal);
    if (sourcePeak === null || sourcePeak <= SilenceFloorDB + 1) {
      guarded.push(cue);
      continue;
    }
    if (sourcePeak + cue.gainDB > ceilingDB) {
      // 向下取两位小数，保证 sourcePeak + appliedGainDB 严格不超过 ceilingDB。
      const applied = Math.floor((ceilingDB - sourcePeak) * 100) / 100;
      const reason = `源真峰值 ${formatFixed(sourcePeak, 1)} dBFS + 目标增益 ${formatFixed(cue.gainDB, 2)} dB 超出 ${formatFixed(ceilingDB, 1)} dBFS 上限，已夹取至 ${formatFixed(applied, 2)} dB`;
      guarded.push({ ...cue, gainDB: applied });
      clamped.push({
        index: i,
        kind: cue.kind,
        file: cue.file,
        source_true_peak_dbtp: goRound(sourcePeak * 100) / 100,
        clamped_from_db: cue.gainDB,
        applied_gain_db: applied,
        ceiling_db: ceilingDB,
        reason,
      });
      hints.push(`入轨真峰值防削波：cue #${i + 1}（${path.basename(cue.file)}）${reason}`);
    } else {
      guarded.push(cue);
    }
  }
  return { cues: guarded, clamped, hints };
}

async function mixStem(
  t: Toolchain,
  cues: readonly MixCue[],
  samples: number,
  file: string,
  signal?: AbortSignal,
): Promise<void> {
  if (cues.length === 0) {
    await t.transcode(file, ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-af', pad(samples), ...pcm], signal);
    return;
  }
  const args = cues.flatMap((cue) => ['-i', cue.file]);
  const filters = cues.map((cue, i) => {
    const trim = `atrim=start_sample=${cue.sourceStart}:end_sample=${cue.sourceStart + cue.length}`;
    const fadeIn = cue.fadeIn ? `,afade=t=in:ss=0:ns=${cue.fadeIn}` : '';
    const fadeOut = cue.fadeOut ? `,afade=t=out:ss=${cue.length - cue.fadeOut}:ns=${cue.fadeOut}` : '';
    return `[${i}:a:0]${format},${trim},asetpts=PTS-STARTPTS,${pad(cue.length)},volume=${cue.gainDB}dB${fadeIn}${fadeOut},adelay=${cue.start}S:all=1[c${i}]`;
  });
  const inputs = cues.map((_, i) => `[c${i}]`).join('');
  filters.push(`${inputs}amix=inputs=${cues.length}:normalize=0,${pad(samples)}[stem]`);
  await t.transcode(file, [...args, '-filter_complex', filters.join(';'), '-map', '[stem]', ...pcm], signal);
}

async function loudnessLog(t: Toolchain, file: string, filter: string, signal?: AbortSignal): Promise<string> {
  const ran = await t.runAsync(
    t.ffmpegPath(),
    [
      '-hide_banner',
      '-nostats',
      '-nostdin',
      '-i',
      file,
      '-vn',
      '-af',
      filter + (filter.includes('=') ? ':' : '=') + 'print_format=json',
      '-f',
      'null',
      '-',
    ],
    { signal, captureStderr: true },
  );
  if (ran.error) throw new Error(`无法测量响度：${file}（${commandError(ran, false)}）`);
  return ran.stderr.toString('utf8');
}

export async function decodedSamples(t: Toolchain, file: string, signal?: AbortSignal): Promise<number> {
  const ran = await t.runAsync(
    t.ffprobe,
    ['-v', 'error', '-select_streams', 'a:0', '-show_frames', '-show_entries', 'frame=nb_samples', '-of', 'json', file],
    { signal, captureStdout: true },
  );
  if (ran.error) throw new Error(`无法统计解码采样数：${commandError(ran)}`);
  const decoded = JSON.parse(ran.stdout.toString('utf8')) as { frames?: Array<{ nb_samples?: unknown }> };
  const samples = (decoded.frames ?? []).map((frame) => Number(frame.nb_samples));
  if (!samples.length || samples.some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new Error('解码采样数无效');
  return samples.reduce((sum, value) => sum + value, 0);
}

export async function mixProgram(t: Toolchain, opts: MixOptions) {
  const { signal, fps, frames } = opts;
  const integratedLUFS = opts.integratedLUFS ?? DefaultMixIntegratedLUFS;
  const truePeakMax = opts.truePeakMax ?? DefaultMixTruePeakMax;
  const loudnessTolerance = opts.loudnessTolerance ?? DefaultMixLoudnessTolerance;
  const cuePeakCeilingDB = opts.cuePeakCeilingDB ?? DefaultCuePeakCeilingDB;
  if (Boolean(opts.voice) === Boolean(opts.primaryMusic)) throw new Error('必须给出配音或主音乐之一');
  const samples = goRound((frames / fps) * MixSampleRate);
  const [music, sfx, master, candidate] = MixOutputs.map((name) => path.join(opts.directory, name));
  const specification = { fps, frames, durationSeconds: frames / fps, tolerance: 1 / fps };
  const silent = t.verify(opts.video, { spec: { ...specification, audio: AudioAbsent }, exactFrames: true });
  if (!silent.ok) throw new Error(`静音母版不合格：${silent.problems.join('；')}`);
  const sourceFile = opts.voice ?? opts.primaryMusic!;
  const sourceMedia = t.probe(sourceFile);
  if (!sourceMedia.audio || sourceMedia.video) throw new Error('节目主音频必须是独立音频');
  if (
    opts.primaryMusic &&
    (sourceMedia.duration_seconds > frames / fps + 1 / MixSampleRate ||
      frames / fps - sourceMedia.duration_seconds >= 1 / fps)
  ) {
    throw new Error('主音乐必须原样覆盖时间轴，只允许补齐不足一帧的尾部');
  }
  if (opts.voice && sourceMedia.duration_seconds > frames / fps + 1 / MixSampleRate) {
    const tail = await t.runAsync(
      t.ffmpegPath(),
      [
        '-v',
        'error',
        '-ss',
        String(frames / fps),
        '-i',
        opts.voice,
        '-vn',
        '-ac',
        '2',
        '-ar',
        '48000',
        '-f',
        's16le',
        '-',
      ],
      { signal, captureStdout: true },
    );
    if (tail.error) throw new Error(`无法验证配音尾部：${commandError(tail)}`);
    for (let i = 0; i + 1 < tail.stdout.length; i += 2) {
      if (Math.abs(tail.stdout.readInt16LE(i)) > 130) throw new Error('节目终点之后还有发声，请先修正时间轴');
    }
  }
  for (const cue of opts.cues) {
    const source = t.probe(cue.file);
    if (!source.audio || (cue.sourceStart + cue.length) / MixSampleRate > source.duration_seconds + 1 / MixSampleRate) {
      throw new Error(`cue 超出素材可用时间：${cue.file}`);
    }
  }

  // 入轨前真峰值防削波：检查各条 cue 的「源真峰值 + gain_db」是否超过安全上限并自动夹取。
  const guard = await applyCuePeakGuard(t, opts.cues, cuePeakCeilingDB, Boolean(opts.allowCueClip), signal);
  const guardedCues = guard.cues;

  if (opts.primaryMusic) {
    if (guardedCues.some((cue) => cue.kind === 'music')) throw new Error('已指定主音乐，cue sheet 只填写音效');
    await t.transcode(music, ['-i', opts.primaryMusic, '-af', `${format},${pad(samples)}`, ...pcm], signal);
  } else {
    await mixStem(
      t,
      guardedCues.filter((cue) => cue.kind === 'music'),
      samples,
      music,
      signal,
    );
  }
  await mixStem(
    t,
    guardedCues.filter((cue) => cue.kind === 'sfx'),
    samples,
    sfx,
    signal,
  );
  const premix = path.join(opts.directory, 'premix.wav');
  const mix = opts.voice
    ? {
        inputs: ['-i', opts.voice, '-i', music, '-i', sfx],
        filters:
          `[0:a:0]${format},asetpts=PTS-STARTPTS,${pad(samples)},asplit[voice][key];` +
          '[1:a:0][key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[duck];' +
          `[voice][duck][2:a:0]amix=inputs=3:normalize=0,${pad(samples)}[mix]`,
      }
    : { inputs: ['-i', music, '-i', sfx], filters: `[0:a:0][1:a:0]amix=inputs=2:normalize=0,${pad(samples)}[mix]` };
  await t.transcode(premix, [...mix.inputs, '-filter_complex', mix.filters, '-map', '[mix]', ...pcm], signal);

  // 两遍法 loudnorm(..., linear=true) 后串联末端 alimiter 砖墙限幅，为 AAC 取样间过冲预留余量。
  const loudnormTP = Math.max(-9, Math.min(0, truePeakMax));
  const initialLimiterDB = Math.max(-24, Math.min(-0.1, truePeakMax - 0.5));
  const target = `loudnorm=I=${integratedLUFS}:TP=${loudnormTP}:LRA=11`;
  const first = await loudnessLog(t, premix, target, signal);
  const measurement = JSON.parse(first.slice(first.lastIndexOf('{'), first.lastIndexOf('}') + 1)) as Record<
    string,
    unknown
  >;
  const measured: Array<[string, string, number, number]> = [
    ['measured_I', 'input_i', -99, 0],
    ['measured_TP', 'input_tp', -99, 99],
    ['measured_LRA', 'input_lra', 0, 99],
    ['measured_thresh', 'input_thresh', -99, 0],
    ['offset', 'target_offset', -99, 99],
  ];
  const values = measured.map(([name, source, min, max]) => {
    const raw = measurement[source];
    if (typeof raw !== 'string' || !Number.isFinite(Number(raw))) throw new Error('混音没有可用的响度测量');
    return `${name}=${Math.min(max, Math.max(min, Number(raw)))}`;
  });
  const normalize = `${target}:${values.join(':')}:linear=true,aresample=48000,${format},${buildLimiterFilter(initialLimiterDB)},${pad(samples)}`;
  await t.transcode(master, ['-i', premix, '-af', normalize, ...pcm], signal);

  const mux = (m: { limiterDB?: number; gainDB?: number } = {}) => {
    const chain = [
      ...(m.limiterDB !== undefined ? [format, buildLimiterFilter(m.limiterDB)] : []),
      ...(m.gainDB !== undefined ? [`volume=${m.gainDB}dB`] : []),
    ];
    if (chain.length > 0) chain.push(pad(samples));
    const af = chain.length > 0 ? ['-af', chain.join(',')] : [];
    const args = ['-i', opts.video, '-i', master, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...af];
    return t.transcode(
      candidate,
      [...args, '-c:a', 'aac', '-b:a', '384k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart'],
      signal,
    );
  };
  await mux();
  let loudness = parseLoudnorm(await loudnessLog(t, candidate, 'loudnorm', signal));
  let limiter_limit_db = initialLimiterDB;
  let limiter_passes = 1;
  let encoded_gain_db = 0;
  // 编码后真峰超标：先在限幅器有效范围（≥-24 dB）内收紧限幅；低于 -24 dB 或仍超标时回退整体衰减。
  if (loudness.true_peak_dbtp > truePeakMax) {
    const tighter = Math.floor((initialLimiterDB - (loudness.true_peak_dbtp - truePeakMax) - 0.5) * 100) / 100;
    if (tighter >= -24) {
      limiter_limit_db = tighter;
      limiter_passes = 2;
      await mux({ limiterDB: limiter_limit_db });
      loudness = parseLoudnorm(await loudnessLog(t, candidate, 'loudnorm', signal));
    }
    if (loudness.true_peak_dbtp > truePeakMax) {
      encoded_gain_db = Math.floor((truePeakMax - loudness.true_peak_dbtp - 0.5) * 100) / 100;
      await mux({ gainDB: encoded_gain_db, ...(limiter_passes === 2 ? { limiterDB: limiter_limit_db } : {}) });
      loudness = parseLoudnorm(await loudnessLog(t, candidate, 'loudnorm', signal));
    }
  }

  const verified = t.verify(candidate, {
    spec: { ...specification, audio: AudioPresent, sampleRate: MixSampleRate, channels: 2 },
    exactFrames: true,
    decode: true,
  });
  const count = await decodedSamples(t, candidate, signal);
  const problems = [...verified.problems];
  // AAC-LC 解码可能多出不足一个 1024 采样包的尾部填充。
  if (count < samples || count - samples >= 1024) problems.push(`解码采样数不符：期望 ${samples}，实际 ${count}`);
  if (loudness.true_peak_dbtp > truePeakMax) problems.push(`编码后真峰超标：${loudness.true_peak_dbtp} dBTP`);
  const hints = [...guard.hints];
  if (Math.abs(loudness.integrated_lufs - integratedLUFS) > loudnessTolerance) {
    hints.push(`编码后积分响度 ${loudness.integrated_lufs} LUFS，目标 ${integratedLUFS} LUFS`);
  }
  return {
    ok: problems.length === 0,
    problems,
    hints,
    ...loudness,
    encoded_gain_db,
    limiter_limit_db,
    limiter_passes,
    clamped_cues: guard.clamped,
    fps,
    total_frames: frames,
    sample_rate: MixSampleRate,
    target_samples_per_channel: samples,
    decoded_samples_per_channel: count,
  };
}
