// 把字幕时间轴与配音里实际有声的区间逐条比对。
//
// 字幕时间来自 TTS 自带的时间戳、ASR 识别或强制对齐，三者都可能整体偏移或
// 局部错位：实测 TTS 自带的 SRT 会比实际发声早约 0.4 秒。字幕、镜头切点和
// 画面节拍全都挂在这条时间轴上，它错了，下游每一步都跟着错，而且没有一个
// 环节会报错。
//
// 这里只用最朴素的信号——音频能量——做独立参照：它不知道文字，但能确定
// 「这一刻有没有声音」。与字幕来源完全无关，所以能拿来交叉校验任何一种来源。
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import type { Cue } from '../srt';
import { formatFixed, goRound } from './gofmt';

/** Segment 是一段连续有声的区间（秒）。 */
export interface Segment {
  start: number;
  end: number;
}

/** Options 控制有声区间的判定与比对容差。零值（或省略）取缺省值。 */
export interface Options {
  /** 响度采样窗长（秒）。 */
  window?: number;
  /**
   * 电平低于「全片最响窗口 - belowPeakDB」视为静音。
   * 用相对峰值而不是绝对阈值：不同 TTS 的输出电平相差十几 dB。
   */
  belowPeakDB?: number;
  /** 被当作停顿的最短静音；更短的静音（字间、爆破音前）并入有声区间。 */
  minGap?: number;
  /** 被当作发声的最短区间；更短的视为咔哒声等噪声。 */
  minSpeech?: number;
  /** 字幕边界与发声边界允许的偏差（秒）。 */
  tolerance?: number;
  /** 报告「有声却没有字幕」的最短区间。 */
  minUncovered?: number;
}

type FullOptions = Required<Options>;

/**
 * 缺省值。minGap 取 0.12 秒：中文 TTS 句内逗号停顿通常在 0.15 秒以上，字间
 * 间隙远短于此。tolerance 取 0.2 秒：人眼对字幕早出现 0.2 秒以内基本无感。
 */
export const Defaults: Readonly<FullOptions> = Object.freeze({
  window: 0.01,
  belowPeakDB: 35,
  minGap: 0.12,
  minSpeech: 0.05,
  tolerance: 0.2,
  minUncovered: 0.3,
});

function withDefaults(o: Options): FullOptions {
  const pick = (value: number | undefined, fallback: number) => (value === undefined || value <= 0 ? fallback : value);
  return {
    window: pick(o.window, Defaults.window),
    belowPeakDB: pick(o.belowPeakDB, Defaults.belowPeakDB),
    minGap: pick(o.minGap, Defaults.minGap),
    minSpeech: pick(o.minSpeech, Defaults.minSpeech),
    tolerance: pick(o.tolerance, Defaults.tolerance),
    minUncovered: pick(o.minUncovered, Defaults.minUncovered),
  };
}

/**
 * CueResult 是一条字幕的比对结果。start_delta = 字幕开始 - 其中首个发声开始，
 * 负数表示字幕早于声音；end_delta = 字幕结束 - 其中最后发声结束，正数表示
 * 字幕比声音停留得久。没有覆盖任何发声时四个可选字段都省略。
 */
export interface CueResult {
  index: number;
  start: number;
  end: number;
  text: string;
  speech_start?: number;
  speech_end?: number;
  start_delta?: number;
  end_delta?: number;
  /**
   * 首段发声从本条字幕开始，而不是从前一条延续过来。
   * 只有这样的字幕，start_delta 才反映时间戳偏移，才计入整体偏移中位数。
   */
  owns_onset: boolean;
}

/** Report 是比对的机器可读结果。ok 只由 problems 决定。 */
export interface Report {
  schema_version: number;
  ok: boolean;
  threshold_db: number;
  speech: Segment[];
  cues: CueResult[];
  /** 全部字幕 start_delta 的中位数，用来识别整体偏移。 */
  median_start_delta?: number;
  problems: string[];
  hints?: string[];
}

/** Report 的结构版本。 */
export const ReportSchemaVersion = 1;

/** 原子写出报告。字段顺序与 Go 的 struct 一致，空 hints 省略。 */
export function writeReportJSON(report: Report, target: string): void {
  const body = marshalIndent({
    schema_version: report.schema_version,
    ok: report.ok,
    threshold_db: report.threshold_db,
    speech: report.speech.map((s) => ({ start: s.start, end: s.end })),
    cues: report.cues.map((c) => ({
      index: c.index,
      start: c.start,
      end: c.end,
      text: c.text,
      speech_start: c.speech_start,
      speech_end: c.speech_end,
      start_delta: c.start_delta,
      end_delta: c.end_delta,
      owns_onset: c.owns_onset,
    })),
    median_start_delta: report.median_start_delta,
    problems: report.problems,
    hints: report.hints && report.hints.length > 0 ? report.hints : undefined,
  });
  atomicWrite(target, body + '\n', 0o644);
}

/**
 * 全片最响窗口的下限：再安静就视为整段没有发声。
 * 正常配音的峰值在 -20 dBFS 以上，-60 dBFS 已是录音底噪的量级。
 */
const quietestSpeechDB = -60.0;

/** 从逐窗电平里切出有声区间，返回区间与所用阈值。 */
export function speech(levels: number[], options: Options = {}): [Segment[], number] {
  const opts = withDefaults(options);
  let peak = -Infinity;
  for (const level of levels) peak = Math.max(peak, level);
  const threshold = peak - opts.belowPeakDB;
  // 阈值相对峰值，全片静音时峰值本身就是底噪，不设下限会把底噪当成发声。
  if (peak < quietestSpeechDB) return [[], threshold];
  const raw: Segment[] = [];
  let start = -1;
  levels.forEach((level, i) => {
    const loud = level >= threshold;
    if (loud && start < 0) {
      start = i;
    } else if (!loud && start >= 0) {
      raw.push({ start: start * opts.window, end: i * opts.window });
      start = -1;
    }
  });
  if (start >= 0) raw.push({ start: start * opts.window, end: levels.length * opts.window });
  const merged: Segment[] = [];
  for (const segment of raw) {
    const n = merged.length;
    if (n > 0 && segment.start - merged[n - 1].end < opts.minGap) {
      merged[n - 1].end = segment.end;
      continue;
    }
    merged.push({ ...segment });
  }
  const out: Segment[] = [];
  for (const segment of merged) {
    if (segment.end - segment.start >= opts.minSpeech) out.push(round(segment));
  }
  return [out, threshold];
}

function round(s: Segment): Segment {
  return { start: goRound(s.start * 1000) / 1000, end: goRound(s.end * 1000) / 1000 };
}

/** 逐条比对字幕与有声区间。 */
export function check(cues: Cue[], speechSegments: Segment[], threshold: number, options: Options = {}): Report {
  const opts = withDefaults(options);
  const report: Report = {
    schema_version: ReportSchemaVersion,
    ok: false,
    threshold_db: goRound(threshold * 10) / 10,
    speech: speechSegments ?? [],
    cues: [],
    problems: [],
  };
  if (speechSegments.length === 0) {
    report.problems.push('音频里没有检测到任何发声');
    return report;
  }
  const deltas: number[] = [];
  for (const cue of cues) {
    if (cue.end_seconds <= cue.start_seconds) {
      addHint(
        report,
        `第 ${cue.index} 条字幕时长为 0（${formatFixed(cue.start_seconds, 3)} 秒），未参与比对；若不是纯标点条目，检查时间戳来源`,
      );
      continue;
    }
    const result = checkCue(report, cue, speechSegments, opts);
    if (result.owns_onset) deltas.push(result.start_delta!);
    report.cues.push(result);
  }
  checkUncovered(report, cues, speechSegments, opts);
  if (deltas.length > 0) {
    const median = medianOf(deltas);
    report.median_start_delta = median;
    if (Math.abs(median) > opts.tolerance / 2) {
      const direction = median > 0 ? '晚' : '早';
      addHint(
        report,
        `字幕整体比声音${direction}约 ${formatFixed(Math.abs(median), 3)} 秒：多条同向偏移说明时间戳来源有系统误差，优先整体校正而不是逐条修`,
      );
    }
  }
  report.ok = report.problems.length === 0;
  return report;
}

function addHint(report: Report, hint: string): void {
  (report.hints ??= []).push(hint);
}

/**
 * 取字幕区间内的发声，比较两端。
 *
 * 字幕开始早于声音、或开始时声音早已响起，都判问题：前者让字幕先于语音
 * 出现，后者让镜头切点落在句中。字幕结束晚于声音只进 hints：终稿字幕按可读
 * 语义单元延长停留是 PROMPT 允许的做法。
 */
function checkCue(report: Report, cue: Cue, speechSegments: Segment[], opts: FullOptions): CueResult {
  const result: CueResult = { index: cue.index, start: cue.start_seconds, end: cue.end_seconds, text: cue.text, owns_onset: false };
  const [first, last] = meaningfulOverlap(cue, speechSegments, opts.tolerance);
  if (first < 0) {
    report.problems.push(
      `第 ${cue.index} 条字幕（${formatFixed(cue.start_seconds, 3)}–${formatFixed(cue.end_seconds, 3)} 秒）整段落在静音里：${cue.text}`,
    );
    return result;
  }
  const speechStart = speechSegments[first].start;
  const speechEnd = speechSegments[last].end;
  const startDelta = roundMillis(cue.start_seconds - speechStart);
  const endDelta = roundMillis(cue.end_seconds - speechEnd);
  result.speech_start = speechStart;
  result.speech_end = speechEnd;
  result.start_delta = startDelta;
  result.end_delta = endDelta;
  result.owns_onset = !previousCueCovers(report, speechStart);
  if (startDelta < -opts.tolerance) {
    report.problems.push(
      `第 ${cue.index} 条字幕比声音早 ${formatFixed(-startDelta, 3)} 秒开始（字幕 ${formatFixed(cue.start_seconds, 3)} 秒，发声 ${formatFixed(speechStart, 3)} 秒）：${cue.text}`,
    );
  } else if (startDelta > opts.tolerance && result.owns_onset) {
    report.problems.push(
      `第 ${cue.index} 条字幕比声音晚 ${formatFixed(startDelta, 3)} 秒开始（字幕 ${formatFixed(cue.start_seconds, 3)} 秒，发声 ${formatFixed(speechStart, 3)} 秒）：${cue.text}`,
    );
  }
  if (endDelta > opts.tolerance) {
    addHint(
      report,
      `第 ${cue.index} 条字幕在声音结束后又停留 ${formatFixed(endDelta, 3)} 秒：若这是 TTS 或对齐直接产出的时间戳，说明它偏晚`,
    );
  }
  return result;
}

/**
 * 找出与字幕真正重叠的首、末段发声，没有时返回 -1。
 *
 * 只擦到边的发声不算：上一句的尾音延伸进本条字幕开头几十毫秒时，若把它当成
 * 本条的首段发声，本条「比声音早开始」就被掩盖了——那正是这个命令要抓的
 * 系统性提前。所以首段要求在字幕开始后仍持续超过容差，末段要求在字幕结束前
 * 已开始超过容差；都找不到时退回任意重叠，避免把很短的字幕误判成落在静音里。
 */
function meaningfulOverlap(cue: Cue, speechSegments: Segment[], tolerance: number): [number, number] {
  let first = -1;
  let last = -1;
  let anyFirst = -1;
  let anyLast = -1;
  speechSegments.forEach((segment, i) => {
    if (segment.end <= cue.start_seconds || segment.start >= cue.end_seconds) return;
    if (anyFirst < 0) anyFirst = i;
    anyLast = i;
    if (first < 0 && segment.end > cue.start_seconds + tolerance) first = i;
    if (segment.start < cue.end_seconds - tolerance) last = i;
  });
  if (first < 0 || last < 0 || first > last) return [anyFirst, anyLast];
  return [first, last];
}

/**
 * at 这一刻是否已被前面的字幕覆盖。连续发声被拆成
 * 两条字幕时，后一条的开始本就落在发声中间，不是「晚了」。
 */
function previousCueCovers(report: Report, at: number): boolean {
  return report.cues.some((previous) => previous.start <= at && at < previous.end);
}

/** 找出有声但没有任何字幕覆盖的区间。 */
function checkUncovered(report: Report, cues: Cue[], speechSegments: Segment[], opts: FullOptions): void {
  const covered: Segment[] = cues.map((cue) => ({ start: cue.start_seconds, end: cue.end_seconds }));
  // Go 用的是不稳定的 sort.Slice；这里只按 start 比较，等 start 的区间先后不影响覆盖结果。
  covered.sort((a, b) => a.start - b.start);
  for (const segment of speechSegments) {
    let cursor = segment.start;
    for (const cover of covered) {
      if (cover.end <= cursor || cover.start >= segment.end) continue;
      if (cover.start > cursor) reportGap(report, cursor, cover.start, opts);
      cursor = Math.max(cursor, cover.end);
      if (cursor >= segment.end) break;
    }
    if (cursor < segment.end) reportGap(report, cursor, segment.end, opts);
  }
}

function reportGap(report: Report, start: number, end: number, opts: FullOptions): void {
  if (end - start >= opts.minUncovered) {
    report.problems.push(
      `${formatFixed(start, 3)}–${formatFixed(end, 3)} 秒有声音但没有字幕覆盖（${formatFixed(end - start, 3)} 秒）`,
    );
  }
}

function roundMillis(value: number): number {
  return goRound(value * 1000) / 1000;
}

/** 中位数；偶数个时取中间两个的均值并按毫秒取整。 */
export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return roundMillis((sorted[mid - 1] + sorted[mid]) / 2);
}
