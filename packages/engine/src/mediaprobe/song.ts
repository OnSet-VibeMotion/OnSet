import path from 'node:path';
import { formatFixed } from './gofmt';
import { AudioAbsent, AudioPresent } from './mediaprobe';
import type { Toolchain } from './toolchain';

/** 保留时间轴，解码出单声道 16 kHz 的对齐分析副本。 */
export async function prepareAlignment(t: Toolchain, source: string, dest: string, signal?: AbortSignal): Promise<void> {
  await t.transcode(dest, ['-i', source, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le'], signal);
}

/**
 * 显式给出，不吃 ffmpeg 原生 aac 的缺省 128k：瞬态密集的音乐在
 * 低码率下编解码一趟，采样之间的峰值能抬高 3 dB 以上，波形文件达标的混音在
 * 成片里顶过 0 dBFS。onset review 量的是解码后的真峰，会把这种情况报出来。
 */
const songAACBitrate = '384k';

/** Go 的 fmt %v 打印 []string：「[a b c]」。 */
function formatList(values: string[]): string {
  return `[${values.join(' ')}]`;
}

/**
 * 接受帧数精确的静音母版。只补齐不足一帧的尾巴；不提供缩放、变速、配乐或人声侧链。
 */
export async function muxSong(
  t: Toolchain,
  video: string,
  audio: string,
  dest: string,
  duration: number,
  fps: number,
  signal?: AbortSignal,
): Promise<void> {
  if (fps <= 0 || !Number.isFinite(duration) || duration <= 0) throw new Error('歌曲时长或帧率无效');
  const frames = Math.ceil(duration * fps - 1e-9);
  const target = frames / fps;
  for (const p of [video, audio]) {
    if (path.resolve(p) === path.resolve(dest)) throw new Error('输出不得覆盖输入');
  }
  const m = t.probe(audio);
  if (!m.audio || m.video || Math.abs(m.duration_seconds - duration) > 1e-6) {
    throw new Error('选定歌曲音频规格或时长不一致');
  }
  let report = t.verify(video, {
    spec: { fps, frames, durationSeconds: target, tolerance: 0.001, audio: AudioAbsent },
    exactFrames: true,
  });
  if (!report.ok) throw new Error(`歌曲静音母版不合格：${formatList(report.problems)}`);
  const filter = 'apad=pad_dur=' + formatFixed(Math.max(0, target - duration), 9) + ',atrim=duration=' + formatFixed(target, 9);
  await t.transcode(
    dest,
    ['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', filter, '-c:a', 'aac', '-b:a', songAACBitrate, '-ar', '48000', '-ac', '2', '-movflags', '+faststart'],
    signal,
  );
  report = t.verify(dest, {
    spec: { fps, frames, durationSeconds: target, tolerance: 1.0 / fps, audio: AudioPresent, sampleRate: 48000, channels: 2 },
    exactFrames: true,
    decode: true,
  });
  if (!report.ok) throw new Error(`歌曲成片不合格：${formatList(report.problems)}`);
}
