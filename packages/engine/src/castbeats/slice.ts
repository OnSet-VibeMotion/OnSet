// 移植自 internal/castbeats/slice.go。
//
// Package castbeats 把 production/dialogue.json 的全局台词时间线切成各镜头
// 的 cast.beats（镜头本地时间）。
//
// 为什么这一步在引擎而不在编排 agent：镜头怎么切是创作判断（每个镜头的
// duration_seconds 由 agent 定），但"给定 dialogue.json 与已定的镜头时长，
// 算出每个镜头的节拍"是纯机械计算——减错一个镜头起点，成片画面正常、
// 只是角色在不该说话的时候动嘴，不会报错。设计文档 §3.3 点名的就是这一类。
//
// 本包与 validate 的 cast.beats 覆盖校验是同一条累加规则的正反两
// 向，两边都走 schedule.plan + schedule.startOffsets，不各自累加一遍。
import type { Line } from '../dialogue';
import { goRound } from '../gofmt';
import type { Beat } from '../scene';

/**
 * 一拍能被写出去的最小长度。一行台词恰好止于镜头切点时，
 * 它与下一个镜头的重叠长度是 0（或浮点意义上的几个 ulp），凭空写出这么一拍
 * 会直接违反 scene.validateCast 的 start < end。
 *
 * 取 1 微秒：远大于浮点噪声，又远小于 validate 判定"这一行有没有被
 * 盖住"的 1 毫秒容差——被这条门槛丢掉的碎片不可能让覆盖校验翻车。
 */
export const minBeatSeconds = 1e-6;

/**
 * 写进 scene.json 的时间精度（微秒）。dialogue.json 的时间戳是
 * 按实测时长等比缩放算出来的，直接相减会留下 0.30000000000000004 这类浮点
 * 尘；对齐到微秒既让文件可读，也让"同样的输入重跑一次得到同样的字节"这条
 * 幂等性不依赖浮点运算的位级可重复性。
 */
const roundGrid = 1e6;

/**
 * 把全局台词行切进各镜头，返回与镜头一一对应的镜头本地节拍，以及
 * 没有被镜头完整盖住的台词行下标。
 *
 * offsets[i] 是第 i 个镜头的全局起点（来自 schedule.startOffsets），
 * durations[i] 是它的时长。两者长度必须一致。
 *
 * 说话人在不在 on_stage 里，这里一概不问：一拍的含义是"这段时间这个人在
 * 说话"，不蕴含"他被画出来"。画外音的台词同样要出现在节拍里，否则
 * am validate cast 会报这一行没被覆盖。
 *
 * 返回的 beats[i] 为 null 表示该镜头没有节拍（Go 的 nil 切片）。
 */
export function slice(
  lines: readonly Pick<Line, 'speaker' | 'startSeconds' | 'endSeconds'>[],
  offsets: readonly number[],
  durations: readonly number[],
): { beats: (Beat[] | null)[]; uncovered: number[] } {
  const beats: (Beat[] | null)[] = offsets.map(() => null);
  const uncovered: number[] = [];
  lines.forEach((l, index) => {
    let covered = 0;
    for (let i = 0; i < offsets.length; i++) {
      const sceneStart = offsets[i];
      const sceneEnd = sceneStart + durations[i];
      const start = Math.max(l.startSeconds, sceneStart);
      const end = Math.min(l.endSeconds, sceneEnd);
      if (end - start < minBeatSeconds) continue;
      covered += end - start;
      const localStart = clamp(round(start - sceneStart), 0, durations[i]);
      const localEnd = clamp(round(end - sceneStart), 0, durations[i]);
      if (localEnd - localStart <= 0) {
        // 对齐到微秒后塌成了零长度：写出去会被 validateCast 拒绝，
        // 而它对覆盖判定的影响远在 1 毫秒容差之内。
        continue;
      }
      (beats[i] ??= []).push({ speaker: l.speaker, start: localStart, end: localEnd });
    }
    if (covered < l.endSeconds - l.startSeconds - minBeatSeconds) uncovered.push(index);
  });
  return { beats, uncovered };
}

function round(value: number): number {
  return goRound(value * roundGrid) / roundGrid;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
