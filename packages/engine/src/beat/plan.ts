// 移植自 internal/beat/plan.go。
import fs from 'node:fs';
import { goQuote, goTrimSpace } from '../gofmt';
import { sliceOf, type StructType } from './jsondecode';
import { frameOf, totalFrames, type Grid } from './grid';
import { PlanFile, localPath, readJSON } from './store';

/**
 * Plan 是按小节写的分镜：每个镜头占连续几个小节。镜头时长只能这样表达，
 * 不接受秒数——写秒数就有可能写出不在重拍上的切点。
 */
export interface Plan {
  schema: number;
  scenes: PlannedShot[] | null;
}

/** PlannedShot 是计划里的一个镜头。 */
export interface PlannedShot {
  id: string;
  bars: number;
}

const plannedShotType: StructType = {
  kind: 'struct',
  goName: 'beat.PlannedShot',
  name: 'PlannedShot',
  fields: [
    ['id', 'string'],
    ['bars', 'int'],
  ],
};

const planType: StructType = {
  kind: 'struct',
  goName: 'beat.Plan',
  name: 'Plan',
  fields: [
    ['schema', 'int'],
    ['scenes', sliceOf(plannedShotType)],
  ],
};

/**
 * Segment 是换算到帧之后的镜头：成片里从 startFrame 起共 frames 帧，
 * 覆盖第 firstBar 起的 bars 个小节（小节编号从 1 开始）。
 */
export interface Segment {
  id: string;
  firstBar: number;
  bars: number;
  startFrame: number;
  frames: number;
}

/** LoadPlan 读取分镜计划。 */
export function loadPlan(root: string): Plan {
  const file = localPath(root, PlanFile);
  if (!fs.existsSync(file)) throw new Error(`还没有分镜计划 ${PlanFile}：按小节为每个镜头写 {"id", "bars"}`);
  return readJSON<Plan>(file, planType);
}

/**
 * Layout 把分镜计划换算成整数帧的镜头区间。
 *
 * 第一个重拍之前的弱起并进第一个镜头，最后一小节延伸到音乐结束；除此之外
 * 每个切点都是某个重拍的帧号。小节总数必须与网格一致：少了是音乐末尾没有
 * 画面，多了是画面超出音乐。
 */
export function layout(g: Grid, p: Plan, fps: number): Segment[] {
  if (fps <= 0) throw new Error(`帧率必须为正，收到 ${fps}`);
  const scenes = p.scenes ?? [];
  if (p.schema !== 1 || scenes.length === 0) throw new Error(`${PlanFile}：schema 必须为 1 且至少有一个镜头`);
  const seen = new Set<string>();
  let total = 0;
  for (const shot of scenes) {
    if (goTrimSpace(shot.id) === '' || seen.has(shot.id)) throw new Error(`${PlanFile}：镜头 id 缺失或重复：${goQuote(shot.id)}`);
    seen.add(shot.id);
    if (shot.bars < 1) throw new Error(`${PlanFile}：镜头 ${shot.id} 至少占 1 小节，收到 ${shot.bars}`);
    total += shot.bars;
  }
  const downbeats = g.downbeats ?? [];
  const bars = downbeats.length;
  if (total !== bars) {
    throw new Error(`${PlanFile} 的小节合计 ${total}，与节拍网格的 ${bars} 小节不符：每个小节都必须恰好属于一个镜头`);
  }
  const end = totalFrames(g.duration_seconds, fps);
  const segments: Segment[] = [];
  let firstBar = 1;
  let start = 0;
  scenes.forEach((shot, i) => {
    let next = end;
    if (i + 1 < scenes.length) next = frameOf(downbeats[firstBar - 1 + shot.bars], fps);
    if (next <= start) throw new Error(`镜头 ${shot.id} 在 ${fps}fps 下不足一帧：相邻重拍太近，合并进相邻镜头`);
    segments.push({ id: shot.id, firstBar, bars: shot.bars, startFrame: start, frames: next - start });
    firstBar += shot.bars;
    start = next;
  });
  return segments;
}

/** CutFrames 返回全部合法切点帧号：每个重拍一帧。切点不在其中即为没卡上点。 */
export function cutFrames(g: Grid, fps: number): Set<number> {
  return new Set((g.downbeats ?? []).map((d) => frameOf(d, fps)));
}
