/**
 * 会话请求解码与 SSE 事件流。
 */
import { marshal } from '../gojson';
import type { ViewState } from '../studioview';
import { DecodeError, fieldBool, fieldInt, fieldNumber, fieldObject, fieldString, writeError } from './http';
import { type Attachment, BusyError, eventsAfter, type Session, sessionEventJSON } from './sessions';

/** sseHeartbeat 是 SSE 连接上没有事件时发注释行的间隔，防止代理与浏览器断开空闲连接。 */
const sseHeartbeat = 15_000;

/** writeStartError 把发起对话时的错误映射成状态码。 */
export function writeStartError(err: unknown): Response {
  if (err instanceof BusyError) return writeError(409, 'project_busy', err.message);
  return writeError(400, 'turn_rejected', (err as Error).message);
}

/** 从请求体解出附件列表（json.Unmarshal 进 []Attachment）。 */
export function decodeAttachments(value: unknown[] | undefined): Attachment[] | null {
  if (!value) return null;
  return value.map((item) => {
    if (item === null) return {};
    if (typeof item !== 'object' || Array.isArray(item)) {
      throw new DecodeError('json: cannot unmarshal into Go struct field of type studio.Attachment');
    }
    const raw = item as Record<string, unknown>;
    const region = fieldObject(raw, 'region');
    const a: Attachment = {
      scene_id: fieldString(raw, 'scene_id') || undefined,
      path: fieldString(raw, 'path') || undefined,
      seconds: fieldNumber(raw, 'seconds') || undefined,
      region: region
        ? { x: fieldInt(region, 'x'), y: fieldInt(region, 'y'), w: fieldInt(region, 'w'), h: fieldInt(region, 'h') }
        : undefined,
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

export function decodeView(value: Record<string, unknown> | undefined): ViewState | null {
  if (!value) return null;
  return {
    page: fieldString(value, 'page') || undefined,
    scene: fieldString(value, 'scene') || undefined,
    file: fieldString(value, 'file') || undefined,
  };
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
  // 两个都有时取大的：客户端先取完历史再带 ?after= 订阅，断线重连时 EventSource 另带 Last-Event-ID，
  // 那是它最后收到的一条，比 ?after= 新。
  let after = atoi(request.headers.get('Last-Event-ID'));
  const afterParam = url.searchParams.get('after');
  if (afterParam !== null && afterParam !== '') after = Math.max(after, atoi(afterParam));
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
              controller.enqueue(
                encoder.encode(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${marshal(sessionEventJSON(event))}\n\n`),
              );
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
