/**
 * 程序化零版权（MIT）基础转场音效合成器：
 * - whoosh.wav：48kHz 16-bit 立体声丝滑扫风过渡音效
 * - impact.wav：48kHz 16-bit 立体声干净低频落点冲击音效
 *
 * 工程质量保证：
 * - 固定种子确定性伪随机，重复生成 SHA-256 逐字节一致；
 * - 去除每声道直流偏移（DC offset）；
 * - 首尾余弦（Hann）平滑淡入淡出，首末采样精确归零，零爆音；
 * - 4× 加窗 Sinc 过采样真峰值限幅至 ≤ -1.5 dBTP（严格满足 ≤ -1.0 dBTP 与 ≤ -1.0 dBFS）。
 */
import { formatFixed, goRound } from '../gofmt';
import { rmsToDB, SilenceFloorDB } from '../mediaprobe';

export const BaseSfxSampleRate = 48_000;
export const BaseSfxChannels = 2;
export const BaseSfxBitDepth = 16;
export const BaseSfxTargetTruePeakDB = -1.5;
export const BaseSfxMaxTruePeakDB = -1.0;

export interface SfxAudioMetrics {
  sample_rate: number;
  channels: number;
  bit_depth: number;
  duration_seconds: number;
  rms_db: number;
  sample_peak_db: number;
  true_peak_dbtp: number;
  dc_offset: number;
}

export interface BuiltinSfxSpec {
  readonly id: 'whoosh' | 'impact';
  readonly fileName: string;
  readonly description: string;
  readonly generate: () => Buffer;
}

/** 固定种子的 Mulberry32 确定性 PRNG，输出 [0, 1)。 */
function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n: number): number => Number(formatFixed(n, 2));
const round4 = (n: number): number => Number(formatFixed(n, 4));

/** 去除每个声道的直流偏移。 */
export function removeDcOffset(channels: readonly Float64Array[]): void {
  for (const ch of channels) {
    if (ch.length === 0) continue;
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i];
    const mean = sum / ch.length;
    for (let i = 0; i < ch.length; i++) ch[i] -= mean;
  }
}

/** 施加首尾半余弦（Hann）淡入淡出窗，确保首末采样归零无点击爆音。 */
export function applyFadeEnvelope(
  channels: readonly Float64Array[],
  fadeInSamples: number,
  fadeOutSamples: number,
): void {
  for (const ch of channels) {
    const n = ch.length;
    if (n === 0) continue;
    const fIn = Math.min(Math.max(0, Math.floor(fadeInSamples)), n);
    const fOut = Math.min(Math.max(0, Math.floor(fadeOutSamples)), n);
    for (let i = 0; i < fIn; i++) {
      const gain = fIn <= 1 ? 0 : 0.5 * (1 - Math.cos((Math.PI * i) / (fIn - 1)));
      ch[i] *= gain;
    }
    for (let i = 0; i < fOut; i++) {
      const idx = n - 1 - i;
      const gain = fOut <= 1 ? 0 : 0.5 * (1 - Math.cos((Math.PI * i) / (fOut - 1)));
      ch[idx] *= gain;
    }
    ch[0] = 0;
    ch[n - 1] = 0;
  }
}

/** 预计算 4× 过采样 Hann 加窗 Sinc 插值核（3 个子相位：0.25 / 0.50 / 0.75，半宽 6 抽头）。 */
const SincHalfWidth = 6;
const SincKernels: readonly Float64Array[] = [0.25, 0.5, 0.75].map((frac) => {
  const taps = SincHalfWidth * 2;
  const kernel = new Float64Array(taps);
  let sum = 0;
  for (let j = 0; j < taps; j++) {
    const k = j - (SincHalfWidth - 1);
    const x = frac - k;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const win = 0.5 * (1 + Math.cos((Math.PI * x) / SincHalfWidth));
    kernel[j] = sinc * win;
    sum += kernel[j];
  }
  for (let j = 0; j < taps; j++) kernel[j] /= sum;
  return kernel;
});

/**
 * 估算多声道音频的 4× 过采样真峰值线性幅度（符合 ITU-R BS.1770 思路，恒不低于样本峰值）。
 */
export function estimateTruePeakLinear(channels: readonly Float64Array[]): number {
  let maxPeak = 0;
  for (const ch of channels) {
    const n = ch.length;
    for (let i = 0; i < n; i++) {
      const s = Math.abs(ch[i]);
      if (s > maxPeak) maxPeak = s;
    }
    if (n < 2) continue;
    for (let i = 0; i < n - 1; i++) {
      for (let p = 0; p < SincKernels.length; p++) {
        const kernel = SincKernels[p];
        let acc = 0;
        for (let j = 0; j < kernel.length; j++) {
          const idx = i + j - (SincHalfWidth - 1);
          if (idx >= 0 && idx < n) acc += ch[idx] * kernel[j];
        }
        const absAcc = Math.abs(acc);
        if (absAcc > maxPeak) maxPeak = absAcc;
      }
    }
  }
  return maxPeak;
}

/** 归一化多声道波形，使 4× 过采样真峰值严格不超过 targetPeakDb。 */
export function normalizeToTruePeakCeiling(channels: readonly Float64Array[], targetPeakDb: number): void {
  const peak = estimateTruePeakLinear(channels);
  if (peak <= 0) return;
  const targetLinear = 10 ** (targetPeakDb / 20);
  const scale = targetLinear / peak;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= scale;
  }
}

/** 将多声道浮点采样编码为标准 44 字节头 PCM 16-bit 小端 WAV 缓冲。 */
export function encodeWavPcm16(channels: readonly Float64Array[], sampleRate: number): Buffer {
  const numChannels = channels.length;
  if (numChannels < 1) throw new Error('编码 WAV 至少需要 1 个声道');
  const numFrames = channels[0].length;
  for (let c = 1; c < numChannels; c++) {
    if (channels[c].length !== numFrames) throw new Error('各声道采样长度必须一致');
  }
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = numFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 4, 'ascii');
  buf.write('fmt ', 12, 4, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk length
  buf.writeUInt16LE(1, 20); // AudioFormat = 1 (Linear PCM)
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 4, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const clamped = Math.max(-1, Math.min(1, channels[c][i]));
      const quantized = Math.max(-32767, Math.min(32767, goRound(clamped * 32767)));
      buf.writeInt16LE(quantized, offset);
      offset += 2;
    }
  }
  return buf;
}

/** 测量 16-bit PCM WAV 缓冲的实测规格、RMS、样本峰值、4× 真峰值与直流偏移（按 RIFF 块定位 fmt 与 data）。 */
export function measurePcm16Metrics(wav: Buffer): SfxAudioMetrics {
  if (
    wav.length < 12 ||
    wav.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    wav.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    throw new Error('无效的 WAV 文件头');
  }
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let hasFmt = false;
  let dataStart = -1;
  let dataBytes = 0;
  for (let pos = 12; pos + 8 <= wav.length; ) {
    const id = wav.subarray(pos, pos + 4).toString('ascii');
    const size = wav.readUInt32LE(pos + 4);
    const bodyStart = pos + 8;
    const bodyEnd = Math.min(wav.length, bodyStart + size);
    if (id === 'fmt ' && bodyEnd - bodyStart >= 16) {
      audioFormat = wav.readUInt16LE(bodyStart);
      numChannels = wav.readUInt16LE(bodyStart + 2);
      sampleRate = wav.readUInt32LE(bodyStart + 4);
      bitDepth = wav.readUInt16LE(bodyStart + 14);
      hasFmt = true;
    } else if (id === 'data') {
      dataStart = bodyStart;
      dataBytes = bodyEnd - bodyStart;
      break;
    }
    pos = bodyStart + size + (size & 1);
  }
  if (!hasFmt || dataStart < 0) throw new Error('WAV 缺少 fmt 或 data 块');
  if (audioFormat !== 1 || bitDepth !== 16 || numChannels < 1 || sampleRate < 1) {
    throw new Error(`仅支持 16-bit Linear PCM WAV，收到 format=${audioFormat} bitDepth=${bitDepth}`);
  }
  const frames = Math.floor(dataBytes / (numChannels * 2));
  const channels = Array.from({ length: numChannels }, () => new Float64Array(frames));
  const dcSums = new Float64Array(numChannels);
  let sumSq = 0;
  let maxAbs = 0;
  let offset = dataStart;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = wav.readInt16LE(offset) / 32768;
      offset += 2;
      channels[c][i] = v;
      dcSums[c] += v;
      sumSq += v * v;
      const abs = Math.abs(v);
      if (abs > maxAbs) maxAbs = abs;
    }
  }
  let maxChannelDc = 0;
  for (let c = 0; c < numChannels; c++) {
    const dc = frames > 0 ? Math.abs(dcSums[c] / frames) : 0;
    if (dc > maxChannelDc) maxChannelDc = dc;
  }
  const totalSamples = frames * numChannels;
  const rmsDb = totalSamples > 0 ? rmsToDB(Math.sqrt(sumSq / totalSamples)) : SilenceFloorDB;
  const samplePeakDb = rmsToDB(maxAbs);
  const truePeakDb = rmsToDB(estimateTruePeakLinear(channels));

  return {
    sample_rate: sampleRate,
    channels: numChannels,
    bit_depth: bitDepth,
    duration_seconds: round4(frames / sampleRate),
    rms_db: round2(rmsDb),
    sample_peak_db: round2(samplePeakDb),
    true_peak_dbtp: round2(Math.max(samplePeakDb, truePeakDb)),
    dc_offset: round4(maxChannelDc),
  };
}

/** 合成丝滑扫风过渡音效（whoosh.wav，0.75s，48kHz 16-bit 立体声，双路扫频带通 + 空气声底）。 */
export function generateWhooshWav(): Buffer {
  const sr = BaseSfxSampleRate;
  const frames = goRound(sr * 0.75);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  const randL = createPrng(0x57484f31);
  const randR = createPrng(0x57484f32);
  // 两路独立带通状态（biquad direct form I）与空气高频层高通状态
  const st = new Float64Array(10); // lx1, lx2, ly1, ly2, rx1, rx2, ry1, ry2, lAirPrev, rAirPrev

  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1);
    const bell = Math.sin(Math.PI * t ** 0.78) ** 1.65;
    const sweep = Math.sin(Math.PI * t ** 0.82);
    const freq = 220 + 2080 * sweep ** 1.35 + 140 * t;
    const w0 = (2 * Math.PI * freq) / sr;
    const alpha = Math.sin(w0) / (2 * 1.65);
    const invA0 = 1 / (1 + alpha);
    const b0 = alpha * invA0;
    const b2 = -alpha * invA0;
    const a1 = -2 * Math.cos(w0) * invA0;
    const a2 = (1 - alpha) * invA0;

    const nL = randL() + randL() - 1;
    const nR = randR() + randR() - 1;
    const bpL = b0 * nL + b2 * st[1] - a1 * st[2] - a2 * st[3];
    st[1] = st[0];
    st[0] = nL;
    st[3] = st[2];
    st[2] = bpL;
    const bpR = b0 * nR + b2 * st[5] - a1 * st[6] - a2 * st[7];
    st[5] = st[4];
    st[4] = nR;
    st[7] = st[6];
    st[6] = bpR;

    const airL = nL - st[8];
    st[8] = nL;
    const airR = nR - st[9];
    st[9] = nR;

    const panAngle = (0.36 + 0.28 * t) * (Math.PI / 2);
    left[i] = (bpL * 0.88 + airL * 0.05) * bell * Math.cos(panAngle);
    right[i] = (bpR * 0.88 + airR * 0.05) * bell * Math.sin(panAngle);
  }

  const channels = [left, right];
  removeDcOffset(channels);
  applyFadeEnvelope(channels, goRound(sr * 0.025), goRound(sr * 0.05));
  normalizeToTruePeakCeiling(channels, BaseSfxTargetTruePeakDB);
  return encodeWavPcm16(channels, sr);
}

/** 合成干净低频落点冲击音效（impact.wav，0.65s，48kHz 16-bit 立体声，165Hz→46Hz 下潜 + 短瞬态纹理）。 */
export function generateImpactWav(): Buffer {
  const sr = BaseSfxSampleRate;
  const frames = goRound(sr * 0.65);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  const randL = createPrng(0x494d5031);
  const randR = createPrng(0x494d5032);
  let phase = 0;
  let phase2 = 0;
  let lpL = 0;
  let lpR = 0;

  for (let i = 0; i < frames; i++) {
    const sec = i / sr;
    const freq = 46 + 119 * Math.exp(-sec * 24);
    phase += (2 * Math.PI * freq) / sr;
    phase2 += (2 * Math.PI * (freq * 1.98)) / sr;
    const warmSub = Math.tanh(
      (Math.sin(phase) * Math.exp(-sec * 6.2) * 0.92 + Math.sin(phase2) * Math.exp(-sec * 28) * 0.22) * 1.15,
    );
    lpL += 0.16 * (randL() * 2 - 1 - lpL);
    lpR += 0.16 * (randR() * 2 - 1 - lpR);
    const stereoAir = 0.24 * Math.exp(-sec * 52);
    left[i] = warmSub + lpL * stereoAir;
    right[i] = warmSub + lpR * stereoAir;
  }

  const channels = [left, right];
  removeDcOffset(channels);
  applyFadeEnvelope(channels, goRound(sr * 0.0025), goRound(sr * 0.05));
  normalizeToTruePeakCeiling(channels, BaseSfxTargetTruePeakDB);
  return encodeWavPcm16(channels, sr);
}

export const BuiltinSfxSpecs: readonly BuiltinSfxSpec[] = [
  {
    id: 'whoosh',
    fileName: 'whoosh.wav',
    description: '丝滑扫风过渡音效（48kHz 16-bit 立体声，适合转场、字幕滑入与视觉切换）',
    generate: generateWhooshWav,
  },
  {
    id: 'impact',
    fileName: 'impact.wav',
    description: '干净低频落点冲击音效（48kHz 16-bit 立体声，适合数据大字、标题定格与要点强调）',
    generate: generateImpactWav,
  },
];
