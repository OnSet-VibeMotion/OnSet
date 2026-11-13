// 移植自 internal/memory/importer.go。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatFixed } from '../gofmt';
import { compareBytes } from '../gojson';
import * as reads from '../reads';
import { handoffBroken } from '../review';
import {
  attemptLog,
  CheckOutputDuration,
  CheckOutputFrames,
  CheckReviewHandoff,
  classifyOutputProblem,
  DeterminismCheckPrefix,
  load as loadScene,
  newAttempt,
  OutcomeInterrupted,
  OutcomeVerificationFailed,
  parseAttempt,
  ReadsCheckPrefix,
  RecordFile,
  VerificationError,
  verifyOutput,
  type Attempt,
  type Scene,
} from '../scene';
import { detectModel } from '../tools';
import type { Finding } from './checks';
import { newEpisode, saveEpisode, SourceRender, type Episode } from './episode';
import { EventEpisode } from './events';
import { features } from './features';
import { copyFile, readDirSorted, walkDir } from './io';
import type { Store } from './store';

/** 导入历史项目的设置。 */
export interface ImportOptions {
  /** 调用 ffprobe 重新校验归档产物时用的环境。 */
  env?: Record<string, string>;
  /** 重新校验时长的容差，同 am scene run 的 --duration-tolerance。 */
  tolerance?: number;
  /** 归档里读不出渲染工具时的兜底（项目配置的 RENDERER）。 */
  renderer?: string;
}

/** 一个项目的导入结果。 */
export interface ImportResult {
  project: string;
  run: string;
  scenes: number;
  attempts: number;
  failures: number;
  checks: number;
  skipped: number;
  notes: string[] | null;
}

export function importResultToJSON(r: ImportResult): Record<string, unknown> {
  return {
    project: r.project,
    run: r.run,
    scenes: r.scenes,
    attempts: r.attempts,
    failures: r.failures,
    checks: r.checks,
    skipped: r.skipped,
    notes: r.notes && r.notes.length > 0 ? r.notes : undefined,
  };
}

/** 一个镜头的一次历史尝试，按时间先后排序后决定谁是首次尝试。 */
interface ImportedAttempt {
  /** 排序键：归档编号在前，当前尝试在最后。 */
  order: string;
  /** 原始路径，用于去重。 */
  source: string;
  attempt: Attempt;
}

const archiveNumber = /attempt-([0-9]+)/;
const failedPrefix = /^(.+?)-attempt-([0-9]+)/;

function addNote(result: ImportResult, note: string): void {
  result.notes = [...(result.notes ?? []), note];
}

/**
 * 把一个已有项目的渲染历史导入为经历，作为种子：
 *
 *   - 镜头目录里的 render-<id>.attempt.json 与 attempts/attempt-NN/ 下归档的尝试；
 *   - 只有产物没有尝试记录的归档（老版本 am 留下的，含 production/failed-attempts/<镜头>-attempt-NN-*）
 *     用现在的产物校验重新判一遍，只记失败——通过的归档说不清当时为什么被换掉；
 *   - production/review/review.json 里没接上的交接；
 *   - production/visible-event-inventory.json（schema 1）的阅读时间问题。
 *
 * 每个镜头最早的一次尝试算首次尝试，其余算重试，批次编号是 import:<项目名>，
 * am memory report 里能看到这些项目当时的一次通过率。冻结的输入是镜头现在的输入，
 * 不是当时的——历史输入没有留存。同一个来源重复导入时跳过。
 */
export function importProject(s: Store, rootDir: string, opts: ImportOptions): ImportResult {
  const root = path.resolve(rootDir);
  const project = path.basename(root);
  const result: ImportResult = { project, run: 'import:' + project, scenes: 0, attempts: 0, failures: 0, checks: 0, skipped: 0, notes: null };
  const imported = new Set<string>();
  for (const e of s.episodes()) if (e.imported !== '') imported.add(e.imported);
  const scenes = discoverScenes(root);
  result.scenes = scenes.length;
  const byID = new Map<string, Scene>();
  const failedDir = path.join(root, 'production', 'failed-attempts');
  const failedArchives = new Map<string, string[]>();
  for (const entry of readDirSorted(failedDir) ?? []) {
    const m = failedPrefix.exec(entry.name);
    if (entry.isDirectory() && m !== null) failedArchives.set(m[1], [...(failedArchives.get(m[1]) ?? []), path.join(failedDir, entry.name)]);
  }
  for (const sc of scenes) {
    byID.set(sc.id, sc);
    const attempts: ImportedAttempt[] = [];
    const archiveRoot = path.join(sc.directory, 'attempts');
    const archives = (readDirSorted(archiveRoot) ?? []).filter((e) => e.name.startsWith('attempt-')).map((e) => path.join(archiveRoot, e.name));
    archives.push(...(failedArchives.get(sc.id) ?? []));
    for (const dir of archives) {
      let order = '0';
      const m = archiveNumber.exec(path.basename(dir));
      if (m !== null) order = String(Number(m[1])).padStart(6, '0');
      if (dir.startsWith(failedDir)) order = '-' + order; // 老版本的失败归档早于 attempts/ 里的
      const loaded = loadArchivedAttempt(sc, dir, opts);
      if (loaded.note !== '') addNote(result, loaded.note);
      if (loaded.attempt === null) {
        result.skipped++;
        continue;
      }
      attempts.push({ order, source: dir, attempt: loaded.attempt });
    }
    const current = readAttempt(attemptLog(sc));
    if (current !== null) attempts.push({ order: 'z', source: attemptLog(sc), attempt: current });
    attempts.sort((a, b) => compareBytes(a.order, b.order));
    for (let i = 0; i < attempts.length; i++) {
      const item = attempts[i];
      item.attempt.retry = i > 0;
      const key = item.source + '#' + item.attempt.started_at;
      if (imported.has(key)) {
        result.skipped++;
        continue;
      }
      if (item.attempt.renderer === '') item.attempt.renderer = sc.renderer || opts.renderer || '';
      if ((item.attempt.checks?.length ?? 0) !== (item.attempt.problems?.length ?? 0)) item.attempt.checks = classifyProblems(item.attempt.problems ?? []);
      recordImported(s, sc, item.attempt, result.run, key);
      imported.add(key);
      result.attempts++;
      if (item.attempt.outcome === OutcomeVerificationFailed) result.failures++;
    }
  }
  const checks = importProjectChecks(s, root, byID, result);
  result.checks += checks;
  s.log({
    time: '',
    type: EventEpisode,
    summary: `导入项目 ${project}：${result.scenes} 个镜头、${result.attempts} 次尝试（${result.failures} 次校验失败）、${result.checks} 条事后检查问题`,
    project,
    detail: { import: importResultToJSON(result) },
  });
  return result;
}

function recordImported(s: Store, sc: Scene, attempt: Attempt, run: string, key: string): Episode {
  let list: string[] | null;
  try {
    list = features(sc);
  } catch {
    list = null;
  }
  return saveEpisode(
    s,
    sc,
    newEpisode({
      source: SourceRender,
      scene_id: sc.id,
      text: sc.text,
      renderer: attempt.renderer,
      model: attempt.model,
      fingerprint: attempt.fingerprint,
      outcome: attempt.outcome,
      retry: attempt.retry,
      seconds: attempt.seconds,
      usage: attempt.usage,
      error: attempt.error,
      problems: attempt.problems,
      checks: attempt.checks,
      features: list,
      run,
      imported: key,
    }),
  );
}

function readAttempt(file: string): Attempt | null {
  let attempt: Attempt;
  try {
    attempt = parseAttempt(fs.readFileSync(file));
  } catch {
    return null;
  }
  return attempt.outcome === '' ? null : attempt;
}

/**
 * 读出一个归档目录里的尝试：有尝试记录就用记录；
 * 只有产物时用现在的校验重判，通过的不算（attempt 为 null）。
 */
function loadArchivedAttempt(sc: Scene, dir: string, opts: ImportOptions): { attempt: Attempt | null; note: string } {
  const recorded = readAttempt(path.join(dir, 'render-' + sc.id + '.attempt.json'));
  if (recorded !== null) return { attempt: recorded.outcome !== OutcomeInterrupted ? recorded : null, note: '' };
  const output = findOutput(dir, sc);
  if (output === '') return { attempt: null, note: '' };
  const attempt = newAttempt({ scene_id: sc.id, model: modelFromStream(dir, sc.id), started_at: 'archive' });
  if (attempt.model !== '') attempt.renderer = rendererFromStream(dir, sc.id);
  let verified: { problems: string[] | null; checks: string[] | null };
  try {
    verified = reverify(sc, dir, output, opts);
  } catch (err) {
    return { attempt: null, note: `${dir}：无法重新校验（${err instanceof Error ? err.message : String(err)}）` };
  }
  const kept = dropRetimed(dir, verified.problems ?? [], verified.checks ?? []);
  if (kept.problems.length === 0) return { attempt: null, note: kept.note };
  attempt.outcome = OutcomeVerificationFailed;
  attempt.problems = kept.problems;
  attempt.checks = kept.checks;
  return { attempt, note: kept.note };
}

/**
 * 重判归档时「镜头定义后来改过」的判据：归档只能按镜头现在的
 * scene.json 重判，差出几十帧多半是后来重新分镜改了时长，不是渲染器多渲了几帧。
 * 渲染器自己出的错是差一两帧（实测见 c-language 项目的 extra-frame 归档）。
 */
const retimedFrames = 3;

const frameNumbers = /期望 ([0-9]+) 帧.*实测 ([0-9]+) 帧/;
const durationNumbers = /期望 ([0-9.]+) 秒.*实测 ([0-9.]+) 秒/;

/** 去掉看起来是镜头后来改过时长导致的时长、帧数问题。 */
export function dropRetimed(dir: string, problems: string[], checks: string[]): { problems: string[]; checks: string[]; note: string } {
  let retimed = false;
  checks.forEach((check, i) => {
    if (check === CheckOutputFrames) {
      const m = frameNumbers.exec(problems[i]);
      if (m !== null) retimed = retimed || Math.abs(Number(m[1]) - Number(m[2])) > retimedFrames;
    } else if (check === CheckOutputDuration) {
      const m = durationNumbers.exec(problems[i]);
      if (m !== null) {
        const a = parseGoFloat(m[1]);
        const b = parseGoFloat(m[2]);
        // 按 30fps 估帧数差；画幅帧率在这里拿不到，30 是项目里最常见的。
        retimed = retimed || Math.abs(Math.trunc((a - b) * 30)) > retimedFrames;
      }
    }
  });
  if (!retimed) return { problems, checks, note: '' };
  const keptProblems: string[] = [];
  const keptChecks: string[] = [];
  checks.forEach((check, i) => {
    if (check !== CheckOutputFrames && check !== CheckOutputDuration) {
      keptProblems.push(problems[i]);
      keptChecks.push(check);
    }
  });
  return { problems: keptProblems, checks: keptChecks, note: `${dir}：时长差出 ${retimedFrames} 帧以上，多半是镜头后来改过时长，不记这条` };
}

/** strconv.ParseFloat 失败时 Go 版忽略错误、得到 0。 */
function parseGoFloat(text: string): number {
  return /^([0-9]+\.?[0-9]*|\.[0-9]+)$/.test(text) ? Number(text) : 0;
}

/** 在归档目录里找这个镜头的产物：同名优先，否则取唯一的 mp4。 */
function findOutput(dir: string, sc: Scene): string {
  const base = path.basename(sc.output);
  try {
    fs.statSync(path.join(dir, base));
    return base;
  } catch {
    // 同名的不在，找唯一的 mp4。
  }
  const matches = (readDirSorted(dir) ?? []).filter((e) => e.name.endsWith('.mp4'));
  return matches.length === 1 ? matches[0].name : '';
}

/**
 * 在临时目录里还原当时的镜头目录再用现在的产物校验重判：先铺上镜头目录
 * 现在的文件（字体、素材、视觉规范——归档里通常只有合成代码和产物），再用归档覆盖。
 * 不这样做的话，合成里引用的本地字体在临时目录里找不到，全被误判成 font-missing。
 */
function reverify(sc: Scene, dir: string, output: string, opts: ImportOptions): { problems: string[] | null; checks: string[] | null } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-import-'));
  try {
    linkTree(sc.directory, tmp, (name, isDir) => {
      if (isDir) return name === 'attempts' || name === 'node_modules' || name === 'visual-qc' || name === 'renders';
      return name.endsWith('.mp4') || name.startsWith('render-') || name === RecordFile;
    });
    linkTree(dir, tmp, (name, isDir) => isDir && (name === 'node_modules' || name === 'attempts'));
    const probe: Scene = { ...sc, directory: tmp, output };
    try {
      verifyOutput(probe, opts.env ?? {}, opts.tolerance ?? 0);
    } catch (err) {
      if (err instanceof VerificationError) return { problems: err.problems, checks: err.checks };
      throw err;
    }
    return { problems: null, checks: null };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 把 source 下的普通文件硬链接（跨文件系统时拷贝）到 target 的同一相对路径，
 * 已存在的文件被覆盖。skip 返回 true 的条目跳过（目录则整棵跳过）。
 */
function linkTree(source: string, target: string, skip: (name: string, isDir: boolean) => boolean): void {
  walkDir(source, (file, entry, isDir, err) => {
    if (err) throw err;
    const rel = path.relative(source, file);
    if (rel !== '' && entry !== null && skip(entry.name, isDir)) return 'skip';
    const destination = path.join(target, rel);
    if (isDir) {
      fs.mkdirSync(destination, { recursive: true });
      return;
    }
    if (entry !== null && !entry.isFile()) return;
    try {
      fs.rmSync(destination, { force: true });
    } catch {
      // Go 忽略 os.Remove 的错误。
    }
    try {
      fs.linkSync(file, destination);
    } catch {
      copyFile(file, destination);
    }
  });
}

function streamLines(dir: string, id: string, fn: (line: string) => boolean): void {
  let body: string;
  try {
    body = fs.readFileSync(path.join(dir, 'render-' + id + '.stream.jsonl'), 'utf8');
  } catch {
    return;
  }
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let n = 0; n < lines.length && n < 50; n++) {
    if (fn(lines[n].replace(/\r$/, ''))) return;
  }
}

function modelFromStream(dir: string, id: string): string {
  let model = '';
  streamLines(dir, id, (line) => {
    for (const tool of ['claude', 'qoder', 'codebuddy']) {
      const m = detectModel(tool, line);
      if (m !== '') {
        model = m;
        return true;
      }
    }
    return false;
  });
  return model;
}

/**
 * 只在读得出模型时调用：claude 系三家的 init 事件格式相同，
 * 按模型名前缀粗分，分不清时留空交给兜底。
 */
function rendererFromStream(dir: string, id: string): string {
  return modelFromStream(dir, id).toLowerCase().startsWith('claude') ? 'claude' : '';
}

const determinismProblem = /\[([a-z-]+)\]/;

/** 给没有记录校验器 ID 的老尝试补上 ID。 */
export function classifyProblems(problems: readonly string[]): string[] {
  return problems.map((problem) => {
    if (problem.startsWith('源码不确定')) {
      const m = determinismProblem.exec(problem);
      if (m !== null) return DeterminismCheckPrefix + m[1];
    }
    return classifyOutputProblem(problem);
  });
}

const skipDirs = new Set(['attempts', 'node_modules', 'memory-exams', 'failed-attempts', '_archive', '.git']);

/** 找出项目里的全部镜头，跳过归档与考场。 */
function discoverScenes(root: string): Scene[] {
  const out: Scene[] = [];
  try {
    walkDir(root, (file, entry, isDir, err) => {
      if (err) return 'skip';
      const name = entry?.name ?? path.basename(file);
      if (isDir && skipDirs.has(name)) return 'skip';
      if (isDir || name !== 'scene.json') return;
      try {
        out.push(loadScene(path.dirname(file)));
      } catch {
        // 不是合法镜头就跳过。
      }
    });
  } catch {
    // filepath.WalkDir 的错误被忽略。
  }
  return out.sort((a, b) => compareBytes(a.directory, b.directory));
}

interface ReviewCut {
  from?: string;
  to?: string;
  handoff?: string;
  difference?: number | null;
}

/** 导入整片检查的结果：没接上的交接与阅读时间问题。返回记下的问题数，说明写进 result.notes。 */
function importProjectChecks(s: Store, root: string, byID: Map<string, Scene>, result: ImportResult): number {
  const findings = new Map<string, Finding[]>();
  const add = (id: string, f: Finding) => findings.set(id, [...(findings.get(id) ?? []), f]);
  let body: string | null = null;
  try {
    body = fs.readFileSync(path.join(root, 'production', 'review', 'review.json'), 'utf8');
  } catch {
    body = null;
  }
  if (body !== null) {
    let report: { cuts?: ReviewCut[] | null } | null = null;
    try {
      report = JSON.parse(body) as { cuts?: ReviewCut[] | null };
    } catch {
      report = null;
    }
    for (const cut of report?.cuts ?? []) {
      const c = { handoff: cut.handoff ?? '', difference: cut.difference ?? null };
      if (handoffBroken(c)) {
        const problem = `${cut.from ?? ''} → ${cut.to ?? ''} 约定了 ${c.handoff} 交接，但交界两帧差异 ${formatFixed(c.difference!, 1)}，没接上`;
        for (const id of [cut.from ?? '', cut.to ?? '']) add(id, { check: CheckReviewHandoff, problem });
      }
    }
  }
  const inventoryPath = path.join(root, 'production', 'visible-event-inventory.json');
  let inventory: reads.Inventory | null = null;
  try {
    inventory = reads.loadInventory(inventoryPath);
  } catch {
    inventory = null;
  }
  if (inventory !== null) {
    if (inventory.schema !== 1) {
      addNote(result, inventoryPath + '：不是 schema 1 的清单（老字段名），不导入阅读时间问题');
    } else {
      let timeline: reads.Timeline | null = null;
      try {
        timeline = reads.loadTimeline(path.join(root, 'production', 'phrase-timeline.json'));
      } catch {
        timeline = null;
      }
      for (const f of reads.check(inventory, timeline, reads.Defaults).findings) {
        if (f.scene_id) add(f.scene_id, { check: ReadsCheckPrefix + f.rule, problem: f.message });
      }
    }
  }
  let count = 0;
  for (const id of [...findings.keys()].sort(compareBytes)) {
    const sc = byID.get(id);
    if (!sc) continue;
    const list = findings.get(id)!;
    if (s.recordCheck(sc, list).recorded) count += list.length;
  }
  return count;
}
