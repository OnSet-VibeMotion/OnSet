/**
 * 音色页的波形与逐字高亮。
 *
 * 音色库里只有「参考音频 + 逐字一致的文字稿」，没有字级时间戳；为一段十几秒的试听去跑强制对齐，
 * 要装几个 GB 的对齐模型。这里在界面里按音频的能量包络估：找出有声的段落和停顿，把文字按标点切成
 * 小句、按字数排到有声的时间上——停顿尽量对上标点，小句里的字平均分。逐字高亮只用来跟读，
 * 差个一两个字看不出来；配音与字幕的时间轴仍由第四阶段的强制对齐给。
 */

/** 包络每秒几帧（10 毫秒一帧）。 */
export const EnvelopeRate = 100;

export interface Wave {
  duration: number;
  /** 画波形用：每个 bucket 的峰值，按整段最大值归一到 0–1。 */
  peaks: Float32Array;
  /** 估时间用：每 10 毫秒的 RMS。 */
  envelope: Float32Array;
}

/** 从解码好的音频算波形与包络。 */
export function analyze(buffer: AudioBuffer, bars = 240): Wave {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const mono = new Float32Array(buffer.length);
  for (const ch of channels) for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / channels.length;
  return analyzeSamples(mono, buffer.sampleRate, bars);
}

export function analyzeSamples(samples: Float32Array, sampleRate: number, bars = 240): Wave {
  const frame = Math.max(1, Math.round(sampleRate / EnvelopeRate));
  const frames = Math.ceil(samples.length / frame);
  const envelope = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * frame);
    for (let i = f * frame; i < end; i++) sum += samples[i] * samples[i];
    envelope[f] = Math.sqrt(sum / Math.max(1, end - f * frame));
  }
  const peaks = new Float32Array(bars);
  const per = samples.length / bars;
  let max = 0;
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    const end = Math.min(samples.length, Math.floor((b + 1) * per));
    for (let i = Math.floor(b * per); i < end; i += 2) peak = Math.max(peak, Math.abs(samples[i]));
    peaks[b] = peak;
    max = Math.max(max, peak);
  }
  if (max > 0) for (let b = 0; b < bars; b++) peaks[b] /= max;
  return { duration: samples.length / sampleRate, peaks, envelope };
}

/** 一个显示单元：一个字、一个英文词或数字、一个标点、空白。 */
export interface Token {
  text: string;
  /** 念它要多久的相对分量，标点与空白是 0。 */
  weight: number;
  /** 标点：小句在这里断开。 */
  pause: boolean;
  start: number;
  end: number;
}

const cjk = /[㐀-鿿豈-﫿぀-ヿ가-힯]/u;
const word = /[A-Za-z0-9]/;
const pauseMarks = /[，。！？；：、,.!?;:…—]/;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (word.test(c)) {
      let w = c;
      while (i + 1 < chars.length && /[A-Za-z0-9'.%]/.test(chars[i + 1]) && !(chars[i + 1] === '.' && !word.test(chars[i + 2] ?? ''))) w += chars[++i];
      // 英文词按音节粗估，数字一位一个字。
      const weight = /^\d/.test(w) ? w.replace(/\D/g, '').length || 1 : Math.max(1, Math.round(w.length / 3));
      out.push({ text: w, weight, pause: false, start: 0, end: 0 });
    } else if (cjk.test(c)) {
      out.push({ text: c, weight: 1, pause: false, start: 0, end: 0 });
    } else {
      out.push({
        text: c,
        weight: 0,
        pause: pauseMarks.test(c),
        start: 0,
        end: 0,
      });
    }
  }
  return out;
}

/** 有声的帧：门限取在底噪与响段之间，补上字间的短缝、去掉零星的咔嗒。 */
function voicedFrames(envelope: Float32Array): boolean[] {
  const n = envelope.length;
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      s += envelope[j];
      c++;
    }
    smooth[i] = s / c;
  }
  const sorted = Array.from(smooth).sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const floor = pick(0.1);
  const loud = pick(0.95);
  const threshold = floor + (loud - floor) * 0.12;
  const voiced = Array.from(smooth, (v) => v > threshold && loud > 0);
  // 120 毫秒以内的缝算字间，补上。
  fillRuns(voiced, false, 12, true);
  // 60 毫秒以内的孤立响声算杂音。
  fillRuns(voiced, true, 6, false);
  return voiced;
}

function fillRuns(flags: boolean[], value: boolean, maxLen: number, interiorOnly: boolean) {
  let i = 0;
  while (i < flags.length) {
    if (flags[i] !== value) {
      i++;
      continue;
    }
    let j = i;
    while (j < flags.length && flags[j] === value) j++;
    const interior = i > 0 && j < flags.length;
    if (j - i <= maxLen && (interior || !interiorOnly)) for (let k = i; k < j; k++) flags[k] = !value;
    i = j;
  }
}

/** 把每个字排到音频上：返回的 Token 带 start / end（秒）。没有声音时按时长平均分。 */
export function align(text: string, wave: Pick<Wave, 'envelope' | 'duration'>): Token[] {
  const tokens = tokenize(text);
  const spoken = tokens.filter((t) => t.weight > 0);
  if (spoken.length === 0) return tokens;

  const voiced = voicedFrames(wave.envelope);
  const frames: number[] = [];
  voiced.forEach((v, i) => v && frames.push(i));
  if (frames.length < 5) return spreadEvenly(tokens, 0, wave.duration);

  // 有声轴：只数有声的帧。停顿是有声轴上的一个位置，对应真实时间里的一段空白。
  const V = frames.length;
  const gaps: { at: number; length: number }[] = [];
  for (let k = 1; k < V; k++) {
    const length = frames[k] - frames[k - 1] - 1;
    if (length >= 12) gaps.push({ at: k, length });
  }

  // 小句：标点处断开。
  const clauses: { from: number; to: number; weight: number }[] = [];
  let from = 0;
  let weight = 0;
  tokens.forEach((t, i) => {
    weight += t.weight;
    if (t.pause && weight > 0) {
      clauses.push({ from, to: i + 1, weight });
      from = i + 1;
      weight = 0;
    }
  });
  if (weight > 0) clauses.push({ from, to: tokens.length, weight });
  else if (clauses.length > 0) clauses[clauses.length - 1].to = tokens.length;

  const bounds = placeBoundaries(
    clauses.map((c) => c.weight),
    V,
    gaps,
  );
  clauses.forEach((c, k) => {
    const a = bounds[k];
    const b = bounds[k + 1];
    const total = c.weight;
    let pos = a;
    for (let i = c.from; i < c.to; i++) {
      const t = tokens[i];
      if (t.weight === 0) continue;
      const next = pos + ((b - a) * t.weight) / total;
      t.start = toSeconds(frames, pos, false);
      t.end = toSeconds(frames, next, true);
      pos = next;
    }
  });
  fillSilentTokens(tokens);
  return tokens;
}

/** 有声轴上的位置换成秒。end 为真时取那一帧的末尾。 */
function toSeconds(frames: number[], pos: number, end: boolean): number {
  const V = frames.length;
  if (end) {
    const k = Math.min(V - 1, Math.max(0, Math.ceil(pos - 1e-6) - 1));
    const frac = pos - k;
    return (frames[k] + Math.min(1, Math.max(0, frac))) / EnvelopeRate;
  }
  const k = Math.min(V - 1, Math.max(0, Math.floor(pos + 1e-6)));
  return (frames[k] + (pos - k)) / EnvelopeRate;
}

/**
 * 小句的分界放在哪：候选是停顿（越长越该用，记成奖励）与有声轴上每 50 毫秒一个点（罚一点，停顿不够用时
 * 才落在这里），动态规划挑一组让每句的时长最接近按字数分的。标点处多半有停顿，句子中间少有长停顿，
 * 所以长停顿没被用上本身就是错的证据。
 */
function placeBoundaries(weights: number[], V: number, gaps: { at: number; length: number }[]): number[] {
  const K = weights.length;
  if (K === 1) return [0, V];
  const W = weights.reduce((a, b) => a + b, 0);
  const expected = weights.map((w) => (V * w) / W);
  const cands: { at: number; cost: number }[] = gaps.map((g) => ({
    at: g.at,
    cost: -0.6 * Math.min(1, g.length / 30),
  }));
  for (let p = 5; p < V; p += 5) if (!gaps.some((g) => Math.abs(g.at - p) < 5)) cands.push({ at: p, cost: 0.3 });
  cands.sort((a, b) => a.at - b.at);
  const N = cands.length;
  if (N < K - 1) {
    const out = [0];
    let acc = 0;
    for (let k = 0; k < K - 1; k++) out.push((acc += expected[k]));
    out.push(V);
    return out;
  }
  const clauseCost = (k: number, len: number) => {
    if (len <= 0) return 1e9;
    const r = Math.log(len / expected[k]);
    return r * r * Math.sqrt(weights[k]);
  };
  // dp[k][j]：第 k 个分界（0 起）放在候选 j 上时，前 k+1 句的最小代价。
  const dp: Float64Array[] = [];
  const back: Int32Array[] = [];
  for (let k = 0; k < K - 1; k++) {
    dp.push(new Float64Array(N).fill(Infinity));
    back.push(new Int32Array(N).fill(-1));
    for (let j = k; j < N - (K - 2 - k); j++) {
      const here = cands[j];
      if (k === 0) {
        dp[0][j] = clauseCost(0, here.at) + here.cost;
        continue;
      }
      let best = Infinity;
      let arg = -1;
      for (let i = k - 1; i < j; i++) {
        const prev = dp[k - 1][i];
        if (prev === Infinity) continue;
        const c = prev + clauseCost(k, here.at - cands[i].at);
        if (c < best) {
          best = c;
          arg = i;
        }
      }
      dp[k][j] = best + here.cost;
      back[k][j] = arg;
    }
  }
  let best = Infinity;
  let arg = -1;
  for (let j = K - 2; j < N; j++) {
    const c = dp[K - 2][j] + clauseCost(K - 1, V - cands[j].at);
    if (c < best) {
      best = c;
      arg = j;
    }
  }
  const out = new Array<number>(K + 1);
  out[0] = 0;
  out[K] = V;
  for (let k = K - 2; k >= 0; k--) {
    out[k + 1] = cands[arg].at;
    arg = back[k][arg];
  }
  return out;
}

function spreadEvenly(tokens: Token[], start: number, end: number): Token[] {
  const total = tokens.reduce((a, t) => a + t.weight, 0);
  let pos = start;
  for (const t of tokens) {
    if (t.weight === 0) continue;
    const next = pos + ((end - start) * t.weight) / total;
    t.start = pos;
    t.end = next;
    pos = next;
  }
  fillSilentTokens(tokens);
  return tokens;
}

/** 标点与空白跟着前一个字：念完前一个字就算读到它。 */
function fillSilentTokens(tokens: Token[]) {
  let last = 0;
  for (const t of tokens) {
    if (t.weight > 0) last = t.end;
    else t.start = t.end = last;
  }
}

/** 现在读到第几个单元（没在念任何字时是 -1）。 */
export function currentToken(tokens: Token[], time: number): number {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.weight > 0 && time >= t.start && time < t.end) return i;
  }
  return -1;
}
