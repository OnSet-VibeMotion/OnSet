//
// Package dialogue 把分说话人合成的音频段装配成一条时间线。
//
// 为什么这一步在引擎而不在编排工具：分段 TTS 只给得到段内相对时间戳，
// 拼成全局时间轴要逐段累加偏移。算错的后果是成片画面正常、只是嘴和字对不上，
// 不会报错——这类会静默坏掉的机械计算一律收进 am。

/** SchemaVersion 是 plan.json 与 dialogue.json 共用的 schema 标识。 */
import { sliceOf, unmarshal, type StructType } from '../beat/jsondecode';

export const SchemaVersion = 'cast-dialogue/v1';

/** PlanLine 是一条字幕行，时间是相对本段起点的。 */
export interface PlanLine {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

/** PlanSegment 是一次 TTS 调用的产物：同一说话人的连续一段。 */
export interface PlanSegment {
  index: number;
  speaker: string;
  voiceId: string;
  audio: string;
  gapAfterMs: number;
  /** Go 的 nil 切片为 null。 */
  lines: PlanLine[] | null;
}

export interface Plan {
  schema: string;
  segments: PlanSegment[] | null;
}

/** Segment 是装配后的段，时间已是全局的。 */
export interface Segment {
  index: number;
  speaker: string;
  voiceId: string;
  audio: string;
  startSeconds: number;
  endSeconds: number;
  gapAfterMs: number;
}

/** Line 是装配后的字幕行。text 不进 dialogue.json：字幕正文的唯一真相是 SRT。 */
export interface Line {
  srtIndex: number;
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface Result {
  schema: string;
  segments: Segment[] | null;
  lines: Line[] | null;
}

/** totalSeconds 是最后一段的结束时间，不含尾部间隔。 */
export function totalSeconds(r: Result): number {
  const segments = r.segments ?? [];
  if (segments.length === 0) return 0;
  return segments[segments.length - 1].endSeconds;
}

/** 按 Go struct 字段顺序构造 plan.json 的 JSON 值。 */
export function planToJSON(p: Plan): unknown {
  return {
    schema: p.schema,
    segments:
      p.segments === null
        ? null
        : p.segments.map((s) => ({
            index: s.index,
            speaker: s.speaker,
            voiceId: s.voiceId,
            audio: s.audio,
            gapAfterMs: s.gapAfterMs,
            lines: s.lines === null ? null : s.lines.map((l) => ({ text: l.text, startSeconds: l.startSeconds, endSeconds: l.endSeconds })),
          })),
  };
}

/** 按 Go struct 字段顺序构造 dialogue.json 的 JSON 值（Line 的 text 是 json:"-"）。 */
export function resultToJSON(r: Result): unknown {
  return {
    schema: r.schema,
    segments:
      r.segments === null
        ? null
        : r.segments.map((s) => ({
            index: s.index,
            speaker: s.speaker,
            voiceId: s.voiceId,
            audio: s.audio,
            startSeconds: s.startSeconds,
            endSeconds: s.endSeconds,
            gapAfterMs: s.gapAfterMs,
          })),
    lines:
      r.lines === null
        ? null
        : r.lines.map((l) => ({ srtIndex: l.srtIndex, speaker: l.speaker, startSeconds: l.startSeconds, endSeconds: l.endSeconds })),
  };
}

const segmentType: StructType = {
  kind: 'struct',
  goName: 'dialogue.Segment',
  name: 'Segment',
  fields: [
    ['index', 'int'],
    ['speaker', 'string'],
    ['voiceId', 'string'],
    ['audio', 'string'],
    ['startSeconds', 'float'],
    ['endSeconds', 'float'],
    ['gapAfterMs', 'int'],
  ],
};

const lineType: StructType = {
  kind: 'struct',
  goName: 'dialogue.Line',
  name: 'Line',
  fields: [
    ['srtIndex', 'int'],
    ['speaker', 'string'],
    ['startSeconds', 'float'],
    ['endSeconds', 'float'],
  ],
};

const resultType: StructType = {
  kind: 'struct',
  goName: 'dialogue.Result',
  name: 'Result',
  fields: [
    ['schema', 'string'],
    ['segments', sliceOf(segmentType)],
    ['lines', sliceOf(lineType)],
  ],
};

/**
 * json.Unmarshal(body, &dialogue.Result)：读 dialogue.json。语法错误与类型错误的文案与 Go 一致；
 * Line.text 是 json:"-"，不从 JSON 读，恒为空串。
 */
export function unmarshalResult(body: string | Uint8Array): Result {
  const r = unmarshal<Result>(body, resultType);
  if (r.lines !== null) r.lines = r.lines.map((l) => ({ ...l, text: '' }));
  return r;
}
