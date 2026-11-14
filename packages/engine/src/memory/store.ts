// Store 的其余方法分散在各自的文件里实现，
// 这里只做转发，免得一个类写成几千行。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goQuote } from '../gofmt';
import { compareBytes, marshal } from '../gojson';
import { eventToJSON, type Event } from './events';
import type { Attempt, Scene } from '../scene';
import { recordCheck, type Finding } from './checks';
import { consolidate, lastConsolidation, type ConsolidateOptions, type ConsolidateResult } from './consolidate';
import { recordUtterance, type Utterance } from './conversation';
import {
  episodeByID,
  episodes,
  recordAttempt,
  recordFeedback,
  type AttemptSource,
  type Episode,
  type Feedback,
} from './episode';
import {
  exam,
  exams,
  promote,
  reject,
  retestNeeded,
  retire,
  type ExamOptions,
  type ExamResult,
  type Retest,
} from './exam';
import { importProject, type ImportOptions, type ImportResult } from './importer';
import { isNotExist, readDirSorted } from './io';
import { format, kindDir, KindLesson, KindPreference, parse, StatusActive, validName, type Kind, type Memory } from './memory';
import { currentModel, observeModel } from './models';
import { rfc3339 } from './gostr';
import { preferenceBrief, remember, type RememberInput } from './preferences';
import { recallScene, type RecallOptions, type RecallResult } from './recall';
import {
  drift,
  latestSnapshot,
  loadSnapshot,
  resolveSnapshot,
  rollback,
  snapshotIDs,
  takeSnapshot,
  type Snapshot,
} from './snapshot';
import { storeStats, type Stat } from './stats';
import { status, type StatusReport } from './status';

/**
 * Store 是一个记忆库目录。
 *
 *	MEMORY.md        索引：每条生效记忆一行
 *	lessons/         经验，一条一个文件
 *	preferences/     偏好
 *	episodes/        经历，按月分目录，每段一个目录（episode.json + 冻结输入）
 *	exams/           考试结果
 *	snapshots/       记忆库快照
 *	consolidate/     整理时交给整理者的工作目录
 *	timeline.jsonl   事件日志
 */
export class Store {
  /** 可在测试里替换（Go 版是包内的 now 字段）。 */
  now: (() => Date) | null;

  constructor(
    readonly dir: string,
    now: (() => Date) | null = () => new Date(),
  ) {
    this.now = now;
  }

  clock(): Date {
    return this.now === null ? new Date() : this.now();
  }

  /** 一条记忆的文件路径。 */
  path(kind: Kind, name: string): string {
    return path.join(this.dir, kindDir(kind), name + '.md');
  }

  /**
   * 读出记忆库里的全部经验与偏好，按层、名字排序。
   * 解析失败的文件单独返回，不让一份坏文件拖垮整次召回。
   */
  memories(): { memories: Memory[]; broken: Record<string, Error> } {
    const out: Memory[] = [];
    const broken: Record<string, Error> = {};
    for (const kind of [KindLesson, KindPreference]) {
      const entries = readDirSorted(path.join(this.dir, kindDir(kind))) ?? [];
      for (const entry of entries) {
        if (entry.isDirectory() || !entry.name.endsWith('.md')) continue;
        const file = path.join(this.dir, kindDir(kind), entry.name);
        const body = fs.readFileSync(file);
        let m: Memory;
        try {
          m = parse(kind, body);
          if (m.name + '.md' !== entry.name) throw new Error(`name 字段 ${goQuote(m.name)} 与文件名不一致`);
        } catch (err) {
          broken[kindDir(kind) + '/' + entry.name] = err instanceof Error ? err : new Error(String(err));
          continue;
        }
        out.push(m);
      }
    }
    sortMemories(out);
    return { memories: out, broken };
  }

  /** 按名字找一条记忆。 */
  find(name: string): Memory | null {
    return this.memories().memories.find((m) => m.name === name) ?? null;
  }

  /** 原子写出一条记忆，并刷新索引。 */
  write(m: Memory): void {
    if (!validName(m.name)) throw new Error(`记忆名不合法：${goQuote(m.name)}（小写字母、数字与连字符，3–64 字符）`);
    atomicWrite(this.path(m.kind, m.name), format(m), 0o644);
    this.writeIndex();
  }

  /** 重写 MEMORY.md：每条生效记忆一行「标题 — 一句话钩子」。它只给人读，召回不读它。 */
  writeIndex(): void {
    const all = this.memories().memories;
    let b = '# 渲染记忆索引\n\n由 onset 维护，只列生效记忆。改记忆请改 lessons/ 与 preferences/ 下的文件，再运行 memory_status()。\n\n';
    let count = 0;
    for (const m of all) {
      if (m.status !== StatusActive) continue;
      count++;
      const label = m.kind === KindPreference ? '（偏好，未经机器验证）' : '';
      b += `- [${m.name}](${kindDir(m.kind)}/${m.name}.md) — ${m.description}${label}\n`;
    }
    if (count === 0) b += '（暂无生效记忆）\n';
    atomicWrite(path.join(this.dir, 'MEMORY.md'), b, 0o644);
  }

  /**
   * 追加一条时间线事件。
   *
   * 每条事件是一次 O_APPEND 的单行写入：run-all 的几个镜头会同时写经历事件，
   * 本地文件系统上单次追加写不会互相穿插。
   */
  log(event: Event): void {
    const e = { ...event };
    if (!e.time) e.time = rfc3339(this.clock());
    fs.appendFileSync(path.join(this.dir, 'timeline.jsonl'), marshal(eventToJSON(e)) + '\n', { mode: 0o644 });
  }

  /** 读出全部时间线事件，按写入顺序。坏行跳过。 */
  timeline(): Event[] {
    let body: string;
    try {
      body = fs.readFileSync(path.join(this.dir, 'timeline.jsonl'), 'utf8');
    } catch (err) {
      if (isNotExist(err)) return [];
      throw err;
    }
    const events: Event[] = [];
    for (const line of body.split('\n')) {
      if (line.trim() === '') continue;
      const event = parseEvent(line);
      if (event) events.push(event);
    }
    return events;
  }

  // ---- models.ts ----
  observeModel(renderer: string, model: string): void {
    observeModel(this, renderer, model);
  }
  currentModel(renderer: string, env: Record<string, string | undefined>, declared = ''): string {
    return currentModel(this, renderer, env, declared);
  }

  // ---- checks.ts ----
  recordCheck(sc: Scene, findings: Finding[]): { episode: Episode; recorded: boolean } {
    return recordCheck(this, sc, findings);
  }

  // ---- episode.ts ----
  recordAttempt(sc: Scene, attempt: Attempt, from: AttemptSource): Episode {
    return recordAttempt(this, sc, attempt, from);
  }
  recordFeedback(sc: Scene, feedback: Feedback): Episode {
    return recordFeedback(this, sc, feedback);
  }
  episodes(): Episode[] {
    return episodes(this);
  }
  episodeByID(id: string): Episode {
    return episodeByID(this, id);
  }

  // ---- conversation.ts ----
  recordUtterance(u: Utterance): Episode {
    return recordUtterance(this, u);
  }

  // ---- snapshot.ts ----
  snapshotIDs(): number[] {
    return snapshotIDs(this);
  }
  loadSnapshot(id: number): Snapshot {
    return loadSnapshot(this, id);
  }
  latestSnapshot(): Snapshot | null {
    return latestSnapshot(this);
  }
  resolveSnapshot(pinned: number): Snapshot | null {
    return resolveSnapshot(this, pinned);
  }
  takeSnapshot(cause: string, summary: string, unverified: boolean): Snapshot {
    return takeSnapshot(this, cause, summary, unverified);
  }
  drift(): string[] | null {
    return drift(this);
  }
  rollback(to: number): Snapshot {
    return rollback(this, to);
  }

  // ---- stats.ts ----
  stats(): Record<string, Record<string, Stat>> {
    return storeStats(this);
  }

  // ---- status.ts ----
  status(record: boolean, currentModel: ((renderer: string) => string) | null): StatusReport {
    return status(this, record, currentModel);
  }

  // ---- recall.ts ----
  recallScene(sc: Scene, opts: RecallOptions): RecallResult {
    return recallScene(this, sc, opts);
  }

  // ---- preferences.ts ----
  preferenceBrief(project: string, pinned: number): { text: string; digest: string } {
    return preferenceBrief(this, project, pinned);
  }
  remember(input: RememberInput): { memory: Memory; snapshot: Snapshot | null } {
    return remember(this, input);
  }

  // ---- consolidate.ts ----
  lastConsolidation(): string {
    return lastConsolidation(this);
  }
  consolidate(opts: ConsolidateOptions): Promise<ConsolidateResult> {
    return consolidate(this, opts);
  }

  // ---- exam.ts ----
  exams(): ExamResult[] {
    return exams(this);
  }
  exam(opts: ExamOptions): Promise<ExamResult> {
    return exam(this, opts);
  }
  promote(name: string): Snapshot {
    return promote(this, name);
  }
  reject(name: string, reason: string): void {
    reject(this, name, reason);
  }
  retire(name: string, reason: string): Snapshot {
    return retire(this, name, reason);
  }
  retestNeeded(currentModel: ((renderer: string) => string) | null): Retest[] | null {
    return retestNeeded(this, currentModel);
  }

  // ---- importer.ts ----
  importProject(root: string, opts: ImportOptions): ImportResult {
    return importProject(this, root, opts);
  }
}


/** 返回 dir 处的记忆库，按需建出子目录。 */
export function open(dir: string): Store {
  if (dir === '') throw new Error('记忆库目录为空');
  const abs = path.resolve(dir);
  for (const sub of ['lessons', 'preferences', 'episodes', 'exams', 'snapshots']) {
    try {
      fs.mkdirSync(path.join(abs, sub), { recursive: true });
    } catch (err) {
      throw new Error(`建立记忆库目录：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  return new Store(abs);
}

/**
 * 返回 dir 处的记忆库但不建任何目录，供只读的调用方使用：
 * 目录不存在时读出来就是空库。
 */
export function openReadOnly(dir: string): Store {
  return new Store(path.resolve(dir));
}

export function sortMemories(list: Memory[]): void {
  list.sort((a, b) => {
    if (a.kind !== b.kind) return compareBytes(a.kind, b.kind);
    return compareBytes(a.name, b.name);
  });
}

function parseEvent(line: string): Event | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => v === undefined || v === null || typeof v === 'string';
  if (!str(r.time) || !str(r.type) || !str(r.summary) || !str(r.project)) return null;
  if (r.snapshot !== undefined && r.snapshot !== null && !Number.isInteger(r.snapshot)) return null;
  if (r.detail !== undefined && r.detail !== null && (typeof r.detail !== 'object' || Array.isArray(r.detail))) return null;
  const event: Event = {
    time: (r.time as string | null) ?? '',
    type: (r.type as string | null) ?? '',
    summary: (r.summary as string | null) ?? '',
  };
  if (r.snapshot) event.snapshot = r.snapshot as number;
  if (r.project) event.project = r.project as string;
  // Go 把 detail 读成 map[string]any：各层对象再写出时都按键排序，与写入时的字段顺序无关。
  if (r.detail) event.detail = sortDeep(r.detail) as Record<string, unknown>;
  return event;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareBytes)) out[key] = sortDeep((value as Record<string, unknown>)[key]);
  return out;
}
