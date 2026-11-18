import path from 'node:path';
import { goRound } from './gofmt';
import { parseLoudnorm } from './loudness';
import { AudioAbsent, AudioPresent } from './mediaprobe';
import { commandError } from './run';
import type { Toolchain } from './toolchain';

export const MixSampleRate = 48_000;
export const MixOutputs = ['music.wav', 'sfx.wav', 'premaster.wav', 'candidate.mp4'] as const;

export interface MixCue {
  kind: 'music' | 'sfx';
  file: string;
  start: number;
  length: number;
  sourceStart: number;
  gainDB: number;
  fadeIn: number;
  fadeOut: number;
}

export interface MixOptions {
  directory: string;
  voice?: string;
  primaryMusic?: string;
  video: string;
  fps: number;
  frames: number;
  cues: readonly MixCue[];
  integratedLUFS: number;
  truePeakMax: number;
  loudnessTolerance: number;
  signal?: AbortSignal;
}

const format = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
const pad = (samples: number) => `apad=whole_len=${samples},atrim=end_sample=${samples}`;
const pcm = ['-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le'];

async function mixStem(t: Toolchain, cues: readonly MixCue[], samples: number, file: string, signal?: AbortSignal): Promise<void> {
  if (cues.length === 0) {
    await t.transcode(file, ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-af', pad(samples), ...pcm], signal);
    return;
  }
  const args = cues.flatMap(cue => ['-i', cue.file]);
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
  const ran = await t.runAsync(t.ffmpegPath(), [
    '-hide_banner', '-nostats', '-nostdin', '-i', file, '-vn', '-af',
    filter + (filter.includes('=') ? ':' : '=') + 'print_format=json', '-f', 'null', '-',
  ], { signal, captureStderr: true });
  if (ran.error) throw new Error(`无法测量响度：${file}（${commandError(ran, false)}）`);
  return ran.stderr.toString('utf8');
}

export async function decodedSamples(t: Toolchain, file: string, signal?: AbortSignal): Promise<number> {
  const ran = await t.runAsync(t.ffprobe, [
    '-v', 'error', '-select_streams', 'a:0', '-show_frames', '-show_entries', 'frame=nb_samples', '-of', 'json', file,
  ], { signal, captureStdout: true });
  if (ran.error) throw new Error(`无法统计解码采样数：${commandError(ran)}`);
  const decoded = JSON.parse(ran.stdout.toString('utf8')) as { frames?: Array<{ nb_samples?: unknown }> };
  const samples = (decoded.frames ?? []).map(frame => Number(frame.nb_samples));
  if (!samples.length || samples.some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('解码采样数无效');
  return samples.reduce((sum, value) => sum + value, 0);
}

export async function mixProgram(t: Toolchain, opts: MixOptions) {
  const { signal, fps, frames } = opts;
  if (Boolean(opts.voice) === Boolean(opts.primaryMusic)) throw new Error('必须给出配音或主音乐之一');
  const samples = goRound(frames / fps * MixSampleRate);
  const [music, sfx, master, candidate] = MixOutputs.map(name => path.join(opts.directory, name));
  const specification = { fps, frames, durationSeconds: frames / fps, tolerance: 1 / fps };
  const silent = t.verify(opts.video, { spec: { ...specification, audio: AudioAbsent }, exactFrames: true });
  if (!silent.ok) throw new Error(`静音母版不合格：${silent.problems.join('；')}`);
  const sourceFile = opts.voice ?? opts.primaryMusic!;
  const sourceMedia = t.probe(sourceFile);
  if (!sourceMedia.audio || sourceMedia.video) throw new Error('节目主音频必须是独立音频');
  if (opts.primaryMusic && (sourceMedia.duration_seconds > frames / fps + 1 / MixSampleRate ||
    frames / fps - sourceMedia.duration_seconds >= 1 / fps)) {
    throw new Error('主音乐必须原样覆盖时间轴，只允许补齐不足一帧的尾部');
  }
  if (opts.voice && sourceMedia.duration_seconds > frames / fps + 1 / MixSampleRate) {
    const tail = await t.runAsync(t.ffmpegPath(), [
      '-v', 'error', '-ss', String(frames / fps), '-i', opts.voice, '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', '-',
    ], { signal, captureStdout: true });
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

  if (opts.primaryMusic) {
    if (opts.cues.some(cue => cue.kind === 'music')) throw new Error('已指定主音乐，cue sheet 只填写音效');
    await t.transcode(music, ['-i', opts.primaryMusic, '-af', `${format},${pad(samples)}`, ...pcm], signal);
  } else {
    await mixStem(t, opts.cues.filter(cue => cue.kind === 'music'), samples, music, signal);
  }
  await mixStem(t, opts.cues.filter(cue => cue.kind === 'sfx'), samples, sfx, signal);
  const premix = path.join(opts.directory, 'premix.wav');
  const mix = opts.voice
    ? {
        inputs: ['-i', opts.voice, '-i', music, '-i', sfx],
        filters: `[0:a:0]${format},asetpts=PTS-STARTPTS,${pad(samples)},asplit[voice][key];` +
          '[1:a:0][key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[duck];' +
          `[voice][duck][2:a:0]amix=inputs=3:normalize=0,${pad(samples)}[mix]`,
      }
    : { inputs: ['-i', music, '-i', sfx], filters: `[0:a:0][1:a:0]amix=inputs=2:normalize=0,${pad(samples)}[mix]` };
  await t.transcode(premix, [...mix.inputs, '-filter_complex', mix.filters, '-map', '[mix]', ...pcm], signal);

  // AAC 编码可能抬高真峰，给编码留一点余量，再用实际候选复核。
  const target = `loudnorm=I=${opts.integratedLUFS}:TP=${Math.max(-9, opts.truePeakMax - 0.5)}:LRA=11`;
  const first = await loudnessLog(t, premix, target, signal);
  const measurement = JSON.parse(first.slice(first.lastIndexOf('{'), first.lastIndexOf('}') + 1)) as Record<string, unknown>;
  const measured = { measured_I: 'input_i', measured_TP: 'input_tp', measured_LRA: 'input_lra', measured_thresh: 'input_thresh', offset: 'target_offset' };
  const values = Object.entries(measured).map(([name, source]) => {
    const value = measurement[source];
    if (typeof value !== 'string' || !Number.isFinite(Number(value))) throw new Error('混音没有可用的响度测量');
    return `${name}=${Number(value)}`;
  });
  const normalize = `${target}:${values.join(':')}:linear=true,aresample=48000,${pad(samples)}`;
  await t.transcode(master, ['-i', premix, '-af', normalize, ...pcm], signal);
  const mux = (gain: number) => t.transcode(candidate, [
    '-i', opts.video, '-i', master, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    ...(gain ? ['-af', `volume=${gain}dB`] : []),
    '-c:a', 'aac', '-b:a', '384k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart',
  ], signal);
  await mux(0);
  let loudness = parseLoudnorm(await loudnessLog(t, candidate, 'loudnorm', signal));
  let encoded_gain_db = 0;
  if (loudness.true_peak_dbtp > opts.truePeakMax) {
    encoded_gain_db = opts.truePeakMax - loudness.true_peak_dbtp - 0.5;
    await mux(encoded_gain_db);
    loudness = parseLoudnorm(await loudnessLog(t, candidate, 'loudnorm', signal));
  }
  const verified = t.verify(candidate, {
    spec: { ...specification, audio: AudioPresent, sampleRate: MixSampleRate, channels: 2 },
    exactFrames: true, decode: true,
  });
  const count = await decodedSamples(t, candidate, signal);
  const problems = [...verified.problems];
  // AAC-LC 解码可能多出不足一个 1024 采样包的尾部填充。
  if (count < samples || count - samples >= 1024) problems.push(`解码采样数不符：期望 ${samples}，实际 ${count}`);
  if (loudness.true_peak_dbtp > opts.truePeakMax) problems.push(`编码后真峰超标：${loudness.true_peak_dbtp} dBTP`);
  const hints = Math.abs(loudness.integrated_lufs - opts.integratedLUFS) > opts.loudnessTolerance
    ? [`编码后积分响度 ${loudness.integrated_lufs} LUFS，目标 ${opts.integratedLUFS} LUFS`] : [];
  return { ok: problems.length === 0, problems, hints, ...loudness, encoded_gain_db,
    fps, total_frames: frames, sample_rate: MixSampleRate, target_samples_per_channel: samples, decoded_samples_per_channel: count };
}
