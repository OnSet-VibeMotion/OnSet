import path from 'node:path';
import { goQuote } from '../gofmt';
import { compareBytes } from '../gojson';
import type { StructType } from '../gojson/decode';
import { hasAnchors, loadAndResolveAnchors } from './anchors';
import { frameOf, type Grid, loadGrid, nearestBeat, totalFrames } from './grid';
import { cutFrames, layout, loadPlan, type Segment } from './plan';
import {
  ConfigFile,
  enabled,
  encodeJSON,
  GridFile,
  hashBytes,
  hashFile,
  localPath,
  PlanFile,
  wrapError,
} from './store';

/** CueDataFile 是写进每个镜头目录的局部节拍文件名。 */
export const CueDataFile = 'beat-cues.json';

/**
 * Cue 是 scene.json 的 beat 块：把镜头绑定到全局网格的某一段。
 * 路径相对镜头目录。
 */
export interface Cue {
  scene: string;
  first_bar: number;
  bars: number;
  fps: number;
  grid: string;
  sha256: string;
  start_frame: number;
  frames: number;
  data: string;
  data_sha256: string;
}

/** Cue 的解码描述，供 scene.json 的解码复用。 */
export const cueType: StructType = {
  kind: 'struct',
  goName: 'beat.Cue',
  name: 'Cue',
  fields: [
    ['scene', 'string'],
    ['first_bar', 'int'],
    ['bars', 'int'],
    ['fps', 'int'],
    ['grid', 'string'],
    ['sha256', 'string'],
    ['start_frame', 'int'],
    ['frames', 'int'],
    ['data', 'string'],
    ['data_sha256', 'string'],
  ],
};

/** 按 Go 的字段顺序构造 Cue 的 JSON 值。 */
export function cueToJSON(c: Cue): unknown {
  return {
    scene: c.scene,
    first_bar: c.first_bar,
    bars: c.bars,
    fps: c.fps,
    grid: c.grid,
    sha256: c.sha256,
    start_frame: c.start_frame,
    frames: c.frames,
    data: c.data,
    data_sha256: c.data_sha256,
  };
}

/** Local 是镜头局部的节拍表。帧号已减去镜头起点，渲染器直接按它编排。 */
export interface Local {
  fps: number;
  frames: number;
  first_bar: number;
  bars: number;
  beats: LocalHit[];
  /** 可选：从 production/beat/anchors.json 切片进本镜头的命名锚点局部帧号（local_frame = global_frame - start_frame）。 */
  anchors?: Record<string, number>;
}

/**
 * LocalHit 是镜头内的一拍。bar 是全曲小节编号（0 表示第一个重拍之前的弱起），
 * beat 是这一拍在小节内的序号，从 1 开始；beat == 1 即重拍。
 */
export interface LocalHit {
  frame: number;
  seconds: number;
  bar: number;
  beat: number;
  downbeat: boolean;
}

/** Slice 取出 [startFrame, startFrame+frames) 内的拍点，并在提供 anchors 时附带本镜头局部锚点帧号。 */
export function sliceGrid(g: Grid, segment: Segment, fps: number, anchors?: Record<string, number>): Local {
  const local: Local = {
    fps,
    frames: segment.frames,
    first_bar: segment.firstBar,
    bars: segment.bars,
    beats: [],
    ...(anchors !== undefined ? { anchors } : {}),
  };
  const beats = g.beats ?? [];
  const downIndex = new Set<number>();
  for (const d of g.downbeats ?? []) {
    const i = nearestBeat(beats, d);
    if (i >= 0) downIndex.add(i);
  }
  let bar = 0;
  let inBar = 0;
  beats.forEach((b, i) => {
    const isDown = downIndex.has(i);
    if (isDown) {
      bar++;
      inBar = 0;
    }
    inBar++;
    const frame = frameOf(b, fps) - segment.startFrame;
    if (frame < 0 || frame >= segment.frames) return;
    local.beats.push({ frame, seconds: frame / fps, bar, beat: inBar, downbeat: isDown });
  });
  return local;
}

function localToJSON(local: Local): unknown {
  const out: Record<string, unknown> = {
    fps: local.fps,
    frames: local.frames,
    first_bar: local.first_bar,
    bars: local.bars,
    beats: local.beats.map((h) => ({
      frame: h.frame,
      seconds: h.seconds,
      bar: h.bar,
      beat: h.beat,
      downbeat: h.downbeat,
    })),
  };
  if (local.anchors !== undefined) {
    const sorted = Object.create(null) as Record<string, number>;
    for (const key of Object.keys(local.anchors).sort(compareBytes)) sorted[key] = local.anchors[key];
    out.anchors = sorted;
  }
  return out;
}

/** EncodeLocal 返回局部节拍文件的字节与摘要。写盘与 Cue.data_sha256 用同一份字节。 */
export function encodeLocal(local: Local): { body: Buffer; sha256: string } {
  const body = encodeJSON(localToJSON(local));
  return { body, sha256: hashBytes(body) };
}

/** GridSHA 返回正式网格文件的摘要。 */
export function gridSHA(root: string): string {
  return hashFile(localPath(root, GridFile));
}

/**
 * VerifyCue 核对镜头的 beat 块仍与全局网格、分镜计划一致，且切点卡在重拍上。
 *
 * 切点是精确比对，不留容差：帧号只由 frameOf 一个公式算出，任何偏差都说明
 * 有人手改了镜头时长，而不是取整误差。成片里的 ±1 帧容差属于整片复查。
 *
 * 项目根从镜头目录向上找 beat.yaml 确定，不从 cue.grid 反推：反推的话，
 * 指向别的项目的 "../../other/production/beat/grid.json" 也能自洽通过。
 * cue 还带着镜头 id 与小节区间，复制别的镜头的 beat 块过来会被拦下。
 */
export function verifyCue(sceneDir: string, sceneID: string, cue: Cue, durationSeconds: number): void {
  const root = findRoot(sceneDir);
  const gridPath = path.join(root, GridFile);
  const want = gridRef(sceneDir, root);
  if (cue.grid !== want) throw new Error(`beat.grid 必须是指向本项目 ${GridFile} 的相对路径 ${goQuote(want)}`);
  if (cue.scene !== sceneID)
    throw new Error(`beat 块属于镜头 ${goQuote(cue.scene)}，不是 ${goQuote(sceneID)}：请重新运行 beat_cues()`);
  const grid = loadGrid(root);
  const sum = hashFile(gridPath);
  if (sum !== cue.sha256) throw new Error('节拍网格已变化，请重新运行 beat_cues() 并重渲染');
  if (cue.fps <= 0 || cue.frames <= 0 || cue.start_frame < 0) throw new Error('beat 块的帧率或帧区间无效');
  if (Math.abs(durationSeconds * cue.fps - cue.frames) > 1e-6) {
    throw new Error(`duration_seconds 与 beat 块的 ${cue.frames} 帧不符：镜头时长由 beat_cues() 写入，不要手改`);
  }
  const cuts = cutFrames(grid, cue.fps);
  const end = cue.start_frame + cue.frames;
  if (cue.start_frame !== 0 && !cuts.has(cue.start_frame))
    throw new Error(`镜头起点第 ${cue.start_frame} 帧不在任何重拍上`);
  if (end !== totalFrames(grid.duration_seconds, cue.fps) && !cuts.has(end)) {
    throw new Error(`镜头终点第 ${end} 帧不在任何重拍上，也不是音乐结尾`);
  }
  const { segment, segments } = segmentOf(root, grid, cue);
  let shotAnchors: Record<string, number> | undefined;
  if (hasAnchors(root)) {
    const resolved = loadAndResolveAnchors(root, grid, segments, cue.fps);
    shotAnchors = resolved.by_scene[cue.scene] ?? {};
  }
  const { sha256: expected } = encodeLocal(sliceGrid(grid, segment, cue.fps, shotAnchors));
  const dataPath = localPath(sceneDir, cue.data);
  let have: string;
  try {
    have = hashFile(dataPath);
  } catch (err) {
    throw wrapError(`找不到局部节拍文件：${(err as Error).message}`, err);
  }
  if (have !== cue.data_sha256 || have !== expected)
    throw new Error(`${cue.data} 与全局网格不一致，请重新运行 beat_cues()`);
}

/** segmentOf 从分镜计划里找回这个 cue 对应的镜头区间及全片布局。 */
function segmentOf(root: string, grid: Grid, cue: Cue): { segment: Segment; segments: Segment[] } {
  const plan = loadPlan(root);
  const segments = layout(grid, plan, cue.fps);
  for (const s of segments) {
    if (s.id === cue.scene) {
      if (
        s.startFrame !== cue.start_frame ||
        s.frames !== cue.frames ||
        s.firstBar !== cue.first_bar ||
        s.bars !== cue.bars
      ) {
        throw new Error(
          `镜头 ${s.id} 的区间与 ${PlanFile} 不符：计划第 ${s.firstBar} 小节起 ${s.bars} 小节（${s.startFrame}+${s.frames} 帧），beat 块第 ${cue.first_bar} 小节起 ${cue.bars} 小节（${cue.start_frame}+${cue.frames} 帧）`,
        );
      }
      return { segment: s, segments };
    }
  }
  throw new Error(`镜头 ${cue.scene} 不在 ${PlanFile} 里，请重新运行 beat_cues()`);
}

/** FindRoot 从 dir 向上找到含 beat.yaml 的项目根。 */
export function findRoot(dir: string): string {
  let current = path.resolve(dir);
  for (;;) {
    if (enabled(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`从 ${dir} 向上找不到 ${ConfigFile}`);
    current = parent;
  }
}

/** GridRef 是镜头目录引用正式网格时唯一合法的写法。 */
export function gridRef(sceneDir: string, root: string): string {
  const rel = path.relative(path.resolve(sceneDir), path.join(path.resolve(root), GridFile));
  return (rel === '' ? '.' : rel).split(path.sep).join('/');
}
