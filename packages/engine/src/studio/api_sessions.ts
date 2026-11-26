/**
 * 会话、轮次、命令、只读文件与技能的接口。
 *
 * /preview/scenes/ 与 sceneAttachment（镜头抽帧附件）在 features.ts。
 */
import * as config from '../config';
import { goTrimSpace } from '../gofmt';
import type { ViewState } from '../studioview';
import { decodeChoice, switchSessionAgents, withDefaults } from './agents';
import { decodeAttachments, decodeView, sessionEvents, writeStartError } from './api_sessions_events';
import {
  DecodeError,
  decodeJSON,
  fieldArray,
  fieldBool,
  fieldObject,
  fieldString,
  goMap,
  methodNotAllowed,
  writeError,
  writeJSON,
} from './http';
import { answerPermission } from './permissions';
import { answerQuestion } from './questions';
import {
  type Attachment,
  BusyError,
  cancelSession,
  createSession,
  emit,
  enqueueTurn,
  getSession,
  handoffSession,
  listSessions,
  sessionMetaJSON,
  startTurn,
  steer,
  unqueue,
  validateChoice,
} from './sessions';
import type { Server } from './studio';
import { loadTurn, turnJSON, validID } from './turns';

export { decodeAttachments, decodeView, sessionEvents } from './api_sessions_events';
export { commandAPI, filesAPI, productionStartAPI, studioCommands, turnAPI } from './api_sessions_ops';

export async function sessionsAPI(s: Server, request: Request): Promise<Response> {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  switch (request.method) {
    case 'GET':
      return writeJSON(
        200,
        goMap({ sessions: listSessions(s, p.path).map(sessionMetaJSON), busy: s.busyHolder(p.path) }),
      );
    case 'POST': {
      let title: string;
      let choice;
      try {
        const body = await decodeJSON(request);
        title = fieldString(body, 'title');
        choice = decodeChoice(body);
      } catch (err) {
        if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
        throw err;
      }
      try {
        validateChoice(choice);
      } catch (err) {
        return writeError(400, 'invalid_agent', (err as Error).message);
      }
      let cfg: config.Config;
      try {
        cfg = config.load(p.path, null);
      } catch (err) {
        return writeError(400, 'invalid_config', (err as Error).message);
      }
      title = goTrimSpace(title);
      if (title === '') title = '对话 ' + localStamp();
      try {
        const sess = createSession(s, p.path, 'chat', title, withDefaults(choice, cfg));
        return writeJSON(201, sessionMetaJSON(sess.meta));
      } catch (err) {
        return writeError(500, 'session_failed', (err as Error).message);
      }
    }
    default:
      return methodNotAllowed('GET, POST');
  }
}

/** Go 的 time.Now().Format("01-02 15:04")：本地时间。 */
function localStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** sessionAPI 处理 /api/sessions/{id}[/turns|/events|/agents|/queue|/cancel]。 */
export async function sessionAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/');
  if (!validID(parts[0])) return writeError(404, 'session_not_found', '会话不存在');
  const sess = getSession(s, p.path, parts[0]);
  if (!sess) return writeError(404, 'session_not_found', '会话不存在');
  const action = parts.length > 1 ? parts[1] : '';
  switch (action) {
    case '': {
      const turns: Record<string, unknown>[] = [];
      for (const id of sess.meta.turns ?? []) {
        try {
          const turn = loadTurn(p.path, id);
          turn.before = null;
          turn.after = null;
          turns.push(turnJSON(turn));
        } catch {
          // 读不到的轮次跳过。
        }
      }
      return writeJSON(200, goMap({ session: sessionMetaJSON(sess.meta), turns }));
    }
    case 'turns': {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      let message: string;
      let attachments: Attachment[] | null;
      let interrupt: boolean;
      let view: ViewState | null;
      try {
        const body = await decodeJSON(request);
        message = fieldString(body, 'message');
        attachments = decodeAttachments(fieldArray(body, 'attachments'));
        // interrupt 为 true 时停掉进行中的一轮，马上发这条；否则排到这一轮之后。
        interrupt = fieldBool(body, 'interrupt');
        // view 是用户发消息时在看的页面，写进提示词，不显示在对话里。
        view = decodeView(fieldObject(body, 'view'));
      } catch {
        return writeError(400, 'invalid_request', '消息不能为空');
      }
      if (goTrimSpace(message) === '') return writeError(400, 'invalid_request', '消息不能为空');
      const next = { message: goTrimSpace(message), attachments, view };
      let queued: boolean;
      try {
        queued = enqueueTurn(p, sess, next);
      } catch (err) {
        return writeStartError(err);
      }
      if (queued) {
        if (interrupt) {
          try {
            cancelSession(sess, true);
          } catch {
            // 这一轮恰好结束了：排队的消息会照常发出。
          }
        }
        return writeJSON(202, goMap({ queued: true, session_id: sess.meta.session_id }));
      }
      try {
        const turn = startTurn(s, p, sess, next);
        return writeJSON(202, goMap({ turn_id: turn.turn_id, session_id: sess.meta.session_id }));
      } catch (err) {
        return writeStartError(err);
      }
    }
    case 'events':
      return sessionEvents(request, sess);
    case 'agents':
      return switchSessionAgents(request, sess);
    case 'queue': {
      // /api/sessions/{id}/queue/{queue_id}：DELETE 移除，POST …/steer 引导对话。
      if (parts.length < 3 || !validID(parts[2])) return writeError(404, 'not_found', '排队的消息不存在');
      let ok: boolean;
      if (request.method === 'DELETE' && parts.length === 3) ok = unqueue(sess, parts[2]);
      else if (request.method === 'POST' && parts.length === 4 && parts[3] === 'steer') ok = steer(sess, parts[2]);
      else return methodNotAllowed('DELETE, POST');
      if (!ok) return writeError(409, 'not_queued', '这条消息已经发出，或这一轮已经结束');
      return writeJSON(200, goMap({ ok: true }));
    }
    case 'permissions': {
      // /api/sessions/{id}/permissions/{request_id}：POST {"decision":"allow"|"always"|"deny","message"}。
      if (request.method !== 'POST') return methodNotAllowed('POST');
      if (parts.length !== 3 || !/^[a-z0-9-]{1,64}$/.test(parts[2])) {
        return writeError(404, 'not_found', '审批请求不存在');
      }
      let decision = '';
      let message = '';
      try {
        const body = await decodeJSON(request);
        decision = fieldString(body, 'decision');
        message = fieldString(body, 'message');
      } catch (err) {
        if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
        throw err;
      }
      if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') {
        return writeError(400, 'invalid_decision', 'decision 只能是 allow、always 或 deny');
      }
      let ok: boolean;
      try {
        ok = answerPermission(p.path, sess.permissions, parts[2], decision, message.trim(), (turn, event) =>
          emit(sess, turn, event),
        );
      } catch (err) {
        return writeError(400, 'invalid_decision', (err as Error).message);
      }
      if (!ok) return writeError(409, 'not_pending', '这条请求已经答过，或这一轮已经结束');
      return writeJSON(200, goMap({ ok: true }));
    }
    case 'questions': {
      // /api/sessions/{id}/questions/{question_id}：POST {"status":"answered"|"skipped", "answers":[...], "note"?:""}。
      if (request.method !== 'POST') return methodNotAllowed('POST');
      if (parts.length !== 3 || !/^[a-z0-9-]{1,64}$/.test(parts[2])) {
        return writeError(404, 'not_found', '提问请求不存在');
      }
      let body: Record<string, unknown>;
      try {
        body = await decodeJSON(request);
      } catch (err) {
        if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
        throw err;
      }
      let answered;
      try {
        answered = answerQuestion(sess.questions, sess.events, parts[2], body, (turn, event) =>
          emit(sess, turn, event),
        );
      } catch (err) {
        return writeError(400, 'invalid_answer', (err as Error).message);
      }
      if (!answered.ok) return writeError(409, 'not_pending', '这组问题已经答过，或这一轮已经结束');
      if (answered.mode === 'deferred' && answered.response.status === 'answered') {
        const next = { message: answered.message, attachments: null, view: decodeView(fieldObject(body, 'view')) };
        const queued = enqueueTurn(p, sess, next);
        if (queued) return writeJSON(202, goMap({ ok: true, mode: 'deferred', queued: true }));
        try {
          const turn = startTurn(s, p, sess, next);
          return writeJSON(202, goMap({ ok: true, mode: 'deferred', turn_id: turn.turn_id }));
        } catch (err) {
          return writeStartError(err);
        }
      }
      return writeJSON(200, goMap({ ok: true, mode: answered.mode }));
    }
    case 'cancel': {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      try {
        cancelSession(sess, false);
      } catch (err) {
        return writeError(409, 'not_running', (err as Error).message);
      }
      return writeJSON(200, goMap({ ok: true }));
    }
    case 'handoff': {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      let reason = '';
      try {
        const text = await request.text();
        if (text.trim() !== '') {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) reason = fieldString(parsed, 'reason');
        }
      } catch (err) {
        if (err instanceof DecodeError || err instanceof SyntaxError) {
          return writeError(400, 'invalid_json', '请求不是合法 JSON');
        }
        throw err;
      }
      try {
        handoffSession(sess, reason || '手动分段接力');
      } catch (err) {
        if (err instanceof BusyError) return writeError(409, 'project_busy', err.message);
        return writeError(400, 'handoff_rejected', (err as Error).message);
      }
      return writeJSON(200, goMap({ ok: true, session: sessionMetaJSON(sess.meta) }));
    }
    default:
      return writeError(404, 'not_found', '会话接口不存在');
  }
}
