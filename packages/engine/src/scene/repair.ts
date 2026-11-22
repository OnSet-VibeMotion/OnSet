import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTree } from '../fsutil';
import { formatFixed } from '../gofmt';
import { contactSheetImages, type Toolchain } from '../mediaprobe';
import { compareProtectedFrames, type FrameWindow } from '../mediaprobe/frame-window';
import { attemptLog } from './attempt';
import { RenderHandoffMessage } from './resume';
import { contained, outputPath, sceneCanvas, stderrLog, streamLog, userLog, type Scene } from './scene';
import { VerificationError } from './verification';

export interface RepairIssue extends FrameWindow {
  problem: string;
  acceptance: string;
  evidence_frame?: number;
}

export interface RepairContext {
  issues: RepairIssue[];
  evidence: string;
  baseline: string;
}

/** Read a compact, local-frame repair brief. It must leave at least one protected frame. */
export function parseRepairIssues(value: unknown, frames: number): RepairIssue[] {
  const list = (value as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(list) || !list.length) throw new Error('返修单需要非空的 issues 数组');
  const issues: RepairIssue[] = list.map((x, i) => {
    const { start_frame, end_frame_exclusive, problem, acceptance, evidence_frame } = x ?? {};
    if (!Number.isSafeInteger(start_frame) || !Number.isSafeInteger(end_frame_exclusive) ||
        start_frame < 0 || start_frame >= end_frame_exclusive || end_frame_exclusive > frames) {
      throw new Error(`问题 ${i + 1} 的局部帧区间必须满足 0 ≤ start_frame < end_frame_exclusive ≤ ${frames}`);
    }
    if (typeof problem !== 'string' || !problem.trim() || typeof acceptance !== 'string' || !acceptance.trim()) {
      throw new Error(`问题 ${i + 1} 需要 problem 与 acceptance`);
    }
    if (evidence_frame !== undefined && (!Number.isSafeInteger(evidence_frame) ||
      evidence_frame < start_frame || evidence_frame >= end_frame_exclusive)) {
      throw new Error(`问题 ${i + 1} 的 evidence_frame 必须位于该问题区间内`);
    }
    return { start_frame, end_frame_exclusive, problem: problem.trim(), acceptance: acceptance.trim(), evidence_frame };
  });
  let covered = 0;
  for (const issue of [...issues].sort((a, b) => a.start_frame - b.start_frame)) {
    if (issue.start_frame > covered) break;
    covered = Math.max(covered, issue.end_frame_exclusive);
  }
  if (covered === frames) throw new Error('返修单覆盖整个镜头，请用 scene_run()；局部返修必须留下要保护的画面');
  return issues;
}

export function repairPrompt(s: Scene, repair: RepairContext): string {
  const { fps, widthPx, heightPx } = sceneCanvas(s);
  const frames = Math.round(s.duration_seconds * fps);
  const samples = [...new Set(repair.issues.flatMap(x => [
    x.start_frame, Math.floor((x.start_frame + x.end_frame_exclusive - 1) / 2), x.end_frame_exclusive - 1,
  ]))].sort((a, b) => a - b);
  return [
    `局部返修 ${s.id}（${widthPx}×${heightPx}，${fps}fps，${frames} 帧，无音轨）。保留现有合成、节拍和执行契约。`,
    `问题证据图：${repair.evidence}。按需要读取 index.html 入口和涉及的代码段，用局部 edit 修复。`,
    ...repair.issues.map((x, i) => `${i + 1}. 局部帧 [${x.start_frame}, ${x.end_frame_exclusive})。问题：${x.problem}\n   通过条件：${x.acceptance}`),
    '保护所有区间外画面。保持使用已有组件、图片、字体和时间数据。无需重新选风格、查整片素材或重读普通技能文档。',
    `修完调用 scene_preview_check()，把受影响区间内的首尾和稳定帧分组检查。首组可取 frames="${samples.slice(0, 9).join(',')}"。查看联系表，核对上述通过条件。`,
    '片场负责出片和逐帧检查区间外画面。画面自查通过后单独输出下面这一行：',
    `[[USER_MESSAGE]]${RenderHandoffMessage}`,
  ].join('\n') + '\n';
}

/** Preserve the composition, output and render record while keeping the attempt and its usage on rollback. */
export async function withRepairBackup<T>(s: Scene, fn: (baseline: string) => Promise<T>): Promise<T> {
  const output = outputPath(s);
  const original = fs.lstatSync(output, { throwIfNoEntry: false });
  if (!original?.isFile()) throw new Error('局部返修需要已有的普通视频文件');
  let parent = s.directory;
  for (const part of path.relative(s.directory, path.dirname(output)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    if (fs.lstatSync(parent).isSymbolicLink()) throw new Error(`局部返修的输出路径不能经过符号链接：${parent}`);
  }
  // Keep the backup outside the writable renderer workspace.
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-repair-backup-'));
  const excluded = new Set(['.onset', '.hyperframes', '.onset-render-leases', 'attempts',
    ...[attemptLog(s), streamLog(s), stderrLog(s), userLog(s)].map(file => path.basename(file))]);
  const list = () => fs.readdirSync(s.directory).filter(name => !excluded.has(name));
  const copy = (from: string, to: string) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  const baseline = path.join(backup, path.relative(s.directory, output));
  let safeToDelete = false;
  let renderStarted = false;
  try {
    for (const name of list()) copy(path.join(s.directory, name), path.join(backup, name));
    if (!fs.existsSync(baseline)) throw new Error('局部返修无法备份原视频位置');
    renderStarted = true;
    try {
      const result = await fn(baseline);
      safeToDelete = true;
      return result;
    } catch (failure) {
      try {
        for (const name of list()) removeTree(path.join(s.directory, name));
        for (const name of fs.readdirSync(backup)) copy(path.join(backup, name), path.join(s.directory, name));
        safeToDelete = true;
      } catch (restoreFailure) {
        throw new Error(`返修失败且恢复未完成，原始备份保留在 ${backup}：${(restoreFailure as Error).message}`, { cause: failure });
      }
      throw failure;
    }
  } finally {
    if (!renderStarted || safeToDelete) removeTree(backup);
  }
}

export async function prepareRepairEvidence(s: Scene, issues: RepairIssue[], toolchain: Toolchain, signal?: AbortSignal): Promise<string> {
  if (fs.lstatSync(path.join(s.directory, '.onset'), { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('返修证据目录不能经过符号链接');
  }
  const parent = contained(s.directory, '.onset', '返修证据目录');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'repair-'));
  const fps = sceneCanvas(s).fps;
  const samples = [...new Set(issues.map(i => i.evidence_frame ?? Math.floor((i.start_frame + i.end_frame_exclusive - 1) / 2)))].slice(0, 9);
  const stills = samples.map(frame => {
    signal?.throwIfAborted();
    const png = path.join(dir, `frame-${frame}.png`);
    toolchain.extractFrame(outputPath(s), frame / fps, png);
    return png;
  });
  const evidence = path.join(dir, 'evidence.png');
  if (stills.length === 1) fs.renameSync(stills[0]!, evidence);
  else await contactSheetImages(toolchain, stills, evidence, signal);
  return path.relative(s.directory, evidence).split(path.sep).join('/');
}

export async function verifyRepair(s: Scene, repair: RepairContext, toolchain: Toolchain, signal?: AbortSignal): Promise<void> {
  const changed = await compareProtectedFrames(toolchain, repair.baseline, outputPath(s), repair.issues, 8, signal);
  if (changed) throw new VerificationError(s.output, [
    `第 ${changed.frame} 帧不在返修区间，但画面发生变化（局部差异 ${formatFixed(changed.difference, 1)}）`,
  ], ['repair.keep']);
}
