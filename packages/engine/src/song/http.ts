// 歌曲平台客户端用的最小 HTTP 层，对应 Go 的 http.Client + http.RoundTripper。只供本包内部使用。
//
// 网络调用一律经 RoundTripper：测试像 Go 版替换 Transport / http.DefaultTransport 那样
// 换成假的（setDefaultTransport），生产用 node:http / node:https。不用 fetch：Go 版对 GET
// 也会带 JSON 体（ACE-Step 的 /health），fetch 不允许 GET 带体。
import http from 'node:http';
import https from 'node:https';

export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: HttpHeaders;
  /** 响应体；读取中断时迭代抛错（对应 io.Copy 的错误）。 */
  body: AsyncIterable<Uint8Array>;
  /** 对应 resp.Body.Close()：不再读取时释放连接。 */
  close?: () => void;
}

export type RoundTripper = (req: HttpRequest) => Promise<HttpResponse>;

class NodeHeaders implements HttpHeaders {
  constructor(private readonly raw: http.IncomingHttpHeaders) {}
  get(name: string): string | null {
    const v = this.raw[name.toLowerCase()];
    if (v === undefined) return null;
    return Array.isArray(v) ? (v[0] ?? null) : v;
  }
}

/** 生产用的传输：node:http(s)，不跟随重定向（由 HttpClient 拒绝）。 */
export const nodeTransport: RoundTripper = (req) =>
  new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!mod) {
      reject(new Error(`unsupported protocol scheme "${url.protocol.replace(/:$/, '')}"`));
      return;
    }
    const headers: Record<string, string> = { ...req.headers };
    if (req.body) headers['Content-Length'] = String(req.body.length);
    const r = mod.request(url, { method: req.method, headers, signal: req.signal }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: new NodeHeaders(res.headers),
        body: res,
        close: () => res.destroy(),
      });
    });
    r.on('error', reject);
    if (req.body) r.end(req.body);
    else r.end();
  });

let defaultTransport: RoundTripper = nodeTransport;

/** 换掉默认传输（对应测试里替换 http.DefaultTransport），返回原来的那个以便还原。 */
export function setDefaultTransport(t: RoundTripper): RoundTripper {
  const old = defaultTransport;
  defaultTransport = t;
  return old;
}

const redirectStatus = new Set([301, 302, 303, 307, 308]);

/** 对应带 Timeout 与「拒绝重定向」CheckRedirect 的 http.Client。transport 为 null 时用默认传输。 */
export class HttpClient {
  constructor(
    public timeoutMs: number,
    public transport: RoundTripper | null = null,
  ) {}

  async do(req: HttpRequest): Promise<HttpResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const res = await (this.transport ?? defaultTransport)({ ...req, signal });
    if (redirectStatus.has(res.status) && res.headers.get('Location')) {
      res.close?.();
      throw new Error('redirect refused');
    }
    return res;
  }
}

/** 读到最多 limit 字节（对应 io.ReadAll(io.LimitReader(r, limit))）。读取出错时抛出。 */
export async function readLimited(body: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of body) {
    const buf = Buffer.from(chunk);
    if (n + buf.length >= limit) {
      chunks.push(buf.subarray(0, limit - n));
      n = limit;
      break;
    }
    chunks.push(buf);
    n += buf.length;
  }
  return Buffer.concat(chunks, n);
}

/** 可取消的等待，对应 select { case <-ctx.Done(): case <-timer.C: }。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** ctx.Err()：取消原因统一成 Error。 */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    if (reason.name === 'TimeoutError') return new Error('context deadline exceeded');
    if (reason.name === 'AbortError') return new Error('context canceled');
    return reason;
  }
  return new Error(reason === undefined ? 'context canceled' : String(reason));
}
