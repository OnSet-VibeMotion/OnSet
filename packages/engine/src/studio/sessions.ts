/**
 * 会话、事件流、轮次的生命周期与排队。
 *
 * Go 版靠 sessions.mu 串行化；Node 是单线程，同步代码段天然不会被打断，所以这里没有锁，
 * 但保留 Go 版「先改内存、再落盘、再唤醒」的顺序。
 */
import type * as config from '../config';
import { emitStudioEvent } from './events';
import { nowTime } from './http';
import { recordUtterance } from './memory';
import { sessionConfig } from './sessions_agents';
import { prepareTurn } from './sessions_prepare';
import { attachmentText, scheduleGateHandoff, validateAttachments } from './sessions_prompt';
import { emit, getSession, updateMeta } from './sessions_store';
import { executeTurn } from './sessions_turn';
import {
  BusyError,
  kindNotice,
  kindQueued,
  kindTurnEnd,
  kindTurnReverted,
  kindUnqueued,
  newID,
  type Session,
  type TurnRequest,
} from './sessions_types';
import type { Project, Server } from './studio';
import { diffTrees, loadTurn, revertTurn, saveTurn, scanTree, type Turn } from './turns';

export { lastTaskPlan, overrideAgents, replayGuard, sessionConfig, validateChoice } from './sessions_agents';
export {
  attachmentText,
  chatPreamble,
  focusStageFor,
  handoffSession,
  projectStateBrief,
  reseedPrompt,
  scheduleGateHandoff,
  studioInteraction,
  transcript,
  validateAttachments,
} from './sessions_prompt';
export {
  createSession,
  emit,
  eventsAfter,
  getSession,
  listSessions,
  loadSessions,
  updateMeta,
  waitEvent,
} from './sessions_store';
export {
  type AgentChoice,
  type Attachment,
  attachmentJSON,
  type Box,
  BusyError,
  containedPath,
  evalSymlinks,
  kindFilesChanged,
  kindNotice,
  kindQueued,
  kindTurnEnd,
  kindTurnReverted,
  kindTurnStart,
  kindUnqueued,
  kindUser,
  maxQuoteRunes,
  type NewEvent,
  NotExistError,
  newID,
  type Session,
  type SessionEvent,
  type SessionMeta,
  sessionEventJSON,
  sessionMetaJSON,
  sessionsDir,
  type TurnRequest,
  transcriptLimit,
} from './sessions_types';

/** startTurn 占用项目写权、打开始快照，然后在后台跑这一轮。返回时编排工具已经在启动。 */
export function startTurn(s: Server, p: Project, sess: Session, req: TurnRequest): Turn {
  validateAttachments(p.path, req.attachments);
  const cfg = sessionConfig(p.path, sess.meta);
  s.acquire(p.path, '会话「' + sess.meta.title + '」正在对话');
  let prepared: { turn: Turn; prompt: string; handoff: string };
  try {
    prepared = prepareTurn(s, p, sess, cfg, req);
  } catch (err) {
    s.release(p.path);
    throw err;
  }
  const controller = new AbortController();
  sess.cancel = controller;
  const projectWrites = { epoch: s.writeEpoch(p.path), sharedAtStart: s.hasSharedWriter(p.path) };
  void runTurn(s, controller.signal, p, sess, cfg, prepared.turn, prepared.prompt, prepared.handoff, projectWrites);
  return prepared.turn;
}

/**
 * runTurn 在后台跑一轮。写权由 finishTurn 释放，这里不能再释放一次：
 * 释放之后下一轮可能已经拿到写权，重复释放会把它的锁也放掉。
 */
async function runTurn(
  s: Server,
  signal: AbortSignal,
  p: Project,
  sess: Session,
  cfg: config.Config,
  turn: Turn,
  prompt: string,
  handoff: string,
  projectWrites: { epoch: number; sharedAtStart: boolean },
): Promise<void> {
  const { runErr, confirmedGates } = await executeTurn(s, signal, p, sess, cfg, turn, prompt, handoff);
  for (const confirmed of confirmedGates) {
    scheduleGateHandoff(s, p.path, confirmed.gate, confirmed.label);
  }
  const concurrentWrites = projectWrites.sharedAtStart || s.writeEpoch(p.path) !== projectWrites.epoch;
  finishTurn(s, signal, p, sess, turn, runErr, concurrentWrites);
}

function finishTurn(
  s: Server,
  signal: AbortSignal,
  p: Project,
  sess: Session,
  turn: Turn,
  runErr: Error | null,
  concurrentWrites: boolean,
): void {
  let scanErr: Error | null = null;
  try {
    const after = scanTree(p.path);
    turn.after = after;
    turn.changes = diffTrees(turn.before, after);
    if (concurrentWrites && turn.changes.some((change) => change.revertable)) {
      // 同一份快照差异里分不清哪一个进程写了文件。收起回退权，避免改写插件的结果。
      for (const change of turn.changes) change.revertable = false;
      emit(sess, turn.turn_id, {
        kind: kindNotice,
        text: '本轮与插件网页操作同时运行，项目文件的改动无法区分归属，不能通过本轮回退。',
      });
    }
  } catch (err) {
    scanErr = err as Error;
  }
  turn.ended_at = nowTime();
  if (signal.aborted) turn.status = 'cancelled';
  else if (runErr) {
    turn.status = 'failed';
    turn.error = runErr.message;
  } else if (scanErr) {
    turn.status = 'failed';
    turn.error = '结束快照失败：' + scanErr.message;
  } else turn.status = 'succeeded';
  try {
    saveTurn(p.path, turn);
  } catch {
    // 与 Go 版一样忽略。
  }
  if (turn.kind === 'chat' && turn.status !== 'cancelled') recordUtterance(p, turn, false);
  // 试听确认（gate-final）由编排写 production/approval.json 完成，不走界面按钮接口；落盘后自动预约下一轮接力进入发布/封面阶段。
  if (
    turn.status === 'succeeded' &&
    (turn.changes ?? []).some((c) => c.path === 'production/approval.json' && c.change !== 'deleted')
  ) {
    scheduleGateHandoff(s, p.path, 'gate-final', '试听确认');
  }
  sess.cancel = null;
  updateMeta(sess, (meta) => (meta.running_turn = undefined));
  // 先放写权再发 turn-end：网页收到 turn-end 就可能立刻发下一轮。
  s.release(p.path);
  emit(sess, turn.turn_id, {
    kind: kindTurnEnd,
    text: turn.error || undefined,
    status: turn.status,
    changes: turn.changes ?? undefined,
  });
  drainQueue(s, p, sess);
  // 排队的下一轮先开（它占了写权的话，钩子这次就不跑）：钩子不能挡住用户的下一句话。
  if (turn.status === 'succeeded')
    emitStudioEvent(s, p, 'turn.finished', {
      turn_id: turn.turn_id,
      session_id: turn.session_id,
      changed: (turn.changes ?? []).map((c) => c.path),
    });
}

/**
 * cancelSession 取消会话里正在进行的一轮。keepQueue 为 false 时一并清掉排队的消息：
 * 用户按停止，多半是不想让这些要求接着跑了；「打断并发送」要保留它们。
 */
export function cancelSession(sess: Session, keepQueue: boolean): void {
  const cancel = sess.cancel;
  let dropped = 0;
  if (cancel && !keepQueue) {
    dropped = sess.queue.length;
    sess.queue = [];
  }
  const turnID = sess.meta.running_turn ?? '';
  if (!cancel) throw new Error('这个会话没有正在进行的对话');
  if (dropped > 0) emit(sess, turnID, { kind: kindNotice, text: `已停止，排队的 ${dropped} 条消息不再发送` });
  cancel.abort();
}

/** enqueueTurn 在这一轮进行中收下一条消息：返回 false 表示会话此刻没有在跑，调用方直接开新一轮。 */
export function enqueueTurn(p: Project, sess: Session, req: TurnRequest): boolean {
  validateAttachments(p.path, req.attachments);
  if (!sess.cancel) return false;
  const queued = { ...req, queueID: newID('q') };
  sess.queue.push(queued);
  emit(sess, sess.meta.running_turn ?? '', {
    kind: kindQueued,
    text: req.message + attachmentText(req.attachments),
    queue_id: queued.queueID,
  });
  return true;
}

/** unqueue 移除一条排队的消息；找不到（已经发出去了）时返回 false。 */
export function unqueue(sess: Session, queueID: string): boolean {
  const index = sess.queue.findIndex((req) => req.queueID === queueID);
  if (index >= 0) sess.queue.splice(index, 1);
  const found = index >= 0;
  if (found) emit(sess, sess.meta.running_turn ?? '', { kind: kindUnqueued, queue_id: queueID });
  return found;
}

/** steer 把一条排队的消息提到最前，并停掉进行中的一轮：这一轮结束后排队的消息立刻发出。 */
export function steer(sess: Session, queueID: string): boolean {
  const index = sess.queue.findIndex((req) => req.queueID === queueID);
  if (index > 0) {
    const [req] = sess.queue.splice(index, 1);
    sess.queue.unshift(req);
  }
  if (index < 0) return false;
  try {
    cancelSession(sess, true);
    return true;
  } catch {
    return false;
  }
}

/** drainQueue 在一轮结束后把排队的消息合并成下一轮发出。 */
function drainQueue(s: Server, p: Project, sess: Session): void {
  const queue = sess.queue;
  sess.queue = [];
  if (queue.length === 0) return;
  const merged: TurnRequest = { message: '', attachments: null };
  const messages: string[] = [];
  for (const req of queue) {
    messages.push(req.message);
    if (req.attachments && req.attachments.length > 0)
      merged.attachments = [...(merged.attachments ?? []), ...req.attachments];
    if (req.view) merged.view = req.view;
  }
  merged.message = messages.join('\n\n');
  if (queue.length > 1) merged.message = '（上一轮进行中你陆续补充了几条要求，一并处理）\n\n' + merged.message;
  try {
    startTurn(s, p, sess, merged);
  } catch (err) {
    emit(sess, '', {
      kind: kindNotice,
      text: '排队的消息没能发出（' + (err as Error).message + '），请重新发送：' + merged.message,
    });
  }
}

/** revert 回退一轮，并在会话里记一条事件。 */
export function revert(s: Server, p: Project, turnID: string): { turn: Turn; skipped: string[] } {
  const turn = loadTurn(p.path, turnID);
  if (s.hasSharedWriter(p.path)) throw new BusyError('插件网页操作正在运行');
  s.acquire(p.path, '正在回退一轮对话');
  try {
    const skipped = revertTurn(p.path, turn);
    turn.status = 'reverted';
    saveTurn(p.path, turn);
    if (turn.kind === 'chat') recordUtterance(p, turn, true);
    const sess = getSession(s, p.path, turn.session_id);
    if (sess) emit(sess, turn.turn_id, { kind: kindTurnReverted, status: 'reverted', files: skipped });
    return { turn, skipped };
  } finally {
    s.release(p.path);
  }
}
