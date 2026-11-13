/**
 * 后台任务（渲染、拼接、复查、装整片风格……）与它们的事件流。移植自 internal/studio/features.go 里
 * 与 scene / validate 无关的部分：Task、addTask / updateTask / runTask / runWriteTask、/api/tasks、
 * 任务 SSE、runStudioOp。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import { amCommand, envMap, parsePassthrough } from '../envutil';
import { marshal, marshalIndent } from '../gojson';
import { parseWorkerOutput, workerArgs } from '../opworker';
import { ExitError, start } from '../procgroup';
import { goMap, methodNotAllowed, nowTime, writeError, writeJSON } from './http';
import { BusyError, overrideAgents, type AgentChoice } from './sessions';
import type { Project, Server } from './studio';
import { emitStudioEvent } from './events';

export interface Task {
  task_id: string;
  type: string;
  status: string;
  progress: number;
  message: string;
  error?: string;
  /** 任务跑完了，但有要用户留意的事（第三方站的操作写了声明范围之外的文件）。 */
  warning?: string;
  created_at: string;
  updated_at: string;
}

export function taskJSON(t: Task): Record<string, unknown> {
  return {
    task_id: t.task_id,
    type: t.type,
    status: t.status,
    progress: t.progress,
    message: t.message,
    error: t.error || undefined,
    warning: t.warning || undefined,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

export interface TaskEvent {
  event: string;
  task_id: string;
  progress: number;
  message: string;
  timestamp: string;
}

function taskEventJSON(e: TaskEvent): Record<string, unknown> {
  return { event: e.event, task_id: e.task_id, progress: e.progress, message: e.message, timestamp: e.timestamp };
}

/** 任务状态（Go 的 featureState）。 */
export class TaskState {
  readonly tasks = new Map<string, Task>();
  readonly events = new Map<string, TaskEvent[]>();
  readonly cancel = new Map<string, AbortController>();
  seq = 0;
}

function studioTasksPath(s: Server): string {
  try {
    return path.join(s.currentProject().path, 'production', 'studio', 'tasks.json');
  } catch {
    return '';
  }
}

export function loadPersistedTasks(s: Server): void {
  const file = studioTasksPath(s);
  if (file === '') return;
  let list: unknown;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const str = (key: string) => (typeof r[key] === 'string' ? (r[key] as string) : '');
    const t: Task = {
      task_id: str('task_id'),
      type: str('type'),
      status: str('status'),
      progress: typeof r.progress === 'number' ? r.progress : 0,
      message: str('message'),
      error: str('error') || undefined,
      warning: str('warning') || undefined,
      created_at: str('created_at') || '0001-01-01T00:00:00Z',
      updated_at: str('updated_at') || '0001-01-01T00:00:00Z',
    };
    s.tasks.tasks.set(t.task_id, t);
    const events = s.tasks.events.get(t.task_id) ?? [];
    events.push({ event: 'task.restored', task_id: t.task_id, progress: t.progress, message: t.message, timestamp: t.updated_at });
    s.tasks.events.set(t.task_id, events);
  }
}

function persistTasks(s: Server): void {
  const file = studioTasksPath(s);
  if (file === '') return;
  const body = marshalIndent([...s.tasks.tasks.values()].map(taskJSON)) + '\n';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, body, { mode: 0o644 });
  } catch {
    // 与 Go 版一样忽略。
  }
}

/** Go 的 time.Now().UnixNano()。 */
function unixNano(): string {
  return String(BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n));
}

function nextID(s: Server, prefix: string): string {
  s.tasks.seq++;
  return `${prefix}-${unixNano()}-${s.tasks.seq}`;
}

export function addTask(s: Server, type: string, message: string): Task {
  const id = nextID(s, 'task');
  const now = nowTime();
  const t: Task = { task_id: id, type, status: 'queued', progress: 0, message, created_at: now, updated_at: now };
  s.tasks.tasks.set(id, t);
  const events = s.tasks.events.get(id) ?? [];
  events.push({ event: 'task.queued', task_id: id, progress: 0, message, timestamp: now });
  s.tasks.events.set(id, events);
  persistTasks(s);
  return t;
}

export function updateTask(s: Server, id: string, status: string, message: string, progress: number, taskErr: Error | null): void {
  const t = s.tasks.tasks.get(id);
  if (!t) return;
  t.status = status;
  t.message = message;
  t.progress = progress;
  t.updated_at = nowTime();
  if (taskErr) t.error = taskErr.message;
  let event = 'task.progress';
  if (status === 'succeeded') event = 'task.completed';
  if (status === 'failed') event = 'task.failed';
  s.tasks.events.get(id)?.push({ event, task_id: id, progress, message, timestamp: t.updated_at });
  persistTasks(s);
}

/** 给任务记一条提醒（与成败无关，界面用警示样式显示）。 */
export function warnTask(s: Server, id: string, warning: string): void {
  const t = s.tasks.tasks.get(id);
  if (!t) return;
  t.warning = warning;
  persistTasks(s);
}

export function runTask(s: Server, t: Task, work: (signal: AbortSignal) => Promise<void>): void {
  updateTask(s, t.task_id, 'running', '正在处理', 0.1, null);
  const controller = new AbortController();
  s.tasks.cancel.set(t.task_id, controller);
  void (async () => {
    let err: Error | null = null;
    try {
      await work(controller.signal);
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    s.tasks.cancel.delete(t.task_id);
    if (s.tasks.tasks.get(t.task_id)?.status === 'cancelled') return;
    if (err) {
      updateTask(s, t.task_id, 'failed', err.message, 1, err);
      return;
    }
    updateTask(s, t.task_id, 'succeeded', '任务完成', 1, null);
    // 第三方站自己的任务不发：免得钩子互相触发、没完没了。
    if (!t.type.startsWith('station.')) {
      try {
        emitStudioEvent(s, s.currentProject(), 'task.finished', { task: t.type, message: t.message });
      } catch {
        // 没有打开的项目：不发。
      }
    }
  })();
}

/**
 * runWriteTask 占用项目写权后再跑任务，任务结束时释放。渲染、拼接、复查都会改项目文件，
 * 不能和一轮对话同时进行：快照会把任务写的文件算进那一轮的改动，回退时误删。
 */
export function runWriteTask(s: Server, p: Project, type: string, message: string, work: (signal: AbortSignal, t: Task) => Promise<void>): Task {
  s.acquire(p.path, message);
  const t = addTask(s, type, message);
  runTask(s, t, async (signal) => {
    try {
      await work(signal, t);
    } finally {
      s.release(p.path);
    }
  });
  return t;
}

/** writeTaskError 把 BusyError 写成 409，其他错误写成 500。 */
export function writeTaskError(err: unknown): Response {
  if (err instanceof BusyError) return writeError(409, 'project_busy', err.message);
  return writeError(500, 'task_failed', (err as Error).message);
}

/** 一条操作跑完的结果：操作写下的文字与结构化的 data。 */
export interface OpOutcome {
  text: string;
  data?: unknown;
}

export function runStudioOp(s: Server, signal: AbortSignal, p: Project, name: string, params: Record<string, unknown>, opts: OpRunOptions = {}): Promise<OpOutcome> {
  return runStudioOpWith(s, signal, p, { tool: '', renderer: '' }, name, params, opts);
}

export interface OpRunOptions {
  /** 额外的环境变量（如 opworker.OpScopeEnv）。 */
  env?: Record<string, string>;
  /** 边跑边收到的文字（第三方站的进度行由调用方解析）。 */
  onText?: (text: string) => void;
}

/**
 * runStudioOpWith 在执行进程里跑一条 am 操作（`am.cjs __op <名字> <参数>`，见 opworker），
 * 用网页选的工具覆盖项目配置：子进程环境里的 RENDERER 优先于 article-to-motion.conf，
 * scene_run 因此用网页选的渲染工具。参数按名字给，不拼命令行。
 */
export async function runStudioOpWith(
  s: Server,
  signal: AbortSignal,
  p: Project,
  choice: AgentChoice,
  name: string,
  params: Record<string, unknown>,
  opts: OpRunOptions = {},
): Promise<OpOutcome> {
  // Windows 上 executable 是 am.cjs，用 Electron / Node 来跑（envutil.amCommand）。
  const am = amCommand(s.executable());
  const projectConfig = overrideAgents(config.load(p.path, null), choice);
  const args = [...am.args, ...(s.config.unsafe ? ['--unsafe'] : []), ...workerArgs(name, params)];
  const env = { ...config.childEnvironment(projectConfig, envMap(), s.config.unsafe, parsePassthrough(process.env.AM_PASSTHROUGH_ENV ?? '')), ...am.env, ...(opts.env ?? {}) };
  const started = await start(am.command, args, { cwd: p.path, env, stdio: ['ignore', 'pipe', 'pipe'], signal });
  const chunks: Buffer[] = [];
  started.child.stdout!.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    opts.onText?.(chunk.toString('utf8'));
  });
  started.child.stderr!.on('data', (chunk: Buffer) => chunks.push(chunk));
  let waitErr: unknown = null;
  try {
    await started.wait();
  } catch (e) {
    waitErr = e;
  }
  const { text, result } = parseWorkerOutput(Buffer.concat(chunks).toString('utf8'));
  if (result?.ok) return { text, data: result.data };
  // 失败原因放在前面；操作写下的文字（例如逐条列出的不合格项）接在后面。
  const reason = result?.error ?? (waitErr instanceof ExitError ? waitErr.message : waitErr ? (waitErr as Error).message : '执行进程意外退出');
  const detail = text.trim();
  throw new Error(detail === '' || detail.includes(reason) ? reason : `${reason}\n${detail.slice(-4000)}`);
}

export function tasksAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  return writeJSON(200, goMap({ tasks: [...s.tasks.tasks.values()].map(taskJSON) }));
}

export function taskFeatureAPI(s: Server, request: Request, rest: string): Response {
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length === 0 || parts[0] === '') return writeError(404, 'task_not_found', '任务不存在');
  const t = s.tasks.tasks.get(parts[0]);
  if (!t) return writeError(404, 'task_not_found', '任务不存在');
  const events = [...(s.tasks.events.get(parts[0]) ?? [])];
  if (parts.length > 1 && parts[1] === 'events') return taskSSE(s, request, parts[0], events);
  if (parts.length > 1 && parts[1] === 'cancel' && request.method === 'POST') {
    if (t.status !== 'queued' && t.status !== 'running') return writeError(409, 'task_not_cancellable', '任务已经结束');
    s.tasks.cancel.get(t.task_id)?.abort();
    updateTask(s, t.task_id, 'cancelled', '用户已取消', t.progress, null);
    return writeJSON(200, goMap({ task_id: t.task_id, status: 'cancelled' }));
  }
  return writeJSON(200, taskJSON(t));
}

function taskSSE(s: Server, request: Request, taskID: string, events: TaskEvent[]): Response {
  const encoder = new TextEncoder();
  const frame = (ev: TaskEvent) => encoder.encode(`event: ${ev.event}\ndata: ${marshal(taskEventJSON(ev))}\n\n`);
  const follow = new URL(request.url).searchParams.get('follow') === '1';
  let timer: NodeJS.Timeout | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(frame(ev));
      if (!follow) {
        controller.close();
        return;
      }
      let seen = events.length;
      const stop = () => {
        if (timer) clearInterval(timer);
        timer = undefined;
      };
      request.signal.addEventListener('abort', () => {
        stop();
        try {
          controller.close();
        } catch {
          // 已经关了。
        }
      });
      timer = setInterval(() => {
        const current = s.tasks.events.get(taskID) ?? [];
        const status = s.tasks.tasks.get(taskID)?.status ?? '';
        for (const ev of current.slice(seen)) controller.enqueue(frame(ev));
        seen = current.length;
        if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
          stop();
          controller.close();
        }
      }, 250);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
