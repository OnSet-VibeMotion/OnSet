/**
 * 编排工具在执行过程中向客户端用户发起结构化多题提问（studio_ask）的文件收件箱通道。
 * 数据契约、校验与格式化见 ./questions_schema.ts。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const tmp = path.join(
    path.dirname(file),
    '.' + path.basename(file) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp',
  );
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function readJSON<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
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

/** 标记该请求因工具超时预算移交回合（卡片跨轮保持可答，不标过期）。 */
export function writeQuestionDeferred(inbox: string, id: string): boolean {
  if (!fs.existsSync(requestFile(inbox, id)) || fs.existsSync(responseFile(inbox, id))) return false;
  writeAtomic(deferredFile(inbox, id), marshal({ id, deferred: true }) + '\n');
  return true;
}

/** 后端写回答复；已答过返回 false 防止重复提交。 */
export function writeQuestionResponse(inbox: string, id: string, response: QuestionResponse): boolean {
  if (!fs.existsSync(requestFile(inbox, id)) || fs.existsSync(responseFile(inbox, id))) return false;
  writeAtomic(responseFile(inbox, id), marshal(response) + '\n');
  return true;
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
    out.push({
      request,
      answered: fs.existsSync(responseFile(inbox, request.id)),
      deferred: fs.existsSync(deferredFile(inbox, request.id)),
    });
  }
  return out;
}

export type WaitQuestionOutcome =
  | { kind: 'response'; response: QuestionResponse }
  | { kind: 'deferred' }
  | { kind: 'aborted' };

/** 阻塞等待用户答复；可选 timeoutMs 到达时写 deferred 标记并优雅返回移交状态。 */
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
      writeQuestionDeferred(inbox, id);
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
