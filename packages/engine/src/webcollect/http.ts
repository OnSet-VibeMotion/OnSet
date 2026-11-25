/**
 * 网站素材采集的安全 HTTP/HTTPS 抓取层：
 * - 强制复用 brandkit/network.ts 的公网 IP 校验、Fake-IP DoH 复验与 DNS-pinning 逻辑；
 * - 仅允许公开 HTTP/HTTPS 协议，拒绝 file://、ftp://、内网 IP、本地主机与带凭据 URL；
 * - 逐跳核验 3xx 重定向目标，拦截任何跳往内网或非 HTTP/HTTPS 协议的恶意重定向；
 * - 支持字节上限、超时、AbortSignal 与可注入 transport（便于离线单元测试）。
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {
  assertSafePublicUrl,
  type DnsResolverDeps,
  isPublicIP,
  MaxBrandRedirects,
  resolvePublicHost,
} from '../brandkit/network';
import {
  MaxCollectedFileBytes,
  type SafeFetchOptions,
  type SafeFetchResponse,
  type SafeHttpRawResponse,
  type SafeHttpRequest,
  type SafeHttpTransport,
} from './types';

const BrowserUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 去掉 URL.hostname 中 IPv6 字面量外层的方括号。 */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * 补齐 WHATWG URL 对 IPv4-mapped IPv6 的十六进制规范化形式（例如 ::ffff:127.0.0.1 -> ::ffff:7f00:1），
 * 还原成点分十进制 IPv4 后复用 brandkit/network.ts 的 isPublicIP 判定。
 */
function isSafePublicIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase();
  const hexMapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return isPublicIP(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  if (ip.startsWith('64:ff9b::')) return false; // NAT64 well-known prefix
  return isPublicIP(ip);
}

/** 校验并规范化公开 HTTP/HTTPS 地址（复用 brandkit/network.ts 的公网边界校验）。 */
export function assertSafeCollectUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`无效的网址：${rawUrl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`仅支持公开 HTTP/HTTPS 网址，已拒绝协议：${url.protocol}`);
  }
  const bareHost = stripIpv6Brackets(url.hostname.toLowerCase());
  const trimmedHost = bareHost.replace(/\.+$/, '');
  if (
    !trimmedHost ||
    trimmedHost === 'localhost' ||
    trimmedHost.endsWith('.local') ||
    trimmedHost.endsWith('.internal')
  ) {
    throw new Error(`拒绝访问本地或内网域名：${url.hostname}`);
  }
  if (net.isIP(bareHost) && !isSafePublicIp(bareHost)) {
    throw new Error(`拒绝访问非公网 IP 地址：${bareHost}`);
  }
  // 将 http: 视同 https: 交由 brandkit/network.ts 的 assertSafePublicUrl 复验，保持安全规则唯一事实源。
  const checkUrl = url.protocol === 'https:' ? url.href : `https:${url.href.slice('http:'.length)}`;
  assertSafePublicUrl(checkUrl);
  return url;
}

function defaultHttpTransport(req: SafeHttpRequest): Promise<SafeHttpRawResponse> {
  const isHttps = req.url.protocol === 'https:';
  const mod = isHttps ? https : http;
  const port = req.url.port ? Number(req.url.port) : isHttps ? 443 : 80;
  return new Promise((resolve, reject) => {
    const clientReq = mod.request(
      {
        hostname: stripIpv6Brackets(req.url.hostname),
        port,
        path: req.url.pathname + req.url.search,
        method: req.method,
        headers: {
          'user-agent': BrowserUserAgent,
          accept: req.accept,
        },
        timeout: req.timeoutMs,
        signal: req.signal,
        lookup: (_host, _options, cb) => cb(null, req.address, req.family),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
        const contentType = String(res.headers['content-type'] ?? '');
        if ((status >= 300 && status < 400 && location) || req.method === 'HEAD') {
          res.resume();
          resolve({ status, location, contentType, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > req.maxBytes) {
            clientReq.destroy(new Error(`资源体积超过上限（${req.maxBytes} 字节）`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    clientReq.on('error', reject);
    clientReq.on('timeout', () => clientReq.destroy(new Error(`抓取超时（${req.timeoutMs}ms）：${req.url.href}`)));
    clientReq.end();
  });
}

async function resolveSafeHost(hostname: string, deps?: DnsResolverDeps): Promise<{ address: string; family: 4 | 6 }> {
  const resolved = await resolvePublicHost(stripIpv6Brackets(hostname), deps);
  if (!isSafePublicIp(resolved.address)) {
    throw new Error(`域名 ${hostname} 解析到非公网地址 ${resolved.address}，已拦截`);
  }
  return resolved;
}

/** 使用 DNS-pinned HTTP/HTTPS 安全抓取二进制或文本资源，逐跳拦截非法重定向。 */
export async function safeFetchBuffer(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const maxBytes = opts.maxBytes ?? MaxCollectedFileBytes;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const accept = opts.accept ?? 'text/html,application/xhtml+xml,image/*,image/svg+xml,*/*;q=0.8';
  const transport = opts.transport ?? defaultHttpTransport;
  let current = assertSafeCollectUrl(rawUrl);

  for (let hop = 0; hop <= MaxBrandRedirects; hop++) {
    const resolved = await resolveSafeHost(current.hostname, opts.deps);
    const result = await transport({
      url: current,
      method: 'GET',
      address: resolved.address,
      family: resolved.family,
      timeoutMs,
      maxBytes,
      accept,
      signal: opts.signal,
    });
    if (result.status >= 300 && result.status < 400 && result.location) {
      current = assertSafeCollectUrl(new URL(result.location, current).href);
      continue;
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`抓取失败（HTTP ${result.status}）：${current.href}`);
    }
    return { url: current.href, status: result.status, contentType: result.contentType, body: result.body };
  }
  throw new Error(`重定向次数超过上限（${MaxBrandRedirects}）`);
}

/**
 * 在启动无头浏览器前执行安全预检：
 * - 校验 URL 协议与公网边界并解析公网 IP；
 * - 当 followRedirects 为 true 时，用轻量 HEAD 请求逐跳追踪 3xx 重定向，拦截跳往内网的重定向链。
 */
export async function preflightSafeUrl(
  rawUrl: string,
  opts: {
    deps?: DnsResolverDeps;
    transport?: SafeHttpTransport;
    timeoutMs?: number;
    signal?: AbortSignal;
    followRedirects?: boolean;
  } = {},
): Promise<{ finalUrl: URL; address: string; family: 4 | 6 }> {
  let current = assertSafeCollectUrl(rawUrl);
  let resolved = await resolveSafeHost(current.hostname, opts.deps);
  if (!opts.followRedirects && !opts.transport) {
    return { finalUrl: current, address: resolved.address, family: resolved.family };
  }
  const transport = opts.transport ?? defaultHttpTransport;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  for (let hop = 0; hop <= MaxBrandRedirects; hop++) {
    resolved = await resolveSafeHost(current.hostname, opts.deps);
    let result: SafeHttpRawResponse;
    try {
      result = await transport({
        url: current,
        method: 'HEAD',
        address: resolved.address,
        family: resolved.family,
        timeoutMs,
        maxBytes: 64 * 1024,
        accept: 'text/html,*/*;q=0.8',
        signal: opts.signal,
      });
    } catch (err) {
      // 若自定义 transport 明确抛错则直接抛出；真实站点拒收 HEAD 时已验证公网 IP，仍放行给后续流程。
      if (opts.transport) throw err;
      return { finalUrl: current, address: resolved.address, family: resolved.family };
    }
    if (result.status >= 300 && result.status < 400 && result.location) {
      current = assertSafeCollectUrl(new URL(result.location, current).href);
      continue;
    }
    return { finalUrl: current, address: resolved.address, family: resolved.family };
  }
  throw new Error(`重定向次数超过上限（${MaxBrandRedirects}）`);
}
