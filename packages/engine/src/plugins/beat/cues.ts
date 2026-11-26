/**
 * 卡点的镜头布局对齐、覆盖校验与原子落盘写入。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as beat from '../../beat';
import { goPathError, goQuote } from '../../gofmt';
import { marshal } from '../../gojson';
import { decodeRawMap, encodeRawMapIndent } from '../../rawjson';
import type { Scene } from '../../scene';
import * as scene from '../../scene';
import * as schedule from '../../schedule';
import { beatBlock, verifyBeatInputs } from './block';

/** beatLayout 对齐分镜计划与镜头目录，返回每个镜头的帧区间。 */
function beatLayout(
  root: string,
  scenes: readonly Scene[],
): { grid: beat.Grid; segments: beat.Segment[]; fps: number } {
  const grid = beat.loadGrid(root);
  const plan = beat.loadPlan(root);
  const canvas = scene.canvasOf(root, 'frame.md');
  const segments = beat.layout(grid, plan, canvas.fps);
  if (segments.length !== scenes.length)
    throw new Error(`${beat.PlanFile} 有 ${segments.length} 个镜头，镜头目录有 ${scenes.length} 个`);
  const mismatched: string[] = [];
  scenes.forEach((s, i) => {
    if (s.id !== segments[i].id) mismatched.push(`第 ${i + 1} 个：计划 ${segments[i].id}，目录 ${s.id}`);
    const others = scene.sceneBlocks().filter((b) => b.key !== beatBlock.key && scene.blockValue(s, b.key) !== null);
    if (others.length > 0) throw new Error(`卡点镜头 ${s.id} 不能带 ${others.map((b) => b.key).join('、')} 块`);
  });
  if (mismatched.length > 0)
    throw new Error(`镜头顺序与 ${beat.PlanFile} 不一致（目录按字典序）：${mismatched.join('；')}`);
  return { grid, segments, fps: canvas.fps };
}

/** beatCoverage 校验全部镜头都带着与网格、计划一致的 beat 块，且首尾相接覆盖整首音乐。 */
export function beatCoverage(root: string, scenes: readonly Scene[]): void {
  const { segments } = beatLayout(root, scenes);
  const problems: string[] = [];
  scenes.forEach((s, i) => {
    const segment = segments[i];
    if (s.beat === null) {
      problems.push(`${s.id} 缺少 beat 块`);
      return;
    }
    if (s.beat.start_frame !== segment.startFrame || s.beat.frames !== segment.frames) {
      problems.push(
        `${s.id} 的帧区间与计划不符：beat 块 ${s.beat.start_frame}+${s.beat.frames}，计划 ${segment.startFrame}+${segment.frames}`,
      );
      return;
    }
    try {
      verifyBeatInputs(s);
    } catch (err) {
      problems.push(`${s.id}：${(err as Error).message}`);
    }
  });
  if (problems.length > 0)
    throw new Error(`卡点镜头校验未通过，改过网格或计划后请重新 beat_cues()：\n  - ${problems.join('\n  - ')}`);
}

interface PendingWrite {
  path: string;
  body: Buffer;
}

export interface ApplyBeatCuesResult {
  scenes: number;
  anchors?: beat.ResolvedAnchorTable;
}

export function applyBeatCues(root: string, scenesRoot: string): ApplyBeatCuesResult {
  const scenes = schedule.plan(scenesRoot);
  const { grid, segments, fps } = beatLayout(root, scenes);
  const resolvedAnchors = beat.hasAnchors(root) ? beat.loadAndResolveAnchors(root, grid, segments, fps) : undefined;
  const absRoot = path.resolve(root);
  const gridSHA = beat.gridSHA(root);
  const writes: PendingWrite[] = [];
  scenes.forEach((s, i) => {
    // 镜头目录向上找到的项目根必须就是本次的 --project-root，否则写出的
    // 引用在渲染时会指向另一个项目的网格。
    let found = '';
    let failed = false;
    try {
      found = beat.findRoot(s.directory);
    } catch {
      failed = true;
    }
    if (failed || found !== absRoot) {
      throw new Error(`镜头 ${s.id} 不在项目 ${absRoot} 之内（向上找到的 ${beat.ConfigFile} 根是 ${goQuote(found)}）`);
    }
    const gridRef = beat.gridRef(s.directory, absRoot);
    const segment = segments[i];
    const shotAnchors = resolvedAnchors ? (resolvedAnchors.by_scene[s.id] ?? {}) : undefined;
    const { body: data, sha256: dataSHA } = beat.encodeLocal(beat.sliceGrid(grid, segment, fps, shotAnchors));
    const cue: beat.Cue = {
      scene: s.id,
      first_bar: segment.firstBar,
      bars: segment.bars,
      fps,
      grid: gridRef,
      sha256: gridSHA,
      start_frame: segment.startFrame,
      frames: segment.frames,
      data: beat.CueDataFile,
      data_sha256: dataSHA,
    };
    const sceneFile = path.join(s.directory, 'scene.json');
    let raw: string;
    try {
      raw = fs.readFileSync(sceneFile, 'utf8');
    } catch (err) {
      throw new Error(goPathError('open', sceneFile, err), { cause: err });
    }
    let fields: Map<string, string>;
    try {
      fields = decodeRawMap(raw);
    } catch (err) {
      throw new Error(`${sceneFile} 不是合法 JSON：${(err as Error).message}`, { cause: err });
    }
    fields.set('beat', marshal(beat.cueToJSON(cue)));
    fields.set('duration_seconds', marshal(segment.frames / fps));
    const body = encodeRawMapIndent(fields);
    writes.push(
      { path: path.join(s.directory, beat.CueDataFile), body: data },
      { path: sceneFile, body: Buffer.from(body + '\n') },
    );
  });
  commitWrites(writes);
  return { scenes: scenes.length, ...(resolvedAnchors ? { anchors: resolvedAnchors } : {}) };
}

/**
 * commitWrites 分两轮落盘：先把每份新内容写成同目录的临时文件，全部成功后
 * 再逐个改名替换。磁盘满、权限不足这类错误都发生在第一轮，此时一个目标文件
 * 都还没动；第二轮只剩同文件系统内的 rename。rename 本身仍可能中途失败，
 * 那时 onset validate beat 会按网格摘要把没换上的镜头报出来。
 *
 * 内容不变的文件不重写：run-all 靠 scene.json 的修改时间判断产物是否过期，
 * 无变化的重跑不能把所有镜头都标成需要重渲染。
 */
function commitWrites(writes: readonly PendingWrite[]): void {
  const ready: { temp: string; path: string }[] = [];
  const cleanup = () => {
    for (const s of ready) fs.rmSync(s.temp, { force: true });
  };
  for (const w of writes) {
    try {
      if (fs.readFileSync(w.path).equals(w.body)) continue;
    } catch {
      // 不存在：照常写。
    }
    const temp = path.join(path.dirname(w.path), '.' + path.basename(w.path) + '.' + crypto.randomInt(1e9));
    try {
      fs.writeFileSync(temp, w.body, { flag: 'wx', mode: 0o600 });
      fs.chmodSync(temp, 0o644);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      cleanup();
      throw new Error(goPathError('open', temp, err), { cause: err });
    }
    ready.push({ temp, path: w.path });
  }
  for (let i = 0; i < ready.length; i++) {
    try {
      fs.renameSync(ready[i].temp, ready[i].path);
    } catch (err) {
      for (const rest of ready.slice(i)) fs.rmSync(rest.temp, { force: true });
      throw new Error(
        `写入 ${ready[i].path} 失败，部分镜头可能仍是旧网格，请重跑 beat_cues()：${(err as Error).message}`,
        { cause: err },
      );
    }
  }
}
