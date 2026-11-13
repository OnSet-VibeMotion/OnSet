// 移植自 internal/align/build.go。
import { totalFrames } from '../beat';
import { atomicWrite } from '../fsutil';
import { formatFixed } from '../gofmt';
import { compareBytes, marshalIndent, sortedKeys } from '../gojson';
import { buildCues, toMs, type Cue } from './cue';
import type { Item } from './evidence';
import { LabelExact, LabelInsertion, LabelMerge, LabelReplace, LabelSplit, matchTokens, type Group } from './match';
import { SourceAdjusted, TimelineSchema, applyAdjustments, round3, timePhrases, type AdjustFile, type Phrase, type PhraseTiming, type Timeline } from './phrase';
import type { Script } from './script';
import { evidenceTokens, locate, type EvToken, type TimedToken } from './timing';

// 判据。
/**
 * MinMatchRate 是 exact+split+merge 占全部朗读单元的下限，低于它说明送进对齐的
 * 文本不是这份终稿，或者配音与终稿差得太多。
 */
export const MinMatchRate = 0.85;
/** HintConfidence 以下的短语进 hints，提示人工复核。 */
export const HintConfidence = 0.9;
/** segmentSlack 是相邻两段对齐结果允许的重叠（秒）。超过它说明 --align 的偏移写错了。 */
const segmentSlack = 0.05;
/** maxListed 是同类 hints 最多逐条列出的条数，其余汇总成一条。 */
const maxListed = 30;

/** Options 是 build 的输入。 */
export interface Options {
  fps: number;
  /** adjust 是修正层，可省略。 */
  adjust?: AdjustFile | null;
  /** existing 是已有的短语时间轴，可省略。 */
  existing?: Timeline | null;
}

/** Result 是一次构建的全部产物。 */
export interface Result {
  cues: Cue[];
  timeline: Timeline;
  report: Report;
  tokens: TimedToken[];
}

/** PhraseStat 是报告里单个短语的对齐情况。labels 是 Go 的 map，写出时按键排序。 */
export interface PhraseStat {
  phrase_id: string;
  confidence: number;
  alignment_source: string;
  labels: Record<string, number>;
  measured_start_frame: number;
  measured_end_frame_exclusive: number;
  start_frame: number;
  end_frame_exclusive: number;
}

/** Irregular 是一处非精确匹配，带终稿位置，方便回去查。script / heard / line / col 为零值时不写出。 */
export interface Irregular {
  label: string;
  script: string;
  heard: string;
  line: number;
  col: number;
  start_ms: number;
  end_ms: number;
}

/** Report 是 align-report.json。ok 只由 problems 决定。hints 为空时不写出。 */
export interface Report {
  schema_version: number;
  ok: boolean;
  fps: number;
  tokens: number;
  evidence_tokens: number;
  labels: Record<string, number>;
  match_rate: number;
  interpolated_tokens: number;
  speech_start_ms: number;
  speech_end_ms: number;
  total_frames: number;
  cues: number;
  phrases: PhraseStat[];
  irregular: Irregular[];
  problems: string[];
  hints: string[];
}

/** ReportSchemaVersion 是 Report 的结构版本。 */
export const ReportSchemaVersion = 1;

/** 按 Go 的字段顺序与 omitempty 构造 align-report.json 的 JSON 值。 */
export function reportToJSON(r: Report): unknown {
  return {
    schema_version: r.schema_version,
    ok: r.ok,
    fps: r.fps,
    tokens: r.tokens,
    evidence_tokens: r.evidence_tokens,
    labels: sortedKeys(r.labels),
    match_rate: r.match_rate,
    interpolated_tokens: r.interpolated_tokens,
    speech_start_ms: r.speech_start_ms,
    speech_end_ms: r.speech_end_ms,
    total_frames: r.total_frames,
    cues: r.cues,
    phrases: r.phrases.map((p) => ({
      phrase_id: p.phrase_id,
      confidence: p.confidence,
      alignment_source: p.alignment_source,
      labels: sortedKeys(p.labels),
      measured_start_frame: p.measured_start_frame,
      measured_end_frame_exclusive: p.measured_end_frame_exclusive,
      start_frame: p.start_frame,
      end_frame_exclusive: p.end_frame_exclusive,
    })),
    irregular: r.irregular.map((i) => ({
      label: i.label,
      script: i.script || undefined,
      heard: i.heard || undefined,
      line: i.line || undefined,
      col: i.col || undefined,
      start_ms: i.start_ms,
      end_ms: i.end_ms,
    })),
    problems: r.problems,
    hints: r.hints.length > 0 ? r.hints : undefined,
  };
}

/**
 * Build 把对齐结果映射回终稿，产出字幕、短语时间轴与报告。修正层不合格时抛错、不产出；
 * 对齐质量问题只写进 report.problems，产物照常给出，便于对照排查。
 */
export function build(script: Script, items: Item[] | null, opts: Options): Result {
  if (opts.fps <= 0) throw new Error(`fps 必须是正整数，收到 ${opts.fps}`);
  if (script.tokens.length === 0) throw new Error('终稿没有任何朗读内容');
  const report: Report = {
    schema_version: ReportSchemaVersion,
    ok: false,
    fps: opts.fps,
    tokens: 0,
    evidence_tokens: 0,
    labels: {},
    match_rate: 0,
    interpolated_tokens: 0,
    speech_start_ms: 0,
    speech_end_ms: 0,
    total_frames: 0,
    cues: 0,
    phrases: [],
    irregular: [],
    problems: [],
    hints: [],
  };
  items = items ?? [];
  checkSegmentOrder(items, report);

  const evidence = evidenceTokens(items);
  const source = script.tokens.map((t) => t.norm);
  const target = evidence.map((e) => e.norm);
  const groups = matchTokens(source, target);
  const timed = locate(script.tokens, evidence, groups);
  const cues = buildCues(script, timed);

  report.tokens = timed.length;
  report.evidence_tokens = evidence.length;
  report.cues = cues.length;
  let matched = 0;
  for (const t of timed) {
    report.labels[t.label] = (report.labels[t.label] ?? 0) + 1;
    if (t.label === LabelExact || t.label === LabelSplit || t.label === LabelMerge) matched++;
    if (t.interpolated) report.interpolated_tokens++;
  }
  report.match_rate = round3(matched / timed.length);
  describeGroups(groups, timed, evidence, report);

  if (evidence.length === 0) {
    report.problems.push('对齐结果里没有任何可用的字或词：确认对齐工具跑完了，且输入是实际送进 TTS 的文本');
  } else {
    let first = evidence[0].start;
    let last = evidence[0].end;
    for (const e of evidence) {
      first = Math.min(first, e.start);
      last = Math.max(last, e.end);
    }
    report.speech_start_ms = toMs(first);
    report.speech_end_ms = toMs(last);
    if (report.speech_end_ms <= report.speech_start_ms) report.problems.push('对齐结果的总时间跨度为空');
  }
  if (timed.length > 0) {
    let lastEnd = timed[0].end;
    for (const t of timed) lastEnd = Math.max(lastEnd, t.end);
    report.total_frames = totalFrames(toMs(lastEnd) / 1000, opts.fps);
  }
  if (report.match_rate < MinMatchRate) {
    report.problems.push(
      `精确匹配率 ${formatFixed(report.match_rate * 100, 1)}% 低于 ${formatFixed(MinMatchRate * 100, 0)}%：送进对齐的文本可能不是 align_text() 产出的那份，或配音与终稿差异过大`,
    );
  }

  const phrases = timePhrases(script, timed, cues, opts.fps);
  const { final, adjusted } = applyAdjustments(phrases, opts.adjust, report.total_frames);
  const timeline: Timeline = { schema: TimelineSchema, fps: opts.fps, phrases: [] };
  const existing = new Map<string, Phrase>();
  for (const p of opts.existing?.phrases ?? []) existing.set(p.phrase_id, p);
  for (const p of phrases) {
    const r = final.get(p.span.id)!;
    const out: Phrase = {
      phrase_id: p.span.id,
      subtitle_index: p.subtitle,
      source_text: p.text,
      semantic_order: p.span.order,
      start_ms: toMs(p.start),
      end_ms: toMs(p.end),
      start_frame: r[0],
      end_frame_exclusive: r[1],
      alignment_source: p.source,
      confidence: p.confidence,
      reviewed: false,
      visible_event_ids: [],
    };
    const old = existing.get(p.span.id);
    if (old) {
      out.reviewed = old.reviewed;
      if (old.visible_event_ids !== null) out.visible_event_ids = old.visible_event_ids;
    }
    if (adjusted.has(p.span.id)) {
      out.alignment_source = SourceAdjusted;
      out.reviewed = true;
      out.start_ms = frameMs(r[0], opts.fps);
      out.end_ms = frameMs(r[1], opts.fps);
    }
    timeline.phrases!.push(out);
    report.phrases.push({
      phrase_id: p.span.id,
      confidence: p.confidence,
      alignment_source: out.alignment_source,
      labels: Object.fromEntries(p.labels),
      measured_start_frame: p.measuredFrom,
      measured_end_frame_exclusive: p.measuredTo,
      start_frame: r[0],
      end_frame_exclusive: r[1],
    });
    judgePhrase(p, report);
  }
  if (opts.existing) {
    const current = new Set(phrases.map((p) => p.span.id));
    for (const old of opts.existing.phrases ?? []) {
      if (!current.has(old.phrase_id)) {
        let note = '';
        if (old.visible_event_ids !== null && old.visible_event_ids.length > 0) {
          note = `，它绑定的可见事件 [${old.visible_event_ids.join(' ')}] 需要改绑`;
        }
        report.hints.push(`短语 ${old.phrase_id} 已不在终稿里，已从时间轴移除${note}`);
      }
    }
  }
  report.ok = report.problems.length === 0;
  return { cues, timeline, report, tokens: timed };
}

function frameMs(frame: number, fps: number): number {
  return toMs(frame / fps);
}

/** judgePhrase 判定短语级问题与提示。 */
function judgePhrase(p: PhraseTiming, report: Report): void {
  const where = `短语 ${p.span.id}「${p.text}」（终稿第 ${p.span.line} 行）`;
  if (p.tok1 === p.tok0) {
    report.problems.push(where + '没有朗读内容，无法从配音定时；改成朗读侧有字，或去掉短语标记');
  } else if (p.omitted) {
    report.problems.push(where + '里有字在对齐结果中找不到：TTS 漏读或对齐丢了，重新合成或检查送进对齐的文本');
  } else if (p.allInterp) {
    report.problems.push(where + '全部时间都是插值得来，没有任何实测依据');
  } else if (p.confidence < HintConfidence) {
    report.hints.push(`${where}置信度 ${formatFixed(p.confidence, 2)}，低于 ${formatFixed(HintConfidence, 2)}，复核它的起止帧`);
  }
}

/** describeGroups 把非精确的分组写进 irregular，并把多读、读错列进 hints。 */
function describeGroups(groups: Group[], timed: TimedToken[], evidence: EvToken[], report: Report): void {
  const insertions: string[] = [];
  const replacements: string[] = [];
  for (const g of groups) {
    if (g.label === LabelExact) continue;
    const item: Irregular = { label: g.label, script: '', heard: '', line: 0, col: 0, start_ms: 0, end_ms: 0 };
    item.script = timed
      .slice(g.s0, g.s1)
      .map((t) => t.text)
      .join('');
    item.heard = evidence
      .slice(g.e0, g.e1)
      .map((e) => e.text)
      .join(' ');
    if (g.s1 > g.s0) {
      item.line = timed[g.s0].line;
      item.col = timed[g.s0].col;
      item.start_ms = toMs(timed[g.s0].start);
      item.end_ms = toMs(timed[g.s1 - 1].end);
    } else if (g.e1 > g.e0) {
      item.start_ms = toMs(evidence[g.e0].start);
      item.end_ms = toMs(evidence[g.e1 - 1].end);
    }
    report.irregular.push(item);
    const at = `${formatFixed(item.start_ms / 1000, 2)} 秒`;
    if (g.label === LabelInsertion) {
      report.labels[LabelInsertion] = (report.labels[LabelInsertion] ?? 0) + (g.e1 - g.e0);
      insertions.push(`配音里多出「${item.heard}」（${at}），终稿没有`);
    } else if (g.label === LabelReplace) {
      replacements.push(`终稿「${item.script}」（第 ${item.line} 行第 ${item.col} 列）对上的是「${item.heard}」（${at}）`);
    }
  }
  report.hints.push(...capList(insertions, '处多读'));
  report.hints.push(...capList(replacements, '处读法不同'));
}

function capList(items: string[], kind: string): string[] {
  if (items.length <= maxListed) return items;
  return [...items.slice(0, maxListed), `另有 ${items.length - maxListed} ${kind}，见报告 irregular`];
}

/** checkSegmentOrder 检查多段对齐结果平移后是否首尾相接：后一段的起点不能明显早于前一段的终点。 */
function checkSegmentOrder(items: Item[], report: Report): void {
  const segs: { first: number; last: number; seen: boolean }[] = [];
  for (const item of items) {
    while (segs.length <= item.segment) segs.push({ first: 0, last: 0, seen: false });
    const b = segs[item.segment];
    if (!b.seen) {
      b.first = item.start;
      b.last = item.end;
      b.seen = true;
    }
    b.first = Math.min(b.first, item.start);
    b.last = Math.max(b.last, item.end);
  }
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].seen && segs[i - 1].seen && segs[i].first < segs[i - 1].last - segmentSlack) {
      report.problems.push(
        `第 ${i + 1} 段对齐结果平移后起点 ${formatFixed(segs[i].first, 3)} 秒早于第 ${i} 段终点 ${formatFixed(segs[i - 1].last, 3)} 秒：--align 的偏移写错了，偏移应是该段音频在整条配音里的起点`,
      );
    }
  }
}

/**
 * WriteJSON 原子写出带缩进的 JSON。value 要先经 timelineToJSON / reportToJSON 排好字段顺序
 * （Go 的 map 按键排序、omitempty 省略零值）。
 */
export function writeJSON(file: string, value: unknown): void {
  atomicWrite(file, Buffer.from(marshalIndent(value) + '\n', 'utf8'), 0o644);
}

/** SortedLabels 返回报告里出现过的标签，按字典序，供命令行摘要输出。 */
export function sortedLabels(r: Report): string[] {
  return Object.keys(r.labels).sort(compareBytes);
}
