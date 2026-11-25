// 成片音画回测的纯信号处理模块：FFT 归一化互相关（ZNCC）、SFX 能量峰定位、ROI 画面变化/亮度峰检测与偏移统计。
import { goRound } from './gofmt';
import { meanAbsoluteDifference } from './mediaprobe';

export const DefaultAudioSampleRate = 16_000;
export const DefaultTemplateHalfSeconds = 0.12;
export const DefaultAudioSearchWindowSeconds = 0.25;
export const DefaultMinAudioCorrelation = 0.35;
export const DefaultMinVisualDelta = 4.0;
export const DefaultMaxOffsetSpreadSeconds = 0.015;
export const DefaultMinReliableMatchesForOffset = 3;

export function round4(value: number): number {
  return goRound(value * 10_000) / 10_000;
}

export function round2(value: number): number {
  return goRound(value * 100) / 100;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** 原地基-2 Cooley-Tukey FFT（inverse=true 时执行逆变换并除以 N）。 */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (sign * 2 * Math.PI) / len;
    const wLenRe = Math.cos(angle);
    const wLenIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export interface AudioMatchResult {
  verified: boolean;
  actual_seconds?: number;
  offset_seconds?: number;
  correlation: number;
  reason?: string;
}

export interface AudioMatchOptions {
  sampleRate: number;
  nominalSeconds: number;
  expectedTargetSeconds?: number;
  templateHalfSeconds?: number;
  searchWindowSeconds?: number;
  minCorrelation?: number;
}

/**
 * 在 target 音频中围绕 expectedTargetSeconds（默认同 nominalSeconds）搜索与源音频
 * source 在 nominalSeconds 附近波形最匹配的局部位置（零均值归一化互相关 ZNCC）。
 */
export function matchAudioTemplate(
  source: Float32Array,
  target: Float32Array,
  opts: AudioMatchOptions,
): AudioMatchResult {
  const { sampleRate, nominalSeconds } = opts;
  const expectedTargetSeconds = opts.expectedTargetSeconds ?? nominalSeconds;
  const halfSamples = Math.max(16, Math.round((opts.templateHalfSeconds ?? DefaultTemplateHalfSeconds) * sampleRate));
  const maxLagSamples = Math.max(
    16,
    Math.round((opts.searchWindowSeconds ?? DefaultAudioSearchWindowSeconds) * sampleRate),
  );
  const minCorrelation = opts.minCorrelation ?? DefaultMinAudioCorrelation;

  const nominalSample = Math.round(nominalSeconds * sampleRate);
  const t0 = Math.max(0, nominalSample - halfSamples);
  const t1 = Math.min(source.length, nominalSample + halfSamples);
  const m = t1 - t0;
  if (m < 32) {
    return { verified: false, correlation: 0, reason: '源音频瞬态附近可用样本不足' };
  }
  const anchorOffsetInTemplate = nominalSample - t0;

  let sumX = 0;
  for (let i = 0; i < m; i++) sumX += source[t0 + i];
  const meanX = sumX / m;
  const x = new Float64Array(m);
  let normX2 = 0;
  for (let i = 0; i < m; i++) {
    const v = source[t0 + i] - meanX;
    x[i] = v;
    normX2 += v * v;
  }
  if (Math.sqrt(normX2 / m) < 1e-4) {
    return { verified: false, correlation: 0, reason: '源音频锚点附近能量过低（近似静音）' };
  }

  const expectedStart = Math.round(expectedTargetSeconds * sampleRate) - anchorOffsetInTemplate;
  const searchStart = Math.max(0, expectedStart - maxLagSamples);
  const searchEnd = Math.min(target.length, expectedStart + m + maxLagSamples);
  const len = searchEnd - searchStart;
  if (len < m) {
    return { verified: false, correlation: 0, reason: '成片音轨搜索窗口样本不足' };
  }

  const n = nextPow2(len + m);
  const xRe = new Float64Array(n);
  const xIm = new Float64Array(n);
  const yRe = new Float64Array(n);
  const yIm = new Float64Array(n);
  for (let i = 0; i < m; i++) xRe[i] = x[i];
  for (let i = 0; i < len; i++) yRe[i] = target[searchStart + i];

  fft(xRe, xIm, false);
  fft(yRe, yIm, false);
  // Z[k] = Y[k] * conj(X[k]) -> IFFT(Z)[d] = sum_{i=0}^{m-1} x[i] * y[d + i]
  for (let k = 0; k < n; k++) {
    const yr = yRe[k];
    const yi = yIm[k];
    const xr = xRe[k];
    const xi = -xIm[k];
    yRe[k] = yr * xr - yi * xi;
    yIm[k] = yr * xi + yi * xr;
  }
  fft(yRe, yIm, true);

  const s1 = new Float64Array(len + 1);
  const s2 = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) {
    const v = target[searchStart + i];
    s1[i + 1] = s1[i] + v;
    s2[i + 1] = s2[i] + v * v;
  }

  const numLags = len - m + 1;
  const zncc = new Float64Array(numLags);
  let bestD = 0;
  let bestCorr = -Infinity;
  for (let d = 0; d < numLags; d++) {
    const sumY = s1[d + m] - s1[d];
    const sumY2 = s2[d + m] - s2[d];
    const varY = sumY2 - (sumY * sumY) / m;
    const c = varY > 1e-10 ? yRe[d] / Math.sqrt(normX2 * varY) : 0;
    zncc[d] = c;
    if (c > bestCorr) {
      bestCorr = c;
      bestD = d;
    }
  }

  if (!Number.isFinite(bestCorr) || bestCorr < minCorrelation) {
    return {
      verified: false,
      correlation: round4(Math.max(0, Number.isFinite(bestCorr) ? bestCorr : 0)),
      reason: `音频互相关过低（${round4(Math.max(0, bestCorr))} < ${minCorrelation}）`,
    };
  }

  const excludeRadius = Math.round(0.03 * sampleRate);
  let secondBest = -Infinity;
  for (let d = 0; d < numLags; d++) {
    if (Math.abs(d - bestD) <= excludeRadius) continue;
    if (zncc[d] > secondBest) secondBest = zncc[d];
  }
  if (secondBest >= bestCorr * 0.95 && secondBest >= 0.5) {
    return {
      verified: false,
      correlation: round4(bestCorr),
      reason: '音频相关性缺乏唯一瞬态峰（疑似稳态周期信号）',
    };
  }

  const actualSample = searchStart + bestD + anchorOffsetInTemplate;
  const actualSeconds = actualSample / sampleRate;
  return {
    verified: true,
    actual_seconds: round4(actualSeconds),
    offset_seconds: round4(actualSeconds - nominalSeconds),
    correlation: round4(bestCorr),
  };
}

/** 在独立 SFX 分轨（sfx.wav）的局部窗口内查找能量峰值时刻。 */
export function locateEnergyPeakInStem(
  stem: Float32Array,
  sampleRate: number,
  centerSeconds: number,
  searchWindowSeconds = DefaultAudioSearchWindowSeconds,
): { verified: boolean; actual_seconds?: number; peak_rms: number; reason?: string } {
  const win = Math.max(16, Math.round(0.005 * sampleRate));
  const hop = Math.max(4, Math.round(0.001 * sampleRate));
  const start = Math.max(0, Math.round((centerSeconds - searchWindowSeconds) * sampleRate));
  const end = Math.min(stem.length, Math.round((centerSeconds + searchWindowSeconds) * sampleRate));
  if (end - start < win) return { verified: false, peak_rms: 0, reason: 'SFX 分轨搜索窗口样本不足' };
  const values: number[] = [];
  let bestIdx = 0;
  let bestRms = 0;
  for (let pos = start; pos + win <= end; pos += hop) {
    let sum2 = 0;
    for (let i = 0; i < win; i++) sum2 += stem[pos + i] * stem[pos + i];
    const rms = Math.sqrt(sum2 / win);
    values.push(rms);
    if (rms > bestRms) {
      bestRms = rms;
      bestIdx = pos;
    }
  }
  const baseline = median(values);
  if (bestRms < 0.005 || (baseline > 1e-4 && bestRms < baseline * 2.0)) {
    return { verified: false, peak_rms: round4(bestRms), reason: 'SFX 分轨窗口内无明显打击能量峰' };
  }
  return { verified: true, actual_seconds: round4((bestIdx + win / 2) / sampleRate), peak_rms: round4(bestRms) };
}

export interface VisualPeakResult {
  verified: boolean;
  metric: 'change' | 'brightness';
  peak_frame?: number;
  peak_seconds?: number;
  peak_value: number;
  baseline_value: number;
  reason?: string;
}

function meanGray(frame: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i];
  return frame.length > 0 ? sum / frame.length : 0;
}

/**
 * 在解码后的连续灰帧序列（起始帧号 decodeStart）中，于 [winStart, winEnd] 窗口内检测
 * 相邻帧变化峰（change）或亮度峰（brightness）。静态/无显著变化时诚实返回 verified=false。
 */
export function detectVisualPeak(params: {
  frames: readonly Uint8Array[];
  decodeStart: number;
  winStart: number;
  winEnd: number;
  fps: number;
  metric: 'change' | 'brightness';
  minDelta?: number;
}): VisualPeakResult {
  const { frames, decodeStart, winStart, winEnd, fps, metric } = params;
  const minDelta = params.minDelta ?? DefaultMinVisualDelta;
  if (winEnd - winStart + 1 <= 0 || frames.length === 0) {
    return { verified: false, metric, peak_value: 0, baseline_value: 0, reason: '画面搜索窗口为空' };
  }
  const getFrame = (f: number): Uint8Array | undefined => frames[f - decodeStart];

  if (metric === 'change') {
    const scores: Array<{ frame: number; value: number }> = [];
    for (let f = winStart; f <= winEnd; f++) {
      const cur = getFrame(f);
      const prev = getFrame(f - 1);
      scores.push({ frame: f, value: cur && prev ? meanAbsoluteDifference(cur, prev) : 0 });
    }
    const baseline = median(scores.map((s) => s.value));
    let maxVal = 0;
    for (const s of scores) if (s.value > maxVal) maxVal = s.value;
    if (maxVal < minDelta || maxVal - baseline < minDelta * 0.75 || (baseline > 0.5 && maxVal < baseline * 1.5)) {
      return {
        verified: false,
        metric,
        peak_value: round2(maxVal),
        baseline_value: round2(baseline),
        reason: `ROI 相邻帧变化不显著（峰值 ${round2(maxVal)}，基线 ${round2(baseline)}）`,
      };
    }
    const peak = scores.find((s) => s.value >= maxVal * 0.95)!;
    return {
      verified: true,
      metric,
      peak_frame: peak.frame,
      peak_seconds: round4(peak.frame / fps),
      peak_value: round2(peak.value),
      baseline_value: round2(baseline),
    };
  }

  const lumas: Array<{ frame: number; value: number }> = [];
  for (let f = winStart; f <= winEnd; f++) {
    const cur = getFrame(f);
    if (cur) lumas.push({ frame: f, value: meanGray(cur) });
  }
  if (lumas.length === 0) {
    return { verified: false, metric, peak_value: 0, baseline_value: 0, reason: '未能解码窗口内帧' };
  }
  let minLuma = Infinity;
  let maxLuma = -Infinity;
  for (const item of lumas) {
    if (item.value < minLuma) minLuma = item.value;
    if (item.value > maxLuma) maxLuma = item.value;
  }
  const range = maxLuma - minLuma;
  if (range < minDelta) {
    return {
      verified: false,
      metric,
      peak_value: round2(maxLuma),
      baseline_value: round2(minLuma),
      reason: `ROI 亮度变化不显著（极差 ${round2(range)} < ${minDelta}）`,
    };
  }
  const peak = lumas.find((item) => item.value >= maxLuma - Math.max(1.0, range * 0.05))!;
  if (peak.frame === winStart) {
    const prevFrame = getFrame(winStart - 1);
    if (prevFrame && peak.value - meanGray(prevFrame) < minDelta) {
      return {
        verified: false,
        metric,
        peak_value: round2(maxLuma),
        baseline_value: round2(minLuma),
        reason: '窗口起始前已处于高亮状态，未检测到新的亮度峰起跳',
      };
    }
  }
  return {
    verified: true,
    metric,
    peak_frame: peak.frame,
    peak_seconds: round4(peak.frame / fps),
    peak_value: round2(peak.value),
    baseline_value: round2(minLuma),
  };
}

/** 当存在 >= minMatches 个可靠音乐匹配且偏移散布 < maxSpreadSeconds 时，计算建议校准偏移值（秒）。 */
export function computeMeasuredOutputOffset(
  offsets: readonly number[],
  minMatches = DefaultMinReliableMatchesForOffset,
  maxSpreadSeconds = DefaultMaxOffsetSpreadSeconds,
): { measured_output_offset_seconds: number | null; spread_seconds: number | null } {
  if (offsets.length === 0) return { measured_output_offset_seconds: null, spread_seconds: null };
  const sorted = [...offsets].sort((a, b) => a - b);
  const spread = sorted[sorted.length - 1] - sorted[0];
  if (offsets.length < minMatches || spread >= maxSpreadSeconds) {
    return { measured_output_offset_seconds: null, spread_seconds: round4(spread) };
  }
  return { measured_output_offset_seconds: round4(median(sorted)), spread_seconds: round4(spread) };
}
