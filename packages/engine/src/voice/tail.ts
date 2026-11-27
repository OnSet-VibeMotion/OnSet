/**
 * 轻量级 PCM WAV 尾部硬断检测：仅读取文件尾窗，不依赖外部进程，也不误杀正常收尾。
 *
 * 用于在配音合成后识别「末段仍处于高能量语音、几乎没有尾静音就直接截断」的异常片段，
 * 只产出诊断信息与告警，不阻断或改写音频。
 */
import fs from 'node:fs';

export interface TailInspection {
  tailSilenceMs: number;
  tail50msDb: number;
  abrupt: boolean;
}

const SILENCE_THRESHOLD = 10 ** (-35 / 20);
const ABRUPT_MAX_SILENCE_MS = 5;
const ABRUPT_MIN_RMS_DB = -28;
const MIN_DURATION_SECONDS = 0.2;
const INSPECT_WINDOW_SECONDS = 0.5;
const TAIL_RMS_WINDOW_SECONDS = 0.05;

interface WavLayout {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

function parsePcmWavLayout(fd: number, fileSize: number): WavLayout | null {
  if (fileSize < 44) return null;
  const header = Buffer.alloc(12);
  if (fs.readSync(fd, header, 0, 12, 0) < 12) return null;
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;
  const chunkHeader = Buffer.alloc(8);

  while (offset + 8 <= fileSize) {
    if (fs.readSync(fd, chunkHeader, 0, 8, offset) < 8) break;
    const id = chunkHeader.toString('ascii', 0, 4);
    const size = chunkHeader.readUInt32LE(4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= fileSize) {
      const fmt = Buffer.alloc(16);
      fs.readSync(fd, fmt, 0, 16, body);
      audioFormat = fmt.readUInt16LE(0);
      channels = fmt.readUInt16LE(2);
      sampleRate = fmt.readUInt32LE(4);
      bitsPerSample = fmt.readUInt16LE(14);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, Math.max(0, fileSize - body));
      break;
    }
    const next = body + size + (size & 1);
    if (next <= offset) break;
    offset = next;
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || sampleRate < 1 || dataOffset < 0 || dataSize <= 0) {
    return null;
  }
  return { sampleRate, channels, bitsPerSample, dataOffset, dataSize };
}

/**
 * 检查 16-bit PCM WAV 末尾是否出现高能量硬截断。
 * excludeTailMs 可跳过已施加的极短防爆音淡出窗口。非 PCM WAV 返回 undefined。
 */
export function inspectWavTail(file: string, excludeTailMs = 0): TailInspection | undefined {
  let fd = -1;
  try {
    const stat = fs.statSync(file);
    fd = fs.openSync(file, 'r');
    const wav = parsePcmWavLayout(fd, stat.size);
    if (!wav) return undefined;

    const frameBytes = wav.channels * 2;
    const totalFrames = Math.floor(wav.dataSize / frameBytes);
    if (totalFrames / wav.sampleRate < MIN_DURATION_SECONDS) return undefined;

    const excludeFrames = Math.min(totalFrames, Math.max(0, Math.round((excludeTailMs / 1000) * wav.sampleRate)));
    const effectiveFrames = totalFrames - excludeFrames;
    const rmsFrames = Math.max(1, Math.round(TAIL_RMS_WINDOW_SECONDS * wav.sampleRate));
    if (effectiveFrames < rmsFrames) return undefined;

    const windowFrames = Math.min(
      effectiveFrames,
      Math.max(rmsFrames, Math.round(INSPECT_WINDOW_SECONDS * wav.sampleRate)),
    );
    const startFrame = effectiveFrames - windowFrames;
    const buf = Buffer.alloc(windowFrames * frameBytes);
    const read = fs.readSync(fd, buf, 0, buf.length, wav.dataOffset + startFrame * frameBytes);
    const framesRead = Math.floor(read / frameBytes);
    if (framesRead < rmsFrames) return undefined;

    let lastActive = -1;
    let rmsSum = 0;
    const rmsStart = framesRead - rmsFrames;
    for (let i = 0; i < framesRead; i++) {
      let peak = 0;
      let frameSq = 0;
      const base = i * frameBytes;
      for (let ch = 0; ch < wav.channels; ch++) {
        const v = buf.readInt16LE(base + ch * 2) / 32768;
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
        frameSq += v * v;
      }
      if (peak > SILENCE_THRESHOLD) lastActive = i;
      if (i >= rmsStart) rmsSum += frameSq / wav.channels;
    }

    const tailSilenceFrames = lastActive < 0 ? framesRead : framesRead - 1 - lastActive;
    const tailSilenceMs = Math.round(((tailSilenceFrames * 1000) / wav.sampleRate) * 10) / 10;
    const rms = Math.sqrt(rmsSum / rmsFrames);
    const tail50msDb = Math.max(-120, Math.round(20 * Math.log10(Math.max(rms, 1e-6)) * 10) / 10);
    const abrupt = tailSilenceMs <= ABRUPT_MAX_SILENCE_MS && tail50msDb > ABRUPT_MIN_RMS_DB;
    return { tailSilenceMs, tail50msDb, abrupt };
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}
