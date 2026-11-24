import type { BeatGrid } from '../../types';

/** 与 beat/grid.ts 的 downbeatMatch 相同：重拍对齐到普通拍的容差。 */
export const match = 0.002;
export const meterChoices = [2, 3, 4, 6, 8];
export const steps = ['故事与文案', '导入音乐', '分析节拍', '试听确认', '分镜计划', '做镜头'];

export interface Bar {
  number: number;
  start: number;
  end: number;
  beats: number;
}

export function clock(seconds: number, digits = 1): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(digits).padStart(digits > 0 ? 3 + digits : 2, '0')}`;
}

/** 第一个不小于 x 的下标。 */
export function lowerBound(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function barsOf(grid: { beats: number[]; downbeats: number[]; duration_seconds: number }): Bar[] {
  return grid.downbeats.map((start, i) => {
    const end = i + 1 < grid.downbeats.length ? grid.downbeats[i + 1] : grid.duration_seconds;
    const count = lowerBound(grid.beats, end - match) - lowerBound(grid.beats, start - match);
    return { number: i + 1, start, end, beats: count };
  });
}

/** 最常见的每小节拍数（最后一小节常被结尾截断，不算）与第一个重拍在普通拍里的位置。 */
export function detectMeter(grid: BeatGrid): { meter: number; anchor: number } {
  const bars = barsOf(grid);
  const counts = new Map<number, number>();
  bars.slice(0, -1).forEach((b) => counts.set(b.beats, (counts.get(b.beats) ?? 0) + 1));
  let meter = 4;
  let best = 0;
  for (const [m, n] of counts) {
    if (m >= 1 && m <= 16 && n > best) {
      meter = m;
      best = n;
    }
  }
  const first = grid.downbeats.length > 0 ? lowerBound(grid.beats, grid.downbeats[0] - match) : 0;
  return { meter, anchor: Math.min(first % meter, Math.max(0, grid.beats.length - 1)) };
}

/** 与 beat.regrid 相同：从第 anchor 拍（从 0 数）起每 meter 拍一个重拍。 */
export function regridDownbeats(beats: number[], meter: number, anchor: number): number[] {
  const out: number[] = [];
  for (let i = anchor; i < beats.length; i += meter) out.push(beats[i]);
  return out;
}

export function sameTimes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= match);
}

export function bpmOf(beats: number[]): number {
  if (beats.length < 2) return 0;
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
  intervals.sort((a, b) => a - b);
  return 60 / intervals[Math.floor(intervals.length / 2)];
}

/** 把故事稿的一级标题拆出来自己排版（对话里的 Markdown 会把标题降级）。 */
export function splitTitle(md: string): { title: string; body: string } {
  const m = /^\s*#\s+(.+)\n?/.exec(md);
  return m ? { title: m[1].trim(), body: md.slice(m[0].length) } : { title: '', body: md };
}
