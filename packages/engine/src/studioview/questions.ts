/**
 * 编排工具在执行过程中向客户端用户发起结构化多题提问（studio_ask）的文件收件箱通道。
 * 数据契约、校验与格式化见 ./questions_schema.ts。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshal } from '../gojson';
import {
  normalizeQuestionInput,
  type QuestionRequest,
  type QuestionResponse,
  QuestionsSubdir,
} from './questions_schema';

export * from './questions_schema';

export function questionsDir(inbox: string): string {
  return path.join(inbox, QuestionsSubdir);
}

function requestFile(inbox: string, id: string): string {
  return path.join(questionsDir(inbox), id + '.request.json');
}

function deferredFile(inbox: string, id: string): string {
  return path.join(questionsDir(inbox), id + '.deferred.json');
}

function responseFile(inbox: string, id: string): string {
  return path.join(questionsDir(inbox), id + '.response.json');
}

/** 跨进程唯一协调状态文件（O_CREAT | O_EXCL 原子抢占），防止超时移交与前端实时提交竞态丢答复。 */
function settledFile(inbox: string, id: string): string {
  return path.join(questionsDir(inbox), id + '.settled.json');
}

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  atomicWrite(file, body, 0o644);
}

function readJSON<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

type ClaimOutcome = 'claimed' | 'live' | 'deferred' | 'missing';

function claimSettled(inbox: string, id: string, by: 'live' | 'deferred'): ClaimOutcome {
  if (!fs.existsSync(requestFile(inbox, id))) return 'missing';
  const file = settledFile(inbox, id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  try {
    fs.writeFileSync(file, marshal({ by }) + '\n', { flag: 'wx', mode: 0o644 });
    return 'claimed';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const existing = readJSON<{ by?: string }>(file);
    if (existing?.by === 'deferred') return 'deferred';
    if (existing?.by === 'live') return 'live';
    return fs.existsSync(deferredFile(inbox, id)) && !fs.existsSync(responseFile(inbox, id)) ? 'deferred' : 'live';
  }
}

let lastStamp = 0n;

function nextStamp(): bigint {
  let n = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  if (n <= lastStamp) n = lastStamp + 1n;
  lastStamp = n;
  return n;
}

/** 写一条提问请求进收件目录；返回含编号的完整请求。 */
export function writeQuestionRequest(inbox: string, rawInput: unknown): QuestionRequest {
  const normalized = normalizeQuestionInput(rawInput);
  const id = String(nextStamp()).padStart(20, '0') + '-' + crypto.randomBytes(4).toString('hex');
  const req: QuestionRequest = {
    id,
    ...(normalized.title ? { title: normalized.title } : {}),
    questions: normalized.questions,
    source: 'tool',
  };
  writeAtomic(requestFile(inbox, id), marshal(req) + '\n');
  return req;
}

/** 标记该请求因工具超时预算移交回合（原子抢占 settled 状态，已由实时回答抢占时返回 false）。 */
export function writeQuestionDeferred(inbox: string, id: string): boolean {
  const claim = claimSettled(inbox, id, 'deferred');
  if (claim === 'claimed' || claim === 'deferred') {
    if (!fs.existsSync(deferredFile(inbox, id))) {
      writeAtomic(deferredFile(inbox, id), marshal({ id, deferred: true }) + '\n');
    }
    return true;
  }
  return false;
}

export type SubmitQuestionOutcome = 'live' | 'deferred' | 'already_answered';

/**
 * 后端按统一协调状态提交回答：
 * - live：本进程成功抢占实时通道并写入 response 文件；
 * - deferred：工具端已先抢占超时移交，调用方须走跨轮续接路径，保证移交后回答永不丢失；
 * - already_answered：已被实时回答过或请求不存在。
 */
export function submitQuestionResponse(inbox: string, id: string, response: QuestionResponse): SubmitQuestionOutcome {
  if (inbox === '') return 'already_answered';
  const claim = claimSettled(inbox, id, 'live');
  if (claim === 'claimed') {
    writeAtomic(responseFile(inbox, id), marshal(response) + '\n');
    return 'live';
  }
  if (claim === 'deferred') return 'deferred';
  return 'already_answered';
}

/** 后端写回答复；已答过或已移交返回 false 防止重复提交。 */
export function writeQuestionResponse(inbox: string, id: string, response: QuestionResponse): boolean {
  return submitQuestionResponse(inbox, id, response) === 'live';
}

/** 按写入顺序列出收件目录里的全部提问请求及其状态。 */
export function listQuestionRequests(
  inbox: string,
): Array<{ request: QuestionRequest; answered: boolean; deferred: boolean }> {
  let names: string[];
  try {
    names = fs.readdirSync(questionsDir(inbox)).filter((name) => name.endsWith('.request.json'));
  } catch {
    return [];
  }
  const out: Array<{ request: QuestionRequest; answered: boolean; deferred: boolean }> = [];
  for (const name of names.sort()) {
    const request = readJSON<QuestionRequest>(path.join(questionsDir(inbox), name));
    if (!request || typeof request.id !== 'string' || !Array.isArray(request.questions)) continue;
    const settled = readJSON<{ by?: string }>(settledFile(inbox, request.id));
    out.push({
      request,
      answered: fs.existsSync(responseFile(inbox, request.id)) || settled?.by === 'live',
      deferred: fs.existsSync(deferredFile(inbox, request.id)) || settled?.by === 'deferred',
    });
  }
  return out;
}

export type WaitQuestionOutcome =
  | { kind: 'response'; response: QuestionResponse }
  | { kind: 'deferred' }
  | { kind: 'aborted' };

/** 阻塞等待用户答复；可选 timeoutMs 到达时经原子协调状态写 deferred 标记，若前端抢先提交则直接读回答复。 */
export async function waitQuestionResponse(
  inbox: string,
  id: string,
  interval: number,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<WaitQuestionOutcome> {
  const startedAt = Date.now();
  for (;;) {
    if (signal?.aborted) return { kind: 'aborted' };
    const response = readJSON<QuestionResponse>(responseFile(inbox, id));
    if (response && typeof response.status === 'string') return { kind: 'response', response };
    if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) {
      if (writeQuestionDeferred(inbox, id)) return { kind: 'deferred' };
      // 前端已抢先占下 live 通道，短等 response 文件落盘即返回。
      const graceEnd = Date.now() + 1000;
      while (Date.now() < graceEnd) {
        const late = readJSON<QuestionResponse>(responseFile(inbox, id));
        if (late && typeof late.status === 'string') return { kind: 'response', response: late };
        await new Promise((r) => setTimeout(r, 10));
      }
      return { kind: 'deferred' };
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, interval);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
