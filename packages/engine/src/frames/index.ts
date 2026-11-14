/**
 * 全片唯一的「秒 → 帧」换算与总帧数。切点、拍点、短语帧号与成片总帧数都走这里：
 * 两处取整方式不同，画面与声音会慢慢错开。不属于任何一个功能（卡点、对齐、镜头时间合同都用它）。
 */
import { goRound } from '../gofmt';

/** FrameOf 是全片唯一的「秒 → 帧」换算。切点、拍点帧号都走它。 */
export function frameOf(seconds: number, fps: number): number {
  // + 0 把 -0 变成 0：Go 的 int 没有负零，写进 JSON 时不能出现 -0。
  return goRound(seconds * fps) + 0;
}

/** TotalFrames 是覆盖整首音乐所需的帧数：最后不足一帧也要占一帧，与成片封装一致。 */
export function totalFrames(duration: number, fps: number): number {
  return Math.ceil(duration * fps - 1e-9) + 0;
}
