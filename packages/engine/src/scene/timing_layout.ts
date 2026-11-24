// 由分镜计划锚点推导镜头全局帧区间与时长字面量。
import { frameOf } from '../frames';
import { formatFixed } from '../gofmt';
import type * as srt from '../srt';
import { CutMidGap, CutPrevEnd, type TimingPlan } from './timing_plan';
import type { PhraseTimeline } from './timing_types';

/** layoutTiming 算出的一个镜头区间（全局帧，左闭右开）。 */
export interface TimingSegment {
  id: string;
  dir: string;
  startFrame: number;
  endFrameExclusive: number;
}

/** 镜头的帧数。 */
export function segmentFrames(s: TimingSegment): number {
  return s.endFrameExclusive - s.startFrame;
}

/** 一个可作锚点的文字单位（一条字幕或一条短语），帧号是全局帧。 */
interface AnchorUnit {
  start: number;
  end: number;
  order: number;
}

/** 把字幕换成帧区间。秒到帧只经 frames.frameOf 一个公式。 */
function unitsFromCues(cues: readonly srt.Cue[], fps: number): AnchorUnit[] {
  return cues.map((c, i) => ({ start: frameOf(c.start_seconds, fps), end: frameOf(c.end_seconds, fps), order: i }));
}

/**
 * 按时间排序后紧挨在 target 之前的那个单位的结束帧；
 * target 是最早的单位时返回 null。
 */
function previousEnd(units: AnchorUnit[], target: number): number | null {
  const sorted = [...units].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].order === target) return i === 0 ? null : sorted[i - 1].end;
  }
  return null;
}

/**
 * 按切点规则算出镜头边界。前一个单位与锚点重叠（结束晚于锚点开始）
 * 时没有空白可分，三种规则都切在锚点开始处，保证锚点的文字不会落进上一个镜头。
 */
function cutFrame(rule: string, anchorStart: number, prevEnd: number | null): number {
  if (prevEnd === null || prevEnd >= anchorStart) return anchorStart;
  switch (rule) {
    case CutPrevEnd:
      return prevEnd;
    case CutMidGap:
      return Math.trunc((prevEnd + anchorStart) / 2);
    default:
      return anchorStart;
  }
}

/**
 * 由分镜计划的锚点推导每个镜头的全局帧区间。
 *
 * 第一个镜头从第 0 帧开始，最后一个镜头到 total 结束；其余边界由锚点与切点
 * 规则决定。锚点必须严格递增，每个镜头至少一帧，合计正好 total 帧。
 * phrases 为 null 时计划里不能出现 first_phrase。
 */
export function layoutTiming(
  plan: TimingPlan,
  cues: readonly srt.Cue[],
  phrases: PhraseTimeline | null,
  fps: number,
  total: number,
): TimingSegment[] {
  if (fps <= 0) throw new Error(`帧率必须是正整数，收到 ${fps}`);
  if (total <= 0) throw new Error(`总帧数必须是正整数，收到 ${total}`);
  if (phrases !== null && phrases.fps !== fps) throw new Error(`短语时间轴是 ${phrases.fps}fps，镜头是 ${fps}fps`);
  const subUnits = unitsFromCues(cues, fps);
  const phraseUnits: AnchorUnit[] = [];
  const phraseIndex = new Map<string, number>();
  if (phrases !== null) {
    (phrases.phrases ?? []).forEach((p, i) => {
      phraseUnits.push({ start: p.start_frame, end: p.end_frame_exclusive, order: i });
      phraseIndex.set(p.phrase_id, i);
    });
  }
  const scenes = plan.scenes ?? [];
  const boundaries = scenes.map(() => 0);
  let lastAnchor = -1;
  let lastAnchorName = '';
  for (let i = 0; i < scenes.length; i++) {
    const entry = scenes[i];
    let units: AnchorUnit[];
    let target: number;
    let name: string;
    if (entry.first_subtitle !== null) {
      const n = entry.first_subtitle;
      if (n < 1 || n > subUnits.length) {
        throw new Error(`镜头 ${entry.id} 的 first_subtitle ${n} 超出字幕范围（共 ${subUnits.length} 条）`);
      }
      units = subUnits;
      target = n - 1;
      name = `第 ${n} 条字幕`;
    } else if (entry.first_phrase !== '') {
      if (phrases === null) {
        throw new Error(`镜头 ${entry.id} 用短语 ${entry.first_phrase} 作锚点，但没有提供短语时间轴（--phrases）`);
      }
      const index = phraseIndex.get(entry.first_phrase);
      if (index === undefined)
        throw new Error(`镜头 ${entry.id} 的 first_phrase ${entry.first_phrase} 不在短语时间轴里`);
      units = phraseUnits;
      target = index;
      name = '短语 ' + entry.first_phrase;
    } else {
      // 只有第一个镜头可以不写锚点，parseTimingPlan 已保证。
      boundaries[i] = 0;
      continue;
    }
    const anchorStart = units[target].start;
    if (anchorStart <= lastAnchor) {
      throw new Error(
        `锚点必须严格递增：镜头 ${entry.id} 的${name}从第 ${anchorStart} 帧开始，不晚于上一个锚点${lastAnchorName}（第 ${lastAnchor} 帧）`,
      );
    }
    lastAnchor = anchorStart;
    lastAnchorName = name;
    if (i === 0) {
      boundaries[i] = 0;
      continue;
    }
    boundaries[i] = cutFrame(entry.cut, anchorStart, previousEnd(units, target));
  }
  const segments: TimingSegment[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const entry = scenes[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : total;
    if (end <= boundaries[i]) {
      if (i + 1 === boundaries.length) {
        throw new Error(`最后一个镜头 ${entry.id} 从第 ${boundaries[i]} 帧开始，不早于总帧数 ${total}：锚点超出了全片`);
      }
      throw new Error(`镜头 ${entry.id} 不足一帧：边界第 ${boundaries[i]} 帧到第 ${end} 帧，切点必须严格递增`);
    }
    segments.push({ id: entry.id, dir: entry.dir, startFrame: boundaries[i], endFrameExclusive: end });
  }
  const sum = segments.reduce((acc, s) => acc + segmentFrames(s), 0);
  if (sum !== total) throw new Error(`镜头帧数合计 ${sum}，不等于总帧数 ${total}`);
  return segments;
}

/**
 * 写进 scene.json 的 duration_seconds 字面量：帧数 ÷ 帧率，保留 6 位小数。
 * 6 位小数在常见帧率下离整数帧不到 1e-4 帧，round(时长 × 帧率) 总能还原帧数，
 * 也能通过 verifyFrameAlignment。
 */
export function durationLiteral(frames: number, fps: number): string {
  return formatFixed(frames / fps, 6);
}
