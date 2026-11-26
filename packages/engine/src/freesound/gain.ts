/**
 * 音效 RMS 增益建议与真峰值防削波夹取（safe_gain_db）：
 * - 对标准 PCM / IEEE Float WAV 文件直接用纯 TypeScript 解析采样，计算整段 RMS、
 *   样本峰值（dBFS）与 4× 过采样真峰值（dBTP），零外部依赖、100% 离线可测；
 * - 对 MP3 / OGG 等压缩音频统一经 @onset/engine/mediaprobe（loudness.ts）测量，
 *   不直接拼接 ffmpeg 命令；
 * - 任何情况下均保证 sample_peak_db + safe_gain_db ≤ ceiling_db（默认 -1.0 dBFS）
 *   且 true_peak_dbtp + safe_gain_db ≤ ceiling_db，触发夹取时附带明确削波警告说明。
 */
import fs from 'node:fs';
import { estimateTruePeakLinear } from '../baseassets';
import { formatFixed } from '../gofmt';
import { newToolchain, rmsToDB, SilenceFloorDB, type Toolchain } from '../mediaprobe';
import { type AudioGainAnalysis, DefaultPeakCeilingDB, DefaultTargetRmsDB } from './types';

export interface RawAudioMetrics {
  rms_db: number;
  sample_peak_db: number;
  true_peak_dbtp?: number;
  /** 若显式为 false，说明真峰值未能经 EBU R128 实测（仅回退到样本峰值）。 */
  true_peak_measured?: boolean;
}

export interface SafeGainOptions {
  /** 目标 RMS 电平（dBFS），默认 -16.0。 */
  targetRmsDb?: number;
  /** 峰值安全上限（dBFS / dBTP），默认 -1.0。 */
  ceilingDb?: number;
}

export interface AnalyzeAudioFileOptions extends SafeGainOptions {
  /** 若调用方已有内存缓冲可直接传入，避免重复读盘。 */
  buffer?: Buffer;
  /** 非 WAV 文件经 mediaprobe 测量时使用的 Toolchain。 */
  toolchain?: Toolchain;
  /** 构造默认 Toolchain 时使用的环境变量。 */
  env?: Record<string, string>;
}

export interface DecodedWavPcm {
  sampleRate: number;
  channels: Float64Array[];
  bitDepth: number;
  durationSeconds: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const floor2 = (value: number): number => Math.floor(value * 100 + 1e-9) / 100;

/**
 * 判断缓冲是否为 RIFF WAVE 容器。
 */
export function isWavBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

/**
 * 纯 TypeScript 解析 RIFF/WAVE 音频（支持 8/16/24/32-bit Linear PCM 与 32-bit IEEE Float），
 * 返回归一化到 [-1, 1] 的多声道浮点采样数组。
 */
export function parseWavPcm(buf: Buffer): DecodedWavPcm {
  if (!isWavBuffer(buf)) throw new Error('不是合法的 RIFF/WAVE 文件');

  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataStart = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = Math.min(buf.length, bodyStart + chunkSize);

    if (chunkId === 'fmt ' && bodyStart + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(bodyStart);
      numChannels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      bitDepth = buf.readUInt16LE(bodyStart + 14);
      // WAVE_FORMAT_EXTENSIBLE (0xFFFE)：读取 SubFormat GUID 前 2 字节（1=PCM, 3=Float）
      if (audioFormat === 0xfffe && chunkSize >= 40 && bodyStart + 26 <= buf.length) {
        audioFormat = buf.readUInt16LE(bodyStart + 24);
      }
    } else if (chunkId === 'data') {
      dataStart = bodyStart;
      dataSize = bodyEnd - bodyStart;
      break;
    }

    // RIFF 块长度按偶数字节对齐
    offset = bodyStart + chunkSize + (chunkSize & 1);
  }

  if (numChannels < 1 || sampleRate < 1 || dataStart < 0) {
    throw new Error('WAV 缺少有效的 fmt 或 data 块');
  }
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`暂不支持的 WAV 编码格式（audioFormat=${audioFormat}）`);
  }
  const bytesPerSample = bitDepth / 8;
  if (
    !Number.isInteger(bytesPerSample) ||
    (audioFormat === 1 && ![1, 2, 3, 4].includes(bytesPerSample)) ||
    (audioFormat === 3 && bytesPerSample !== 4)
  ) {
    throw new Error(`不支持的 WAV 位深：format=${audioFormat} bitDepth=${bitDepth}`);
  }

  const blockAlign = numChannels * bytesPerSample;
  const frames = Math.floor(dataSize / blockAlign);
  const channels = Array.from({ length: numChannels }, () => new Float64Array(frames));

  let pos = dataStart;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let sample = 0;
      if (audioFormat === 3) {
        sample = buf.readFloatLE(pos);
      } else if (bytesPerSample === 1) {
        sample = (buf.readUInt8(pos) - 128) / 128;
      } else if (bytesPerSample === 2) {
        sample = buf.readInt16LE(pos) / 32768;
      } else if (bytesPerSample === 3) {
        const b0 = buf[pos];
        const b1 = buf[pos + 1];
        const b2 = buf[pos + 2];
        let val = b0 | (b1 << 8) | (b2 << 16);
        if (val & 0x800000) val |= ~0xffffff;
        sample = val / 8388608;
      } else {
        sample = buf.readInt32LE(pos) / 2147483648;
      }
      channels[c][i] = Number.isFinite(sample) ? sample : 0;
      pos += bytesPerSample;
    }
  }

  return {
    sampleRate,
    channels,
    bitDepth,
    durationSeconds: frames / sampleRate,
  };
}

/**
 * 基于实测 RMS、样本峰值与真峰值，计算拉到目标 RMS 的建议增益及经真峰值夹取后的安全建议增益。
 * 保证非静音素材严格满足 sample_peak_db + safe_gain_db ≤ ceiling_db 且 true_peak_dbtp + safe_gain_db ≤ ceiling_db。
 */
export function computeSafeGain(
  metrics: RawAudioMetrics,
  opts: SafeGainOptions = {},
  method: AudioGainAnalysis['method'] = 'wav-pcm',
): AudioGainAnalysis {
  const targetRmsDb = opts.targetRmsDb ?? DefaultTargetRmsDB;
  const ceilingDb = opts.ceilingDb ?? DefaultPeakCeilingDB;
  const rmsDb = Math.max(SilenceFloorDB, metrics.rms_db);
  const samplePeakDb = Math.max(SilenceFloorDB, metrics.sample_peak_db);
  const truePeakMeasured = metrics.true_peak_measured !== false;
  const truePeakDb = Math.max(samplePeakDb, metrics.true_peak_dbtp ?? samplePeakDb);
  const unmeasuredNote = truePeakMeasured
    ? undefined
    : '真峰值未能经 EBU R128 实测（回退至样本峰值），不保证满足压缩音频采样间真峰上限。';

  // 全静音或近底噪素材不建议大幅拉升
  if (rmsDb <= SilenceFloorDB + 1 || samplePeakDb <= SilenceFloorDB + 1) {
    return {
      measured: truePeakMeasured,
      true_peak_measured: truePeakMeasured,
      method,
      rms_db: round2(rmsDb),
      target_rms_db: round2(targetRmsDb),
      suggested_gain_db: 0,
      sample_peak_db: round2(samplePeakDb),
      true_peak_dbtp: round2(truePeakDb),
      ceiling_db: round2(ceilingDb),
      safe_gain_db: 0,
      projected_peak_db: round2(truePeakDb),
      clamped: false,
      note: unmeasuredNote ?? '音频接近全静音，建议保持 0 dB 增益。',
    };
  }

  const rawSuggested = targetRmsDb - rmsDb;
  const suggestedGainDb = round2(rawSuggested);
  const governingPeak = Math.max(samplePeakDb, truePeakDb);
  // 向下取两位小数，保证 governingPeak + safeGainDb 严格不超过 ceilingDb
  const maxSafeGain = floor2(ceilingDb - governingPeak);

  if (rawSuggested > maxSafeGain) {
    const safeGainDb = maxSafeGain;
    const rawProjectedPeak = round2(governingPeak + suggestedGainDb);
    const projectedPeakDb = round2(governingPeak + safeGainDb);
    const clippingWarning =
      `削波防护已触发：按目标 RMS（${formatFixed(targetRmsDb, 1)} dBFS）原建议增益 ${formatFixed(suggestedGainDb, 2)} dB ` +
      `会把峰值（样本 ${formatFixed(samplePeakDb, 2)} dBFS / 真峰 ${formatFixed(truePeakDb, 2)} dBTP）推高至 ` +
      `${formatFixed(rawProjectedPeak, 2)} dBFS，超出 ${formatFixed(ceilingDb, 1)} dBFS 上限并引发削波；` +
      `已自动夹取安全增益至 ${formatFixed(safeGainDb, 2)} dB（夹取后峰值 ${formatFixed(projectedPeakDb, 2)} dBFS）。`;

    return {
      measured: truePeakMeasured,
      true_peak_measured: truePeakMeasured,
      method,
      rms_db: round2(rmsDb),
      target_rms_db: round2(targetRmsDb),
      suggested_gain_db: suggestedGainDb,
      sample_peak_db: round2(samplePeakDb),
      true_peak_dbtp: round2(truePeakDb),
      ceiling_db: round2(ceilingDb),
      safe_gain_db: safeGainDb,
      projected_peak_db: projectedPeakDb,
      clamped: true,
      clipping_warning: clippingWarning,
      ...(unmeasuredNote ? { note: unmeasuredNote } : {}),
    };
  }

  const safeGainDb = suggestedGainDb;
  return {
    measured: truePeakMeasured,
    true_peak_measured: truePeakMeasured,
    method,
    rms_db: round2(rmsDb),
    target_rms_db: round2(targetRmsDb),
    suggested_gain_db: suggestedGainDb,
    sample_peak_db: round2(samplePeakDb),
    true_peak_dbtp: round2(truePeakDb),
    ceiling_db: round2(ceilingDb),
    safe_gain_db: safeGainDb,
    projected_peak_db: round2(governingPeak + safeGainDb),
    clamped: false,
    ...(unmeasuredNote ? { note: unmeasuredNote } : {}),
  };
}

/** 纯 TypeScript 测量 WAV 缓冲并产出带真峰值防削波的安全建议增益。 */
export function analyzeWavBuffer(buf: Buffer, opts: SafeGainOptions = {}): AudioGainAnalysis {
  const decoded = parseWavPcm(buf);
  let sumSq = 0;
  let maxAbs = 0;
  let totalSamples = 0;
  for (const ch of decoded.channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const abs = Math.abs(v);
      if (abs > maxAbs) maxAbs = abs;
      sumSq += v * v;
    }
    totalSamples += ch.length;
  }
  const rmsDb = totalSamples > 0 ? rmsToDB(Math.sqrt(sumSq / totalSamples)) : SilenceFloorDB;
  const samplePeakDb = rmsToDB(maxAbs);
  const truePeakDb = rmsToDB(estimateTruePeakLinear(decoded.channels));
  return computeSafeGain({ rms_db: rmsDb, sample_peak_db: samplePeakDb, true_peak_dbtp: truePeakDb }, opts, 'wav-pcm');
}

/**
 * 测量本地音频文件的 RMS、峰值与安全建议增益：
 * - WAV 文件走零依赖纯 TS 解码；
 * - MP3 / OGG 等压缩格式经 @onset/engine/mediaprobe 测量（FFmpeg 不可用时优雅退化为 unavailable）。
 */
export function analyzeAudioFile(filePath: string, opts: AnalyzeAudioFileOptions = {}): AudioGainAnalysis {
  const buf = opts.buffer ?? fs.readFileSync(filePath);
  if (isWavBuffer(buf)) {
    try {
      return analyzeWavBuffer(buf, opts);
    } catch {
      // 非常规压缩 WAV 退回 mediaprobe 解码
    }
  }

  try {
    const toolchain = opts.toolchain ?? newToolchain(opts.env ?? (process.env as Record<string, string>));
    const levels = toolchain.measureAudioLevels(filePath);
    return computeSafeGain(levels, opts, 'mediaprobe-ffmpeg');
  } catch (err) {
    const targetRmsDb = opts.targetRmsDb ?? DefaultTargetRmsDB;
    const ceilingDb = opts.ceilingDb ?? DefaultPeakCeilingDB;
    return {
      measured: false,
      method: 'unavailable',
      rms_db: SilenceFloorDB,
      target_rms_db: round2(targetRmsDb),
      suggested_gain_db: 0,
      sample_peak_db: SilenceFloorDB,
      true_peak_dbtp: SilenceFloorDB,
      ceiling_db: round2(ceilingDb),
      safe_gain_db: 0,
      projected_peak_db: SilenceFloorDB,
      clamped: false,
      note: `未能测量非 WAV 音频响度（需要可用的 ffmpeg/ffprobe）：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
