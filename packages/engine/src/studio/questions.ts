/**
 * 一轮对话里编排工具向用户发起的结构化多题提问（见 ../studioview/questions.ts）：
 * 轮询收件目录、发 question / question-deferred 事件、收前端答复并写回响应文件，
 * 或在短超时移交（deferred）后自动把结构化答案作为下一轮消息无缝续接。
 */
import {
  formatQuestionAnswers,
  KindQuestion,
  KindQuestionDeferred,
  KindQuestionResolved,
  listQuestionRequests,
  normalizeQuestionResponse,
  type QuestionAnswerItem,
  type QuestionItem,
  type QuestionRequest,
  type QuestionResolutionStatus,
  type QuestionResponse,
  submitQuestionResponse,
} from '../studioview';
import type { SessionEvent } from './sessions_types';

/** 等用户回答的一组问题。deferred=true 表示工具已优雅结束等待、卡片跨轮保留。 */
export interface PendingQuestion {
  inbox: string;
  turnID: string;
  request: QuestionRequest;
  deferred: boolean;
}

/** question / question-deferred / question-resolved 事件带的字段。 */
export interface QuestionEventData {
  id: string;
  title?: string;
  questions?: QuestionItem[];
  source?: 'tool' | 'prose';
  deferred?: boolean;
  status?: QuestionResolutionStatus;
  answers?: QuestionAnswerItem[];
  answer_map?: Record<string, string | string[]>;
  note?: string;
}

export function questionEventJSON(q: QuestionEventData): Record<string, unknown> {
  return {
    id: q.id,
    title: q.title || undefined,
    questions: q.questions && q.questions.length > 0 ? q.questions : undefined,
    source: q.source || undefined,
    deferred: q.deferred ? true : undefined,
    status: q.status || undefined,
    answers: q.answers && q.answers.length > 0 ? q.answers : undefined,
    answer_map: q.answer_map && Object.keys(q.answer_map).length > 0 ? q.answer_map : undefined,
    note: q.note || undefined,
  };
}

type Emit = (turnID: string, event: { kind: string; question?: QuestionEventData }) => void;

/** 看一遍收件目录：新提问发 question 事件、短超时移交发 question-deferred 事件。 */
export function pollQuestions(
  inbox: string,
  turnID: string,
  pending: Map<string, PendingQuestion>,
  seen: Set<string>,
  deferredSeen: Set<string>,
  emit: Emit,
): void {
  for (const { request, answered, deferred } of listQuestionRequests(inbox)) {
    if (!answered && !seen.has(request.id)) {
      seen.add(request.id);
      pending.set(request.id, { inbox, turnID, request, deferred });
      emit(turnID, {
        kind: KindQuestion,
        question: {
          id: request.id,
          title: request.title,
          questions: request.questions,
          source: request.source ?? 'tool',
        },
      });
    }
    if (deferred && !answered && !deferredSeen.has(request.id)) {
      deferredSeen.add(request.id);
      const item = pending.get(request.id);
      if (item) item.deferred = true;
      emit(turnID, {
        kind: KindQuestionDeferred,
        question: { id: request.id, deferred: true },
      });
    }
  }
}

/** 从历史事件流里恢复跨轮挂起的 deferred 问题（客户端重启后依然可以提交并续接）。 */
export function findDeferredQuestion(events: readonly SessionEvent[], id: string): PendingQuestion | null {
  let req: QuestionRequest | null = null;
  let turnID = '';
  let deferred = false;
  for (const event of events) {
    if (event.kind === KindQuestion && event.question?.id === id && event.question.questions) {
      req = {
        id,
        title: event.question.title,
        questions: event.question.questions,
        source: event.question.source ?? 'tool',
      };
      turnID = event.turn_id ?? '';
    } else if (event.kind === KindQuestionDeferred && event.question?.id === id) {
      deferred = true;
    } else if (event.kind === KindQuestionResolved && event.question?.id === id) {
      return null;
    }
  }
  if (!req || !deferred) return null;
  return { inbox: '', turnID, request: req, deferred: true };
}

export type AnswerQuestionResult =
  | { ok: false }
  | { ok: true; mode: 'live'; response: QuestionResponse }
  | { ok: true; mode: 'deferred'; response: QuestionResponse; message: string };

/**
 * 接收前端提交的回答。
 * - live 模式：经跨进程原子协调状态写回 inbox/<id>.response.json 唤醒阻塞中的 studio_ask 工具；
 * - deferred 模式（含超时抢先移交场景）：先执行可选 onDeferred 续接回调，成功后再消费问题并发出 question-resolved，
 *   确保续接失败（如 project_busy）时问题保留在 pending 中不丢失用户回答。
 */
export function answerQuestion(
  pending: Map<string, PendingQuestion>,
  events: readonly SessionEvent[],
  id: string,
  rawResponse: unknown,
  emit: Emit,
  onDeferred?: (message: string) => void,
): AnswerQuestionResult {
  const item = pending.get(id) ?? findDeferredQuestion(events, id);
  if (!item) return { ok: false };
  const response = normalizeQuestionResponse(item.request, rawResponse);
  if (!item.deferred) {
    const settled = submitQuestionResponse(item.inbox, id, response);
    if (settled === 'live') {
      pending.delete(id);
      emit(item.turnID, {
        kind: KindQuestionResolved,
        question: {
          id,
          status: response.status,
          answers: response.answers,
          answer_map: response.answer_map,
          note: response.note,
        },
      });
      return { ok: true, mode: 'live', response };
    }
    if (settled === 'already_answered') {
      pending.delete(id);
      return { ok: false };
    }
    // 工具端已在轮询间隙完成超时移交：同步更新状态并无缝转入 deferred 续接分支。
    item.deferred = true;
    emit(item.turnID, { kind: KindQuestionDeferred, question: { id, deferred: true } });
  }
  const message = formatQuestionAnswers(item.request, response);
  if (response.status === 'answered' && onDeferred) {
    onDeferred(message);
  }
  pending.delete(id);
  emit(item.turnID, {
    kind: KindQuestionResolved,
    question: {
      id,
      status: response.status,
      answers: response.answers,
      answer_map: response.answer_map,
      note: response.note,
    },
  });
  return {
    ok: true,
    mode: 'deferred',
    response,
    message,
  };
}

/** 这一轮结束：未移交（!deferred）的提问标为 expired；若工具端已抢先移交则跨轮保留。 */
export function expireQuestions(pending: Map<string, PendingQuestion>, turnID: string, emit: Emit): void {
  for (const [id, item] of [...pending]) {
    if (item.turnID !== turnID || item.deferred) continue;
    const settled = submitQuestionResponse(item.inbox, id, { status: 'expired' });
    if (settled === 'deferred') {
      item.deferred = true;
      emit(turnID, { kind: KindQuestionDeferred, question: { id, deferred: true } });
      continue;
    }
    pending.delete(id);
    emit(turnID, { kind: KindQuestionResolved, question: { id, status: 'expired' } });
  }
}
