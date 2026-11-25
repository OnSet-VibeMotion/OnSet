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

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

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
      const quantized = Math.max(-32767, Math.min(32767, Math.round(clamped * 32767)));
      buf.writeInt16LE(quantized, offset);
      offset += 2;
    }
  }
  return buf;
}

/** 测量 16-bit PCM WAV 缓冲的实测规格、RMS、样本峰值、4× 真峰值与直流偏移。 */
export function measurePcm16Metrics(wav: Buffer): SfxAudioMetrics {
  if (
    wav.length < 44 ||
    wav.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    wav.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    throw new Error('无效的 WAV 文件头');
  }
  const audioFormat = wav.readUInt16LE(20);
  const numChannels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bitDepth = wav.readUInt16LE(34);
  const dataBytes = wav.readUInt32LE(40);
  if (audioFormat !== 1 || bitDepth !== 16 || numChannels < 1) {
    throw new Error(`仅支持 16-bit Linear PCM WAV，收到 format=${audioFormat} bitDepth=${bitDepth}`);
  }
  const frames = Math.floor(Math.min(dataBytes, wav.length - 44) / (numChannels * 2));
  const channels = Array.from({ length: numChannels }, () => new Float64Array(frames));
  let sumSq = 0;
  let maxAbs = 0;
  let maxChannelDc = 0;
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = wav.readInt16LE(offset) / 32768;
      offset += 2;
      channels[c][i] = v;
      sumSq += v * v;
      const abs = Math.abs(v);
      if (abs > maxAbs) maxAbs = abs;
    }
  }
  for (let c = 0; c < numChannels; c++) {
    let dcSum = 0;
    for (let i = 0; i < frames; i++) dcSum += channels[c][i];
    const dc = frames > 0 ? Math.abs(dcSum / frames) : 0;
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

/**
 * 合成丝滑扫风过渡音效（whoosh.wav，0.75s，48kHz 16-bit 立体声）：
 * 确定性双路白噪经频率钟形扫频二阶带通滤波器（220Hz → 2300Hz → 360Hz）+ 轻柔空气声底，
 * 辅以从左至右的微立体声声像移动，干净通透、无直流偏移、无爆音。
 */
export function generateWhooshWav(): Buffer {
  const sr = BaseSfxSampleRate;
  const duration = 0.75;
  const frames = Math.round(sr * duration);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  const randL = createPrng(0x57484f31);
  const randR = createPrng(0x57484f32);

  // 两路独立带通状态（biquad direct form I）
  let lx1 = 0;
  let lx2 = 0;
  let ly1 = 0;
  let ly2 = 0;
  let rx1 = 0;
  let rx2 = 0;
  let ry1 = 0;
  let ry2 = 0;
  // 空气高频层单极点高通状态
  let lAirPrev = 0;
  let rAirPrev = 0;

  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1);
    // 钟形幅度包络：在 t ≈ 0.42 达到峰值后丝滑回落
    const bell = Math.sin(Math.PI * t ** 0.78) ** 1.65;
    // 带通中心频率扫频：220Hz -> 2300Hz -> 360Hz
    const sweep = Math.sin(Math.PI * t ** 0.82);
    const freq = 220 + 2080 * sweep ** 1.35 + 140 * t;
    const q = 1.65;

    const w0 = (2 * Math.PI * freq) / sr;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const invA0 = 1 / (1 + alpha);
    const b0 = alpha * invA0;
    const b2 = -alpha * invA0;
    const a1 = -2 * cosW0 * invA0;
    const a2 = (1 - alpha) * invA0;

    // 柔和三角分布噪点（减少刺耳高频毛刺）
    const nL = randL() + randL() - 1;
    const nR = randR() + randR() - 1;
    const bpL = b0 * nL + b2 * lx2 - a1 * ly1 - a2 * ly2;
    lx2 = lx1;
    lx1 = nL;
    ly2 = ly1;
    ly1 = bpL;

    const bpR = b0 * nR + b2 * rx2 - a1 * ry1 - a2 * ry2;
    rx2 = rx1;
    rx1 = nR;
    ry2 = ry1;
    ry1 = bpR;

    const airL = nL - lAirPrev;
    lAirPrev = nL;
    const airR = nR - rAirPrev;
    rAirPrev = nR;

    // 轻度左→右立体声声像摆动（保持高单声道兼容性）
    const panAngle = (0.36 + 0.28 * t) * (Math.PI / 2);
    const panL = Math.cos(panAngle);
    const panR = Math.sin(panAngle);

    left[i] = (bpL * 0.88 + airL * 0.05) * bell * panL;
    right[i] = (bpR * 0.88 + airR * 0.05) * bell * panR;
  }

  const channels = [left, right];
  removeDcOffset(channels);
  applyFadeEnvelope(channels, Math.round(sr * 0.025), Math.round(sr * 0.05));
  normalizeToTruePeakCeiling(channels, BaseSfxTargetTruePeakDB);
  return encodeWavPcm16(channels, sr);
}

/**
 * 合成干净低频落点冲击音效（impact.wav，0.65s，48kHz 16-bit 立体声）：
 * 指数下潜低频正弦核（165Hz → 46Hz）+ 二次谐波暖度 + 极短低通瞬态击打纹理，
 * 2.5ms 平滑起音与 50ms 自然收尾，无削波、无直流偏移、无点击声。
 */
export function generateImpactWav(): Buffer {
  const sr = BaseSfxSampleRate;
  const duration = 0.65;
  const frames = Math.round(sr * duration);
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
    // 主低频下潜：165Hz 迅速落至 46Hz
    const freq = 46 + 119 * Math.exp(-sec * 24);
    phase += (2 * Math.PI * freq) / sr;
    phase2 += (2 * Math.PI * (freq * 1.98)) / sr;

    // 主体衰减包络 + 微饱和暖感
    const subEnv = Math.exp(-sec * 6.2);
    const punchEnv = Math.exp(-sec * 28);
    const rawSub = Math.sin(phase) * subEnv * 0.92 + Math.sin(phase2) * punchEnv * 0.22;
    const warmSub = Math.tanh(rawSub * 1.15);

    // 极短受控瞬态低通冲击（增加落点质感，避免高频尖刺）
    const transEnv = Math.exp(-sec * 52);
    const alpha = 0.16;
    lpL += alpha * (randL() * 2 - 1 - lpL);
    lpR += alpha * (randR() * 2 - 1 - lpR);

    const stereoAir = 0.24 * transEnv;
    left[i] = warmSub + lpL * stereoAir;
    right[i] = warmSub + lpR * stereoAir;
  }

  const channels = [left, right];
  removeDcOffset(channels);
  applyFadeEnvelope(channels, Math.round(sr * 0.0025), Math.round(sr * 0.05));
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
