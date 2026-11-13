import { atomicWrite } from '../fsutil';
import { goRound } from './gofmt';
import { commandError } from './run';
import type { Toolchain } from './toolchain';

/** 试听轨的采样率；与成片工作格式一致。 */
const clickSampleRate = 48000;

// 咔嗒声的音色：重拍高八度，人耳一听就能分清每小节从哪开始。
const clickSeconds = 0.035;
const clickDownbeatHz = 1760.0;
const clickBeatHz = 880.0;
const clickDownbeatLevel = 0.55;
const clickBeatLevel = 0.3;
const clickMusicLevel = 0.5;

/**
 * 判定「这一拍是重拍」的时间容差。手改过的网格里重拍与
 * 普通拍可能差一两毫秒的浮点尾数，按精确相等比会把重拍听成普通拍。
 */
const clickMatchSeconds = 0.002;

/**
 * 把音乐解码成单声道 16 位 WAV，供节拍分析读取。
 *
 * 分析端只用 Python 标准库的 wave 读取，不走分析库自带的 torchaudio 读文件：
 * 后者的后端随版本变化，MP3/AAC 能不能读取决于用户机器上装了什么。
 */
export async function decodeAnalysisWAV(t: Toolchain, source: string, dest: string, sampleRate: number, signal?: AbortSignal): Promise<void> {
  if (sampleRate <= 0) throw new Error(`分析采样率必须为正，收到 ${sampleRate}`);
  await t.transcode(dest, ['-i', source, '-vn', '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le'], signal);
}

/**
 * 把音乐压低 6 dB，叠上每拍一声、重拍更高更响的咔嗒声，写成 WAV。
 *
 * 它只服务人工试听：节拍网格对不对，看数字判断不了，听一遍立刻知道。
 * 咔嗒声落在网格给的时刻上，所以「咔嗒与鼓点同时」就是网格正确的定义。
 * 整首解码进内存（约 0.77 MB/秒），按短视频配乐的长度设计，不面向小时级音频。
 */
export async function clickTrack(t: Toolchain, music: string, dest: string, beats: number[], downbeats: number[], signal?: AbortSignal): Promise<void> {
  const ffmpeg = t.ffmpegPath();
  const args = ['-v', 'error', '-nostdin', '-i', music, '-vn', '-ac', '2', '-ar', String(clickSampleRate), '-f', 's16le', '-acodec', 'pcm_s16le', '-'];
  const ran = await t.runAsync(ffmpeg, args, { signal, captureStdout: true, captureStderr: true });
  if (ran.error) throw new Error(`无法解码音乐：${music}（${commandError(ran)}）`);
  const pcm = ran.stdout;
  const frames = Math.floor(pcm.length / 4);
  const mix = new Float64Array(frames * 2);
  for (let i = 0; i < mix.length; i++) mix[i] = (pcm.readInt16LE(2 * i) / 32768) * clickMusicLevel;
  for (const b of beats) {
    let hz = clickBeatHz;
    let level = clickBeatLevel;
    if (nearAny(b, downbeats, clickMatchSeconds)) {
      hz = clickDownbeatHz;
      level = clickDownbeatLevel;
    }
    addClick(mix, goRound(b * clickSampleRate), hz, level);
  }
  writeWAV(dest, mix, clickSampleRate, 2);
}

function nearAny(value: number, sorted: number[], tolerance: number): boolean {
  return sorted.some((candidate) => Math.abs(candidate - value) <= tolerance);
}

function addClick(mix: Float64Array, start: number, hz: number, level: number): void {
  const length = Math.trunc(clickSeconds * clickSampleRate);
  for (let i = 0; i < length; i++) {
    const frame = start + i;
    if (frame < 0 || 2 * frame + 1 >= mix.length) continue;
    const t = i / clickSampleRate;
    const value = level * Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / (clickSeconds / 5));
    mix[2 * frame] += value;
    mix[2 * frame + 1] += value;
  }
}

/** 原子写出 16 位 PCM WAV。超出 ±0.9 的采样用 tanh 软限幅，不硬削波。 */
export function writeWAV(dest: string, samples: ArrayLike<number>, sampleRate: number, channels: number): void {
  const data = Buffer.alloc(44 + 2 * samples.length);
  data.write('RIFF', 0, 'latin1');
  data.writeUInt32LE((36 + 2 * samples.length) >>> 0, 4);
  data.write('WAVEfmt ', 8, 'latin1');
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(channels & 0xffff, 22);
  data.writeUInt32LE(sampleRate >>> 0, 24);
  data.writeUInt32LE((sampleRate * channels * 2) >>> 0, 28);
  data.writeUInt16LE((channels * 2) & 0xffff, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36, 'latin1');
  data.writeUInt32LE((2 * samples.length) >>> 0, 40);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (Math.abs(s) > 0.9) {
      const magnitude = 0.9 + 0.1 * Math.tanh((Math.abs(s) - 0.9) / 0.1);
      s = s < 0 || Object.is(s, -0) ? -magnitude : magnitude;
    }
    // Go 的 uint16(int16(x))：按 16 位截断。
    data.writeUInt16LE(goRound(s * 32767) & 0xffff, 44 + 2 * i);
  }
  atomicWrite(dest, data, 0o644);
}
