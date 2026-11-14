import fs from 'node:fs';
import { frameOf } from '../frames';
import { decodeFirst, sliceOf, unmarshal, type StructType } from '../gojson/decode';
import { goPathError, goRound, goTrimSpace } from '../gofmt';
import { cueOfPiece, toMs, type Cue } from './cue';
import { LabelExact, LabelMerge, LabelOmission, LabelReplace, LabelSplit } from './match';
import type { PhraseSpan, Script } from './script';
import type { TimedToken } from './timing';

// 短语时间来源。
export const SourceForced = 'forced-alignment'; // 首尾单元都是测出来的
export const SourceInterpolated = 'interpolated'; // 首或尾单元是插值出来的
export const SourceAdjusted = 'adjusted'; // 被 phrase-adjust.json 改过边界

/**
 * Phrase 是 phrase-timeline.json 的一条。字段名由制作提示词第四阶段与 internal/reads 固定。
 * visible_event_ids 为 null 对应 Go 的 nil 切片（只会出现在读进来的旧文件里）。
 */
export interface Phrase {
  phrase_id: string;
  subtitle_index: number;
  source_text: string;
  semantic_order: number;
  start_ms: number;
  end_ms: number;
  start_frame: number;
  end_frame_exclusive: number;
  alignment_source: string;
  confidence: number;
  reviewed: boolean;
  visible_event_ids: string[] | null;
}

/** Timeline 是 phrase-timeline.json。 */
export interface Timeline {
  schema: number;
  fps: number;
  phrases: Phrase[] | null;
}

/** TimelineSchema 是 phrase-timeline.json 的结构版本。 */
export const TimelineSchema = 1;

const phraseType: StructType = {
  kind: 'struct',
  goName: 'align.Phrase',
  name: 'Phrase',
  fields: [
    ['phrase_id', 'string'],
    ['subtitle_index', 'int'],
    ['source_text', 'string'],
    ['semantic_order', 'int'],
    ['start_ms', 'int64'],
    ['end_ms', 'int64'],
    ['start_frame', 'int'],
    ['end_frame_exclusive', 'int'],
    ['alignment_source', 'string'],
    ['confidence', 'float'],
    ['reviewed', 'bool'],
    ['visible_event_ids', sliceOf('string')],
  ],
};

const timelineType: StructType = {
  kind: 'struct',
  goName: 'align.Timeline',
  name: 'Timeline',
  fields: [
    ['schema', 'int'],
    ['fps', 'int'],
    ['phrases', sliceOf(phraseType)],
  ],
};

/** 按 Go 的字段顺序构造 phrase-timeline.json 的 JSON 值。 */
export function timelineToJSON(t: Timeline): unknown {
  return {
    schema: t.schema,
    fps: t.fps,
    phrases:
      t.phrases === null
        ? null
        : t.phrases.map((p) => ({
            phrase_id: p.phrase_id,
            subtitle_index: p.subtitle_index,
            source_text: p.source_text,
            semantic_order: p.semantic_order,
            start_ms: p.start_ms,
            end_ms: p.end_ms,
            start_frame: p.start_frame,
            end_frame_exclusive: p.end_frame_exclusive,
            alignment_source: p.alignment_source,
            confidence: p.confidence,
            reviewed: p.reviewed,
            visible_event_ids: p.visible_event_ids,
          })),
  };
}

/**
 * LoadExistingTimeline 读取已有的短语时间轴，用来保留操作者填写的 visible_event_ids 与 reviewed。
 * 文件不存在返回 null；存在但读不懂时报错，不覆盖别人写过的内容。
 */
export function loadExistingTimeline(file: string): Timeline | null {
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`无法读取已有短语时间轴：${goPathError('open', file, err)}`, { cause: err });
  }
  try {
    return unmarshal<Timeline>(body, timelineType);
  } catch (err) {
    throw new Error(
      `已有短语时间轴 ${file} 不是合法 JSON 或字段类型不符，为免覆盖其中手填的 visible_event_ids，先修好或移走它：${(err as Error).message}`,
      { cause: err },
    );
  }
}

/** Adjustment 是对一个短语边界的人工修正。 */
export interface Adjustment {
  phrase_id: string;
  edge: string;
  frame: number;
  reason: string;
}

/** AdjustFile 是 production/phrase-adjust.json。 */
export interface AdjustFile {
  schema: number;
  adjustments: Adjustment[] | null;
}

const adjustmentType: StructType = {
  kind: 'struct',
  goName: 'align.Adjustment',
  name: 'Adjustment',
  fields: [
    ['phrase_id', 'string'],
    ['edge', 'string'],
    ['frame', 'int'],
    ['reason', 'string'],
  ],
};

const adjustFileType: StructType = {
  kind: 'struct',
  goName: 'align.AdjustFile',
  name: 'AdjustFile',
  fields: [
    ['schema', 'int'],
    ['adjustments', sliceOf(adjustmentType)],
  ],
};

/** LoadAdjust 读取修正层。与 Go 一样只解码第一个 JSON 值，其后的内容不看。 */
export function loadAdjust(file: string): AdjustFile {
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`无法读取修正文件：${goPathError('open', file, err)}`, { cause: err });
  }
  let adjust: AdjustFile;
  try {
    adjust = decodeFirst<AdjustFile>(body, adjustFileType, true).value;
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON 或含未知字段：${(err as Error).message}`, { cause: err });
  }
  if (adjust.schema !== 1) throw new Error(`${file} 的 schema 应为 1，收到 ${adjust.schema}`);
  return adjust;
}

/** phraseTiming 是一个短语的实测结果，修正之前。 */
export interface PhraseTiming {
  span: PhraseSpan;
  text: string;
  tok0: number;
  tok1: number;
  start: number;
  end: number;
  source: string;
  confidence: number;
  labels: Map<string, number>;
  omitted: boolean;
  allInterp: boolean;
  subtitle: number;
  measuredFrom: number;
  measuredTo: number;
}

/** timePhrases 给每个受保护短语定时。只显示、不朗读的短语借前一个朗读单元的终点。 */
export function timePhrases(s: Script, timed: TimedToken[], cues: Cue[], fps: number): PhraseTiming[] {
  return s.phrases.map((span) => {
    const [tok0, tok1] = s.tokenRange(span.startPiece, span.endPiece);
    const p: PhraseTiming = {
      span,
      text: s.displayText(span.startPiece, span.endPiece),
      tok0,
      tok1,
      start: 0,
      end: 0,
      source: '',
      confidence: 0,
      labels: new Map(),
      omitted: false,
      allInterp: false,
      subtitle: 0,
      measuredFrom: 0,
      measuredTo: 0,
    };
    if (p.tok1 === p.tok0) {
      // 没有朗读内容：时间点落在前一个朗读单元的终点（或下一个的起点）。
      let at = 0.0;
      if (p.tok0 > 0) at = timed[p.tok0 - 1].end;
      else if (p.tok0 < timed.length) at = timed[p.tok0].start;
      p.start = at;
      p.end = at;
      p.source = SourceInterpolated;
      p.allInterp = true;
      p.subtitle = cueOfPiece(cues, span.startPiece);
    } else {
      const first = timed[p.tok0];
      const last = timed[p.tok1 - 1];
      p.start = first.start;
      p.end = last.end;
      p.source = SourceForced;
      if (first.interpolated || last.interpolated) p.source = SourceInterpolated;
      let score = 0.0;
      p.allInterp = true;
      for (const t of timed.slice(p.tok0, p.tok1)) {
        p.labels.set(t.label, (p.labels.get(t.label) ?? 0) + 1);
        switch (t.label) {
          case LabelExact:
          case LabelSplit:
          case LabelMerge:
            score++;
            break;
          case LabelReplace:
            score += 0.5;
            break;
          case LabelOmission:
            p.omitted = true;
            break;
        }
        if (!t.interpolated) p.allInterp = false;
      }
      p.confidence = round3(score / (p.tok1 - p.tok0));
      p.subtitle = cueOfPiece(cues, first.firstPiece);
    }
    [p.measuredFrom, p.measuredTo] = frames(toMs(p.start), toMs(p.end), fps);
    return p;
  });
}

/** frames 把毫秒起止换算成帧：起点走 beat.frameOf（全项目唯一的秒→帧换算），终点至少比起点多一帧。 */
function frames(startMs: number, endMs: number, fps: number): [number, number] {
  const start = frameOf(startMs / 1000, fps);
  const end = Math.max(frameOf(endMs / 1000, fps), start + 1);
  return [start, end];
}

export function round3(v: number): number {
  return goRound(v * 1000) / 1000;
}

/**
 * applyAdjustments 在实测结果之上叠加修正层，返回每个短语最终的帧区间与被修正过的短语。
 * 实测值本身不改：报告里同时给出实测帧与最终帧。
 */
export function applyAdjustments(
  phrases: PhraseTiming[],
  adjust: AdjustFile | null | undefined,
  totalFrames: number,
): { final: Map<string, [number, number]>; adjusted: Set<string> } {
  const final = new Map<string, [number, number]>();
  for (const p of phrases) final.set(p.span.id, [p.measuredFrom, p.measuredTo]);
  const adjusted = new Set<string>();
  if (!adjust) return { final, adjusted };
  const seen = new Set<string>();
  const problems: string[] = [];
  (adjust.adjustments ?? []).forEach((a, i) => {
    const where = `第 ${i + 1} 条修正（${a.phrase_id} ${a.edge}）`;
    const found = final.get(a.phrase_id);
    if (!found) {
      problems.push(where + '：终稿里没有这个短语');
      return;
    }
    if (a.edge !== 'start' && a.edge !== 'end') {
      problems.push(where + '：edge 只能是 start 或 end');
      return;
    }
    if (goTrimSpace(a.reason) === '') {
      problems.push(where + '：reason 不能为空，写清楚为什么不信实测');
      return;
    }
    if (seen.has(a.phrase_id + '\x00' + a.edge)) {
      problems.push(where + '：同一短语的同一边界重复修正');
      return;
    }
    seen.add(a.phrase_id + '\x00' + a.edge);
    // 起点必须是片内的帧；终点是开区间，最大可以等于总帧数。
    const limit = a.edge === 'end' ? totalFrames : totalFrames - 1;
    if (a.frame < 0 || a.frame > limit) {
      problems.push(`${where}：帧 ${a.frame} 超出 [0, ${limit}]（全片共 ${totalFrames} 帧）`);
      return;
    }
    const current: [number, number] = [found[0], found[1]];
    if (a.edge === 'start') current[0] = a.frame;
    else current[1] = a.frame;
    final.set(a.phrase_id, current);
    adjusted.add(a.phrase_id);
  });
  for (const p of phrases) {
    const r = final.get(p.span.id)!;
    if (adjusted.has(p.span.id) && r[0] >= r[1]) problems.push(`短语 ${p.span.id} 修正后起点帧 ${r[0]} 不早于终点帧 ${r[1]}`);
  }
  if (problems.length > 0) throw new Error(`修正文件不合格：\n  - ${problems.join('\n  - ')}`);
  return { final, adjusted };
}
