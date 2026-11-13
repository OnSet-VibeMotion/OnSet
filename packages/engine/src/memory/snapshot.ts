import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import { EventRollback, EventSnapshot } from './events';
import { rfc3339 } from './gostr';
import { isNotExist, readDirSorted, readJSON, writeJSON } from './io';
import { digestBytes, parse, StatusActive, StatusDormant, type Kind, type Memory } from './memory';
import { statsToJSON, type Stat } from './stats';
import type { Store } from './store';

/**
 * 快照里的一条生效记忆，存完整文件内容：回退时原样写回，
 * 召回也只读快照，不读记忆文件——所以手改记忆文件要经 am memory status
 * 记成新快照才会生效，同样的镜头输入加同一个快照永远得到同样的召回。
 */
export interface SnapshotEntry {
  name: string;
  kind: Kind;
  digest: string;
  content: string;
}

/** 记忆库在某一刻的生效记忆集合。 */
export interface Snapshot {
  id: number;
  created_at: string;
  /** 触发快照的事件类型（promote、rollback、manual_edit……）。 */
  cause: string;
  summary: string;
  entries: SnapshotEntry[] | null;
  /**
   * 生成快照时冻结的效果统计，召回排序用它而不是实时统计：
   * 实时统计每渲染一次就变，召回结果就不再只由快照决定。
   */
  stats: Record<string, Record<string, Stat>> | null;
  /** 快照里有未经考试的改动（人工编辑）。 */
  unverified: boolean;
  /** 回退来源快照号。 */
  restored_from: number;
}

export function newSnapshot(fields: Partial<Snapshot> = {}): Snapshot {
  return { id: 0, created_at: '', cause: '', summary: '', entries: null, stats: null, unverified: false, restored_from: 0, ...fields };
}

/** Snapshot 的 JSON（字段顺序与 omitempty 同 Go）。 */
export function snapshotToJSON(s: Snapshot): Record<string, unknown> {
  return {
    id: s.id,
    created_at: s.created_at,
    cause: s.cause,
    summary: s.summary,
    entries: s.entries === null ? null : s.entries.map((e) => ({ name: e.name, kind: e.kind, digest: e.digest, content: e.content })),
    stats: s.stats && Object.keys(s.stats).length > 0 ? statsToJSON(s.stats) : undefined,
    unverified: s.unverified || undefined,
    restored_from: s.restored_from || undefined,
  };
}

function parseSnapshot(raw: unknown): Snapshot {
  const o = (raw ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(o.entries)
    ? (o.entries as Array<Record<string, unknown>>).map((e) => ({
        name: String(e?.name ?? ''),
        kind: String(e?.kind ?? ''),
        digest: String(e?.digest ?? ''),
        content: String(e?.content ?? ''),
      }))
    : null;
  let stats: Record<string, Record<string, Stat>> | null = null;
  if (o.stats && typeof o.stats === 'object') {
    stats = {};
    for (const [name, byKey] of Object.entries(o.stats as Record<string, Record<string, Record<string, unknown>>>)) {
      stats[name] = {};
      for (const [key, stat] of Object.entries(byKey ?? {})) {
        stats[name][key] = { recalled: Number(stat?.recalled ?? 0), passed_first_try: Number(stat?.passed_first_try ?? 0) };
      }
    }
  }
  return newSnapshot({
    id: Number(o.id ?? 0),
    created_at: String(o.created_at ?? ''),
    cause: String(o.cause ?? ''),
    summary: String(o.summary ?? ''),
    entries,
    stats,
    unverified: o.unverified === true,
    restored_from: Number(o.restored_from ?? 0),
  });
}

/** 解析快照里的全部记忆。 */
export function snapshotMemories(s: Snapshot): Memory[] {
  const out: Memory[] = [];
  for (const entry of s.entries ?? []) {
    try {
      out.push(parse(entry.kind, entry.content));
    } catch (err) {
      throw new Error(`快照 #${s.id} 的记忆 ${entry.name}：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  return out;
}

function snapshotPath(s: Store, id: number): string {
  return path.join(s.dir, 'snapshots', String(id).padStart(6, '0') + '.json');
}

/** 全部快照号，升序。 */
export function snapshotIDs(s: Store): number[] {
  const entries = readDirSorted(path.join(s.dir, 'snapshots')) ?? [];
  const ids: number[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const name = entry.name.slice(0, -'.json'.length);
    // strconv.Atoi：可带正负号的十进制整数。
    if (/^[+-]?[0-9]+$/.test(name)) ids.push(Number(name));
  }
  return ids.sort((a, b) => a - b);
}

/** 读出指定快照。 */
export function loadSnapshot(s: Store, id: number): Snapshot {
  let raw: unknown;
  try {
    raw = readJSON(snapshotPath(s, id));
  } catch (err) {
    if (isNotExist(err)) throw new Error(`快照 #${id} 不存在`, { cause: err });
    throw new Error(`读取快照 #${id}：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return parseSnapshot(raw);
}

/** 读出最新快照；还没有任何快照时返回 null。 */
export function latestSnapshot(s: Store): Snapshot | null {
  const ids = snapshotIDs(s);
  if (ids.length === 0) return null;
  return loadSnapshot(s, ids[ids.length - 1]);
}

/**
 * 召回要用的快照：pinned 为 0 时跟随最新快照。
 * 记忆库还没有快照时返回 null，此时什么也不召回。
 */
export function resolveSnapshot(s: Store, pinned: number): Snapshot | null {
  if (pinned > 0) return loadSnapshot(s, pinned);
  return latestSnapshot(s);
}

/** 把当前生效记忆的文件内容列成快照条目。 */
export function activeEntries(s: Store): SnapshotEntry[] | null {
  const entries: SnapshotEntry[] = [];
  for (const m of s.memories().memories) {
    if (m.status !== StatusActive) continue;
    const body = fs.readFileSync(s.path(m.kind, m.name));
    entries.push({ name: m.name, kind: m.kind, digest: digestBytes(body), content: body.toString('utf8') });
  }
  return entries.length > 0 ? entries : null;
}

/** 把当前生效记忆集合记成一个新快照，并写进时间线。 */
export function takeSnapshot(s: Store, cause: string, summary: string, unverified: boolean): Snapshot {
  const entries = activeEntries(s);
  const stats = s.stats();
  return saveSnapshot(s, newSnapshot({ cause, summary, entries, stats, unverified }));
}

export function saveSnapshot(s: Store, snapshot: Snapshot): Snapshot {
  const ids = snapshotIDs(s);
  snapshot = { ...snapshot };
  snapshot.id = ids.length > 0 ? ids[ids.length - 1] + 1 : 1;
  snapshot.created_at = rfc3339(s.clock());
  if (snapshot.entries === null) snapshot.entries = [];
  writeJSON(snapshotPath(s, snapshot.id), snapshotToJSON(snapshot));
  s.writeIndex();
  const names = snapshot.entries.map((e) => e.name);
  s.log({
    time: '',
    type: EventSnapshot,
    snapshot: snapshot.id,
    summary: `快照 #${snapshot.id}：${snapshot.summary}`,
    detail: { cause: snapshot.cause, memories: names, unverified: snapshot.unverified },
  });
  return snapshot;
}

/**
 * 比较当前生效记忆与最新快照，列出新增、删除或内容变了的记忆名。
 * 还没有快照时，所有生效记忆都算新增。没有变化时返回 null。
 */
export function drift(s: Store): string[] | null {
  const entries = activeEntries(s) ?? [];
  const latest = latestSnapshot(s);
  const previous = new Map<string, string>();
  for (const entry of latest?.entries ?? []) previous.set(entry.name, entry.digest);
  const changed: string[] = [];
  for (const entry of entries) {
    if ((previous.get(entry.name) ?? '') !== entry.digest) changed.push(entry.name);
    previous.delete(entry.name);
  }
  for (const name of previous.keys()) changed.push(name);
  changed.sort(compareBytes);
  return changed.length > 0 ? changed : null;
}

/**
 * 把快照 to 的生效记忆集合恢复成一个新快照，不删除任何历史。
 * to 为 0 时回到最新快照的上一个。
 *
 * 快照里的记忆按快照内容原样写回并置为生效；当前生效、但不在目标快照里的
 * 记忆转为沉睡，文件保留。
 */
export function rollback(s: Store, to: number): Snapshot {
  const ids = snapshotIDs(s);
  if (to === 0) {
    if (ids.length < 2) throw new Error(`只有 ${ids.length} 个快照，没有可回退的上一版；用 --to 指定快照号`);
    to = ids[ids.length - 2];
  }
  const target = loadSnapshot(s, to);
  const keep = new Set<string>();
  for (const m of snapshotMemories(target)) {
    keep.add(m.name);
    m.status = StatusActive;
    s.write(m);
  }
  for (const m of s.memories().memories) {
    if (m.status === StatusActive && !keep.has(m.name)) {
      m.status = StatusDormant;
      s.write(m);
    }
  }
  const entries = activeEntries(s);
  const snapshot = saveSnapshot(
    s,
    newSnapshot({
      cause: EventRollback,
      summary: `回退到快照 #${to}`,
      entries,
      stats: target.stats,
      unverified: target.unverified,
      restored_from: to,
    }),
  );
  s.log({ time: '', type: EventRollback, snapshot: snapshot.id, summary: `回退到快照 #${to}，记为新快照 #${snapshot.id}` });
  return snapshot;
}
