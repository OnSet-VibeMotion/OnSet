import fs from 'node:fs';
import path from 'node:path';
import { formatFixed } from '../gofmt';
import { compareBytes } from '../gojson';
import * as reads from '../reads';
import { handoffBroken } from '../review';
import {
  attemptLog,
  CheckReviewHandoff,
  load as loadScene,
  OutcomeInterrupted,
  OutcomeVerificationFailed,
  parseAttempt,
  ReadsCheckPrefix,
  type Attempt,
  type Scene,
} from '../scene';
import type { Finding } from './checks';
import { newEpisode, saveEpisode, SourceRender, type Episode } from './episode';
import { EventEpisode } from './events';
import { features } from './features';
import { readDirSorted, walkDir } from './io';
import type { Store } from './store';

/** 导入历史项目的设置。 */
export interface ImportOptions {
  /** 尝试记录里没有渲染工具时的兜底（项目配置的 RENDERER）。 */
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

/**
 * 把一个已有项目的渲染历史导入为经历，作为种子：
 *
 *   - 镜头目录里的 render-<id>.attempt.json 与 attempts/attempt-NN/ 下归档的尝试；
 *   - production/review/review.json 里没接上的交接；
 *   - production/visible-event-inventory.json（schema 1）的阅读时间问题。
 *
 * 每个镜头最早的一次尝试算首次尝试，其余算重试，批次编号是 import:<项目名>，
 * onset memory report 里能看到这些项目当时的一次通过率。冻结的输入是镜头现在的输入，
 * 不是当时的——历史输入没有留存。同一个来源重复导入时跳过。
 */
export function importProject(s: Store, rootDir: string, opts: ImportOptions): ImportResult {
  const root = path.resolve(rootDir);
  const project = path.basename(root);
  const result: ImportResult = { project, run: 'import:' + project, scenes: 0, attempts: 0, failures: 0, checks: 0, skipped: 0 };
  const imported = new Set<string>();
  for (const e of s.episodes()) if (e.imported !== '') imported.add(e.imported);
  const scenes = discoverScenes(root);
  result.scenes = scenes.length;
  const byID = new Map<string, Scene>();
  for (const sc of scenes) {
    byID.set(sc.id, sc);
    const attempts: ImportedAttempt[] = [];
    const archiveRoot = path.join(sc.directory, 'attempts');
    const archives = (readDirSorted(archiveRoot) ?? []).filter((e) => e.name.startsWith('attempt-')).map((e) => path.join(archiveRoot, e.name));
    for (const dir of archives) {
      let order = '0';
      const m = archiveNumber.exec(path.basename(dir));
      if (m !== null) order = String(Number(m[1])).padStart(6, '0');
      const recorded = readAttempt(path.join(dir, 'render-' + sc.id + '.attempt.json'));
      if (recorded === null || recorded.outcome === OutcomeInterrupted) {
        result.skipped++;
        continue;
      }
      attempts.push({ order, source: dir, attempt: recorded });
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
      recordImported(s, sc, item.attempt, result.run, key);
      imported.add(key);
      result.attempts++;
      if (item.attempt.outcome === OutcomeVerificationFailed) result.failures++;
    }
  }
  const checks = importProjectChecks(s, root, byID);
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

const skipDirs = new Set(['attempts', 'node_modules', 'memory-exams', 'auditions', '_archive', '.git']);

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

/** 导入整片检查的结果：没接上的交接与阅读时间问题。返回记下的问题数。 */
function importProjectChecks(s: Store, root: string, byID: Map<string, Scene>): number {
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
  let count = 0;
  for (const id of [...findings.keys()].sort(compareBytes)) {
    const sc = byID.get(id);
    if (!sc) continue;
    const list = findings.get(id)!;
    if (s.recordCheck(sc, list).recorded) count += list.length;
  }
  return count;
}
