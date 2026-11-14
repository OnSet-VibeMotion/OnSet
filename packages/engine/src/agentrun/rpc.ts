/**
 * 按行收发的 JSON-RPC 2.0（ACP 与 codex app-server 都是这种 stdio 传输）。
 *
 * 编排工具既回答我们的请求，也反过来向我们发请求（权限审批、读写文件……），所以这里是双向的：
 * request() 发请求等结果，onRequest 处理对方的请求，onNotification 收通知。认不出的对方请求一律回
 * method not found，不让对方干等。
 */
import type { Writable } from 'node:stream';

export interface RPCError {
  code: number;
  message: string;
  data?: unknown;
}

/** 对方回了 error。 */
export class RPCRequestError extends Error {
  constructor(
    readonly method: string,
    readonly error: RPCError,
  ) {
    super(`${method}：${error.message}`);
    this.name = 'RPCRequestError';
  }
}

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

export class RPCPeer {
  private nextID = 1;
  private readonly waiting = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private readonly handlers = new Map<string, RequestHandler>();
  private notify: (method: string, params: unknown) => void = () => {};
  private closedError: Error | null = null;

  constructor(
    private readonly out: Writable,
    /** 每一行原样交给它（排查格式变化用）。 */
    private readonly raw?: (direction: 'in' | 'out', line: string) => void,
  ) {
    out.on('error', () => {});
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notify = handler;
  }

  private write(message: Record<string, unknown>): void {
    const line = JSON.stringify({ jsonrpc: '2.0', ...message });
    this.raw?.('out', line);
    if (!this.out.writableEnded) this.out.write(line + '\n');
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { method, resolve, reject });
      this.write({ id, method, params });
    });
  }

  notification(method: string, params: unknown): void {
    this.write({ method, params });
  }

  /** 交给它一行输出。不是 JSON 的行忽略（有的工具会往 stdout 打日志）。 */
  handleLine(line: string): void {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim() === '') return;
    this.raw?.('in', line);
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: RPCError };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg === null || typeof msg !== 'object') return;
    if (typeof msg.method === 'string') {
      if (msg.id === undefined || msg.id === null) {
        this.notify(msg.method, msg.params);
        return;
      }
      void this.answer(msg.id, msg.method, msg.params);
      return;
    }
    if (typeof msg.id === 'number' && this.waiting.has(msg.id)) {
      const pending = this.waiting.get(msg.id)!;
      this.waiting.delete(msg.id);
      if (msg.error) pending.reject(new RPCRequestError(pending.method, msg.error));
      else pending.resolve(msg.result);
    }
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method);
    if (!handler) {
      this.write({ id, error: { code: -32601, message: 'method not found: ' + method } });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ id, result: result ?? {} });
    } catch (err) {
      this.write({ id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  /** 进程退出了：还在等结果的请求一律失败，不再挂着。 */
  close(reason: Error): void {
    this.closedError = reason;
    for (const pending of this.waiting.values()) pending.reject(reason);
    this.waiting.clear();
  }
}
