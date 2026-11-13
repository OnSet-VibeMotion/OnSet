/**
 * 会话、轮次、命令、只读文件与技能的接口。
 *
 * /preview/scenes/ 与 sceneAttachment（镜头抽帧附件）在 features.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import { goClean, goTrimSpace } from '../gofmt';
import { marshal } from '../gojson';
import * as plugin from '../plugin';
import * as project from '../project';
import type { ViewState } from '../studioview';
import { decodeChoice, withDefaults } from './agents';
import { switchSessionAgents } from './agents';
import { isEnvFile } from './api_ui';
import { DecodeError, decodeJSON, fieldArray, fieldBool, fieldInt, fieldNumber, fieldObject, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { discoverScenes, fileExists } from './scenes';
import {
  BusyError,
  NotExistError,
  cancelSession,
  containedPath,
  createSession,
  emit,
  enqueueTurn,
  eventsAfter,
  getSession,
  listSessions,
  revert,
  sessionEventJSON,
  sessionMetaJSON,
  startTurn,
  steer,
  unqueue,
  validateChoice,
  type Attachment,
  type Session,
} from './sessions';
import type { Server } from './studio';
import { answerPermission } from './permissions';
import { runStudioOp, runWriteTask, writeTaskError } from './tasks';
import { ConflictError, isContentState, loadTurn, readBlob, turnJSON, validID } from './turns';

/** maxFileBytes 是 /api/files 返回正文的上限。 */
const maxFileBytes = 2 << 20;

/** sseHeartbeat 是 SSE 连接上没有事件时发注释行的间隔，防止代理与浏览器断开空闲连接。 */
const sseHeartbeat = 15_000;

/** writeStartError 把发起对话时的错误映射成状态码。 */
function writeStartError(err: unknown): Response {
  if (err instanceof BusyError) return writeError(409, 'project_busy', err.message);
  return writeError(400, 'turn_rejected', (err as Error).message);
}

/** 从请求体解出附件列表（json.Unmarshal 进 []Attachment）。 */
export function decodeAttachments(value: unknown[] | undefined): Attachment[] | null {
  if (!value) return null;
  return value.map((item) => {
    if (item === null) return {};
    if (typeof item !== 'object' || Array.isArray(item)) throw new DecodeError('json: cannot unmarshal into Go struct field of type studio.Attachment');
    const raw = item as Record<string, unknown>;
    const region = fieldObject(raw, 'region');
    const a: Attachment = {
      scene_id: fieldString(raw, 'scene_id') || undefined,
      path: fieldString(raw, 'path') || undefined,
      seconds: fieldNumber(raw, 'seconds') || undefined,
      region: region ? { x: fieldInt(region, 'x'), y: fieldInt(region, 'y'), w: fieldInt(region, 'w'), h: fieldInt(region, 'h') } : undefined,
      selector: fieldString(raw, 'selector') || undefined,
      source: fieldString(raw, 'source') || undefined,
      note: fieldString(raw, 'note') || undefined,
      upload: fieldBool(raw, 'upload') || undefined,
      name: fieldString(raw, 'name') || undefined,
      size: fieldInt(raw, 'size') || undefined,
      quote: fieldString(raw, 'quote') || undefined,
      label: fieldString(raw, 'label') || undefined,
      ref: fieldBool(raw, 'ref') || undefined,
    };
    return a;
  });
}

function decodeView(value: Record<string, unknown> | undefined): ViewState | null {
  if (!value) return null;
  return { page: fieldString(value, 'page') || undefined, scene: fieldString(value, 'scene') || undefined, file: fieldString(value, 'file') || undefined };
}

export async function sessionsAPI(s: Server, request: Request): Promise<Response> {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  switch (request.method) {
    case 'GET':
      return writeJSON(200, goMap({ sessions: listSessions(s, p.path).map(sessionMetaJSON), busy: s.busyHolder(p.path) }));
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
      if (parts.length !== 3 || !/^[a-z0-9-]{1,64}$/.test(parts[2])) return writeError(404, 'not_found', '审批请求不存在');
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
      if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') return writeError(400, 'invalid_decision', 'decision 只能是 allow、always 或 deny');
      let ok: boolean;
      try {
        ok = answerPermission(p.path, sess.permissions, parts[2], decision, message.trim(), (turn, event) => emit(sess, turn, event));
      } catch (err) {
        return writeError(400, 'invalid_decision', (err as Error).message);
      }
      if (!ok) return writeError(409, 'not_pending', '这条请求已经答过，或这一轮已经结束');
      return writeJSON(200, goMap({ ok: true }));
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
    default:
      return writeError(404, 'not_found', '会话接口不存在');
  }
}

/** strconv.Atoi：不是十进制整数时为 0（Go 版忽略错误）。 */
function atoi(value: string | null): number {
  if (value === null || !/^[+-]?\d+$/.test(value)) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : 0;
}

/**
 * sessionEvents 用 SSE 推送会话事件。先补发 Last-Event-ID（或 ?after=）之后的全部事件，
 * 然后等新事件；连接一直保持到客户端断开，事件 id 就是 seq，断线重连不丢不重。
 */
export function sessionEvents(request: Request, sess: Session): Response {
  const url = new URL(request.url);
  let after = atoi(request.headers.get('Last-Event-ID'));
  const afterParam = url.searchParams.get('after');
  if (afterParam !== null && afterParam !== '') after = atoi(afterParam);
  const follow = url.searchParams.get('follow') !== '0';
  const encoder = new TextEncoder();
  let closed = false;
  let wake: (() => void) | null = null;
  const stop = (): void => {
    closed = true;
    wake?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      request.signal.addEventListener('abort', stop, { once: true });
      void (async () => {
        try {
          while (!closed) {
            const { events } = eventsAfter(sess, after);
            for (const event of events) {
              controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${marshal(sessionEventJSON(event))}\n\n`));
              after = event.seq;
            }
            if (!follow) break;
            // 注册等待与上面的读取之间没有 await：不会漏掉这期间的事件。
            let heartbeat = false;
            await new Promise<void>((resolve) => {
              const done = (): void => {
                clearTimeout(timer);
                sess.waiters.delete(done);
                wake = null;
                resolve();
              };
              const timer = setTimeout(() => {
                heartbeat = true;
                done();
              }, sseHeartbeat);
              wake = done;
              sess.waiters.add(done);
            });
            if (heartbeat && !closed) controller.enqueue(encoder.encode(': keep-alive\n\n'));
          }
        } catch {
          // 连接已经断开：enqueue 会抛错，结束即可。
        }
        try {
          controller.close();
        } catch {
          // 已经关了。
        }
      })();
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  });
}

export async function productionStartAPI(s: Server, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  let message: string;
  let promptOverride: string;
  let attachments: Attachment[] | null;
  let choice;
  try {
    const body = await decodeJSON(request);
    message = fieldString(body, 'message');
    promptOverride = fieldString(body, 'prompt');
    // attachments 是首页一起交上来的文章、素材（已经上传到 production/studio/uploads/）。
    attachments = decodeAttachments(fieldArray(body, 'attachments'));
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
  let override = '';
  if (promptOverride !== '') {
    try {
      override = containedPath(p.path, promptOverride);
    } catch (err) {
      return writeError(400, 'invalid_prompt', (err as Error).message);
    }
  }
  let prompt: Buffer;
  let promptPath: string;
  try {
    ({ prompt, path: promptPath } = project.runPrompt(p.path, override));
  } catch (err) {
    return writeError(400, 'prompt_missing', (err as Error).message);
  }
  let cfg: config.Config;
  try {
    cfg = config.load(p.path, null);
  } catch (err) {
    return writeError(400, 'invalid_config', (err as Error).message);
  }
  const holder = s.busyHolder(p.path);
  if (holder !== '') return writeError(409, 'project_busy', new BusyError(holder).message);
  const rel = path.relative(p.path, promptPath).split(path.sep).join('/');
  let sess: Session;
  try {
    sess = createSession(s, p.path, 'production', '整片制作（' + rel + '）', withDefaults(choice, cfg));
  } catch (err) {
    return writeError(500, 'session_failed', (err as Error).message);
  }
  try {
    const turn = startTurn(s, p, sess, { message: goTrimSpace(message), prompt: prompt.toString('utf8'), attachments });
    return writeJSON(202, goMap({ session_id: sess.meta.session_id, turn_id: turn.turn_id, prompt: rel }));
  } catch (err) {
    return writeStartError(err);
  }
}

/** turnAPI 处理 /api/turns/{id}、/api/turns/{id}/file?path=、/api/turns/{id}/revert。 */
export function turnAPI(s: Server, request: Request, rest: string): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/');
  let turn;
  try {
    turn = loadTurn(p.path, parts[0]);
  } catch {
    return writeError(404, 'turn_not_found', '这一轮不存在');
  }
  const action = parts.length > 1 ? parts[1] : '';
  switch (action) {
    case '':
      turn.before = null;
      turn.after = null;
      return writeJSON(200, turnJSON(turn));
    case 'file': {
      const rel = new URL(request.url).searchParams.get('path') ?? '';
      let change;
      for (const c of turn.changes ?? []) if (c.path === rel) change = c;
      if (!change) return writeError(404, 'file_not_changed', '这一轮没有改动这个文件');
      let before: Buffer | null;
      let after: Buffer | null;
      try {
        before = readBlob(p.path, turn.before?.[rel]);
        after = readBlob(p.path, turn.after?.[rel]);
      } catch (err) {
        return writeError(500, 'blob_missing', (err as Error).message);
      }
      return writeJSON(
        200,
        goMap({
          path: rel,
          change: change.change,
          text: change.revertable || isContentState(turn.before?.[rel]) || isContentState(turn.after?.[rel]),
          before: (before ?? Buffer.alloc(0)).toString('utf8'),
          after: (after ?? Buffer.alloc(0)).toString('utf8'),
        }),
      );
    }
    case 'revert': {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      try {
        const { turn: reverted, skipped } = revert(s, p, turn.turn_id);
        return writeJSON(200, goMap({ turn_id: reverted.turn_id, status: reverted.status, skipped }));
      } catch (err) {
        if (err instanceof ConflictError) return writeJSON(409, goMap({ code: 'revert_conflict', message: err.message, paths: err.paths }));
        if (err instanceof BusyError) return writeError(409, 'project_busy', err.message);
        return writeError(409, 'revert_rejected', (err as Error).message);
      }
    }
    default:
      return writeError(404, 'not_found', '接口不存在');
  }
}

/**
 * studioCommands 是可以从网页直接触发的确定性步骤。它们不经过编排工具，
 * 参数只有镜头 id（beat.regrid 另收两个整数：拍号与起始拍），不接受任意命令行。
 * 内置插件登记的校验器另有 `<id>.check`（例如发布的 publish.check），见 pluginCheck。
 */
export const studioCommands: Readonly<Record<string, string>> = {
  'scene.validate': '校验镜头',
  'project.concat': '拼接无声母版',
  'beat.confirm': '确认卡点网格',
  'beat.regrid': '重排重拍',
};

export async function commandAPI(s: Server, request: Request, rest: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const name = rest.replace(/^\/+|\/+$/g, '');
  const validator = plugin.pluginValidators().find((v) => `${v.value.id}.check` === name)?.value;
  if (!Object.hasOwn(studioCommands, name) && !validator) return writeError(404, 'unknown_command', '不支持的命令：' + name);
  let label = validator ? validator.label : studioCommands[name];
  let sceneID: string;
  let body: Record<string, unknown>;
  try {
    body = await decodeJSON(request);
    sceneID = fieldString(body, 'scene_id');
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    throw err;
  }
  let op: { name: string; params: Record<string, unknown> } | null = null;
  switch (name) {
    case 'scene.validate':
      for (const sc of discoverScenes(p.path)) if (sc.id === sceneID) op = { name: 'scene_lint', params: { scene: sc.directory } };
      if (!op) return writeError(404, 'scene_not_found', '镜头不存在');
      label += ' ' + sceneID;
      break;
    case 'project.concat':
      op = { name: 'concat', params: { scenes: path.join(p.path, 'scenes'), out: path.join(p.path, 'production', 'silent-master.mp4') } };
      break;
    case 'beat.confirm':
      op = { name: 'beat_confirm', params: { project_root: p.path } };
      break;
    case 'beat.regrid': {
      const meter = body.meter;
      const anchor = body.anchor;
      if (!Number.isInteger(meter) || !Number.isInteger(anchor) || (meter as number) < 1 || (meter as number) > 16 || (anchor as number) < 0 || (anchor as number) >= (meter as number)) {
        return writeError(400, 'invalid_regrid', '拍号要在 1..16 之间，起始拍要在 0..拍号-1 之间');
      }
      op = { name: 'beat_regrid', params: { meter, anchor, project_root: p.path } };
      label += `（${meter} 拍，从第 ${(anchor as number) + 1} 拍起）`;
      break;
    }
  }
  if (validator) {
    // 内置插件登记的校验器：校验项目里的一个文件。
    const file = path.join(p.path, validator.file);
    if (!fileExists(file)) return writeError(400, `${validator.id}_missing`, `找不到 ${validator.file}`);
    op = { name: validator.op, params: { file, project_root: p.path } };
  }
  const call = op!;
  try {
    const t = runWriteTask(s, p, name, label, async (signal) => {
      if (name === 'project.concat') fs.mkdirSync(path.join(p.path, 'production'), { recursive: true, mode: 0o755 });
      await runStudioOp(s, signal, p, call.name, call.params);
    });
    return writeJSON(202, goMap({ task_id: t.task_id, command: name }));
  } catch (err) {
    return writeTaskError(err);
  }
}

/** filesAPI 只读返回项目里的一个文件。超过上限或含 NUL 的按二进制处理，不返回正文。 */
export function filesAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const rel = new URL(request.url).searchParams.get('path') ?? '';
  let file: string;
  try {
    file = containedPath(p.path, rel);
  } catch (err) {
    if (err instanceof NotExistError) return writeError(404, 'file_not_found', '文件不存在');
    return writeError(400, 'invalid_path', (err as Error).message);
  }
  if (isEnvFile(file)) return writeError(403, 'secret_file', 'Studio 不读取 .env');
  let info: fs.Stats;
  try {
    info = fs.statSync(file);
  } catch {
    return writeError(404, 'file_not_found', '文件不存在');
  }
  if (info.isDirectory()) return writeError(404, 'file_not_found', '文件不存在');
  const result: Record<string, unknown> = { path: goClean(rel), size: info.size, binary: true, content: '' };
  if (info.size <= maxFileBytes) {
    try {
      const body = fs.readFileSync(file);
      if (!body.subarray(0, 8192).includes(0)) {
        result.binary = false;
        result.content = body.toString('utf8');
      }
    } catch {
      // 读不了就按二进制。
    }
  }
  return writeJSON(200, goMap(result));
}
