/**
 * 会话的持久化读写、列表/查找/创建，以及事件追加与等待。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshal, marshalIndent } from '../gojson';
import { compareTimes, nowTime } from './http';
import {
  type AgentChoice,
  kindTurnEnd,
  kindTurnStart,
  type NewEvent,
  newID,
  type Session,
  type SessionEvent,
  type SessionMeta,
  sessionEventJSON,
  sessionKey,
  sessionMetaJSON,
  sessionsDir,
} from './sessions_types';
import type { Server } from './studio';
import { loadTurn, saveTurn, type Turn, validID } from './turns';

function decodeMeta(body: string): SessionMeta | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const s = (key: string): string | undefined => {
    const v = r[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : undefined;
  };
  const fields = [
    'session_id',
    'title',
    'kind',
    'tool',
    'model',
    'options',
    'renderer',
    'renderer_model',
    'renderer_options',
    'cli_session_id',
    'created_at',
    'updated_at',
    'running_turn',
    'preference_digest',
    'ownership_digest',
    'local_style_receipt',
    'handoff_reason',
  ];
  const values: Record<string, string> = {};
  for (const key of fields) {
    const v = s(key);
    if (v === undefined) return undefined;
    values[key] = v;
  }
  if (r.vision_note_sent !== undefined && typeof r.vision_note_sent !== 'boolean') return undefined;
  let turns: string[] | null = null;
  if (Array.isArray(r.turns)) {
    if (!r.turns.every((t) => typeof t === 'string')) return undefined;
    turns = r.turns as string[];
  } else if (r.turns !== undefined && r.turns !== null) return undefined;
  const zero = '0001-01-01T00:00:00Z';
  return {
    session_id: values.session_id,
    title: values.title,
    kind: values.kind,
    tool: values.tool,
    model: values.model || undefined,
    options: values.options || undefined,
    renderer: values.renderer || undefined,
    renderer_model: values.renderer_model || undefined,
    renderer_options: values.renderer_options || undefined,
    cli_session_id: values.cli_session_id || undefined,
    created_at: values.created_at || zero,
    updated_at: values.updated_at || zero,
    turns,
    running_turn: values.running_turn || undefined,
    preference_digest: values.preference_digest || undefined,
    ownership_digest: values.ownership_digest || undefined,
    vision_note_sent: r.vision_note_sent === true ? true : undefined,
    local_style_receipt: values.local_style_receipt || undefined,
    handoff_reason: values.handoff_reason || undefined,
  };
}

/** 读回一行事件；读不懂的行跳过。 */
function decodeEvent(line: string): SessionEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const e = raw as SessionEvent;
  if (typeof e.seq !== 'number') e.seq = 0;
  if (typeof e.kind !== 'string') e.kind = '';
  if (typeof e.time !== 'string') e.time = '0001-01-01T00:00:00Z';
  return e;
}

function readEvents(file: string): SessionEvent[] {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events: SessionEvent[] = [];
  for (const line of body.split('\n')) {
    if (line === '') continue;
    const event = decodeEvent(line);
    if (event) events.push(event);
  }
  return events;
}

function writeMeta(sess: Session): void {
  atomicWrite(
    path.join(sessionsDir(sess.project), sess.meta.session_id + '.json'),
    marshalIndent(sessionMetaJSON(sess.meta)) + '\n',
    0o644,
  );
}

/** 重启后没有活的对话进程，事件流也必须收尾。旧版可能已清 running_turn，
 * 却留下没有 turn-end 的 turn-start；只看元数据会让这些会话永久显示运行中。 */
function restoreEndedTurns(sess: Session): void {
  const pending = new Set<string>();
  if (sess.meta.running_turn) pending.add(sess.meta.running_turn);
  for (const event of sess.events) {
    if (!event.turn_id || !validID(event.turn_id)) continue;
    if (event.kind === kindTurnStart) pending.add(event.turn_id);
    else if (event.kind === kindTurnEnd) pending.delete(event.turn_id);
  }
  for (const id of pending) {
    let turn: Turn | undefined;
    try {
      turn = loadTurn(sess.project, id);
      if (turn.status === 'running') {
        turn.status = 'interrupted';
        turn.error = 'Studio 在本轮进行中退出';
        turn.ended_at = nowTime();
        saveTurn(sess.project, turn);
      }
    } catch {
      // 轮次记录缺失或写不了，也要让事件订阅方知道本轮已结束。
    }
    emit(sess, id, {
      kind: kindTurnEnd,
      status: turn?.status || 'interrupted',
      text: turn ? turn.error : 'Studio 在本轮进行中退出，轮次记录无法读取',
      changes: turn?.changes ?? undefined,
    });
  }
}

/**
 * loadSessions 首次访问某个项目时从磁盘读出它的全部会话。
 * 上次 Studio 退出时还在进行的轮次标成 interrupted：进程已经不在了。
 */
export function loadSessions(s: Server, projectPath: string): void {
  if (s.loadedProjects.has(projectPath)) return;
  s.loadedProjects.add(projectPath);
  let names: string[];
  try {
    names = fs
      .readdirSync(sessionsDir(projectPath), { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return;
  }
  for (const name of names) {
    let body: string;
    try {
      body = fs.readFileSync(path.join(sessionsDir(projectPath), name), 'utf8');
    } catch {
      continue;
    }
    const meta = decodeMeta(body);
    if (!meta || !validID(meta.session_id)) continue;
    const sess: Session = {
      project: projectPath,
      meta,
      events: [],
      waiters: new Set(),
      cancel: null,
      queue: [],
      permissions: new Map(),
    };
    sess.events = readEvents(path.join(sessionsDir(projectPath), meta.session_id + '.events.jsonl'));
    restoreEndedTurns(sess);
    if (meta.running_turn) {
      sess.meta.running_turn = undefined;
      try {
        writeMeta(sess);
      } catch {
        // 写不了下次再标。
      }
    }
    s.sessions.set(sessionKey(projectPath, meta.session_id), sess);
  }
}

export function listSessions(s: Server, projectPath: string): SessionMeta[] {
  loadSessions(s, projectPath);
  const out: SessionMeta[] = [];
  for (const sess of s.sessions.values()) if (sess.project === projectPath) out.push({ ...sess.meta });
  // Go 的 sort.Slice 不稳定；按更新时间倒序，相同时间的先后不作保证。
  out.sort((a, b) => compareTimes(b.updated_at, a.updated_at));
  return out;
}

export function getSession(s: Server, projectPath: string, id: string): Session | undefined {
  loadSessions(s, projectPath);
  return s.sessions.get(sessionKey(projectPath, id));
}

export function createSession(
  s: Server,
  projectPath: string,
  kind: string,
  title: string,
  agents: AgentChoice,
): Session {
  loadSessions(s, projectPath);
  const now = nowTime();
  const sess: Session = {
    project: projectPath,
    meta: {
      session_id: newID('s'),
      title,
      kind,
      tool: agents.tool,
      model: agents.model || undefined,
      options: agents.options || undefined,
      renderer: agents.renderer || undefined,
      renderer_model: agents.rendererModel || undefined,
      renderer_options: agents.rendererOptions || undefined,
      created_at: now,
      updated_at: now,
      turns: [],
    },
    events: [],
    waiters: new Set(),
    cancel: null,
    queue: [],
    permissions: new Map(),
  };
  writeMeta(sess);
  s.sessions.set(sessionKey(projectPath, sess.meta.session_id), sess);
  return sess;
}

/**
 * emit 追加一条事件：编号、落盘、唤醒等待中的 SSE 连接。
 *
 * 编号与落盘在同一段同步代码里：一轮对话与一次回退可能同时发事件，行序必须与 seq 一致，
 * 重启后按行读回来的事件才对得上 SSE 的 Last-Event-ID。
 */
export function emit(sess: Session, turn: string, event: NewEvent): void {
  const full: SessionEvent = { ...event, seq: sess.events.length + 1, turn_id: turn || undefined, time: nowTime() };
  sess.events.push(full);
  try {
    const file = path.join(sessionsDir(sess.project), sess.meta.session_id + '.events.jsonl');
    fs.appendFileSync(file, marshal(sessionEventJSON(full)) + '\n', { mode: 0o644 });
  } catch {
    // 写不了事件文件不影响这一轮：内存里还有，SSE 照常推送。
  }
  const waiters = [...sess.waiters];
  sess.waiters.clear();
  for (const wake of waiters) wake();
}

/** updateMeta 修改会话元数据并落盘。 */
export function updateMeta(sess: Session, change: (meta: SessionMeta) => void): void {
  change(sess.meta);
  sess.meta.updated_at = nowTime();
  try {
    writeMeta(sess);
  } catch {
    // 与 Go 版一样忽略落盘错误。
  }
}

/** eventsAfter 返回 seq 大于 after 的事件，以及会话此刻是否有进行中的一轮。 */
export function eventsAfter(sess: Session, after: number): { events: SessionEvent[]; running: boolean } {
  const events = after < sess.events.length ? sess.events.slice(Math.max(after, 0)) : [];
  return { events, running: !!sess.meta.running_turn };
}

/** 等下一条事件（或被 signal 取消）。 */
export function waitEvent(sess: Session): Promise<void> {
  return new Promise((resolve) => sess.waiters.add(resolve));
}
