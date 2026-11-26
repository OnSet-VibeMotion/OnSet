/**
 * 无头浏览器截图专用本地出口代理（HTTP Forward + HTTPS CONNECT）：
 * - isolated 模式（renderHtmlPage）：仅允许访问本次临时回环服务 127.0.0.1:<allowedPort>，
 *   在连接层拒绝一切外部主机、IP 字面量、其他回环端口与 HTTPS CONNECT 隧道。
 * - public 模式（captureViewport）：拦截浏览器发出的全部 HTTP 与 HTTPS CONNECT 连接
 *   （含重定向、页面脚本触发的导航与子资源），逐连接执行公网 IP 校验与 DNS pinning 后再直连已校验地址。
 */
import http from 'node:http';
import net from 'node:net';
import type { DnsResolverDeps } from '../brandkit/network';
import { assertSafeCollectUrl, resolveSafeHost, stripIpv6Brackets } from './http';

export type EgressProxyPolicy =
  | { mode: 'isolated'; allowedPort: number }
  | {
      mode: 'public';
      pinned?: { host: string; address: string; family: 4 | 6 };
      deps?: DnsResolverDeps;
    };

export interface EgressProxyHandle {
  readonly port: number;
  readonly url: string;
  readonly blockedTargets: string[];
  close(): Promise<void>;
}

function parseAuthority(raw: string, defaultPort: number): { host: string; port: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) return null;
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : defaultPort;
    return host && Number.isInteger(port) && port >= 1 && port <= 65535 ? { host, port } : null;
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon > 0 && trimmed.indexOf(':') === colon) {
    const host = trimmed.slice(0, colon);
    const port = Number(trimmed.slice(colon + 1));
    return host && Number.isInteger(port) && port >= 1 && port <= 65535 ? { host, port } : null;
  }
  return { host: trimmed, port: defaultPort };
}

async function resolveTarget(
  host: string,
  port: number,
  scheme: 'http' | 'https',
  policy: EgressProxyPolicy,
): Promise<{ address: string; family: 4 | 6; host: string; port: number }> {
  const bare = stripIpv6Brackets(host).toLowerCase();
  if (policy.mode === 'isolated') {
    if (scheme === 'http' && bare === '127.0.0.1' && port === policy.allowedPort) {
      return { address: '127.0.0.1', family: 4, host: '127.0.0.1', port };
    }
    throw new Error(`隔离渲染模式拒绝外联目标：${host}:${port}`);
  }
  const formattedHost = net.isIPv6(bare) ? `[${bare}]` : bare;
  assertSafeCollectUrl(`${scheme}://${formattedHost}:${port}/`);
  if (policy.pinned && bare === policy.pinned.host.toLowerCase()) {
    return { address: policy.pinned.address, family: policy.pinned.family, host: bare, port };
  }
  const resolved = await resolveSafeHost(bare, policy.deps);
  return { address: resolved.address, family: resolved.family, host: bare, port };
}

/** 启动绑定在 127.0.0.1 随机端口的受控出口代理。 */
export async function startEgressProxy(policy: EgressProxyPolicy): Promise<EgressProxyHandle> {
  const blockedTargets: string[] = [];
  const openSockets = new Set<net.Socket>();
  const track = (sock: net.Socket) => {
    openSockets.add(sock);
    sock.once('close', () => openSockets.delete(sock));
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      let targetUrl: URL;
      try {
        targetUrl = new URL(req.url ?? '');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      if (targetUrl.protocol !== 'http:') {
        blockedTargets.push(targetUrl.href);
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const port = targetUrl.port ? Number(targetUrl.port) : 80;
      let target: { address: string; family: 4 | 6; host: string; port: number };
      try {
        target = await resolveTarget(targetUrl.hostname, port, 'http', policy);
      } catch {
        blockedTargets.push(`${targetUrl.hostname}:${port}`);
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Blocked by OnSet egress policy');
        return;
      }

      const headers: http.OutgoingHttpHeaders = { ...req.headers };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      headers.host = targetUrl.host;

      const upstream = http.request(
        {
          host: target.address,
          family: target.family,
          port: target.port,
          method: req.method,
          path: targetUrl.pathname + targetUrl.search,
          headers,
          agent: false,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on('socket', track);
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Gateway');
      });
      req.pipe(upstream);
    })();
  });

  server.on('connection', track);

  server.on('connect', (req, clientSocket, head) => {
    track(clientSocket as net.Socket);
    void (async () => {
      const parsed = parseAuthority(req.url ?? '', 443);
      if (!parsed || policy.mode === 'isolated') {
        blockedTargets.push(req.url ?? 'unknown');
        clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      let target: { address: string; family: 4 | 6; host: string; port: number };
      try {
        target = await resolveTarget(parsed.host, parsed.port, 'https', policy);
      } catch {
        blockedTargets.push(`${parsed.host}:${parsed.port}`);
        clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      const upstream = net.connect({ host: target.address, port: target.port, family: target.family });
      track(upstream);
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => {
        try {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        } catch {
          // 忽略已关闭套接字
        }
        clientSocket.destroy();
      });
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.on('close', () => upstream.destroy());
      upstream.on('close', () => clientSocket.destroy());
    })();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') reject(new Error('无法启动本地出口代理端口'));
      else resolve(addr.port);
    });
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    blockedTargets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const sock of openSockets) sock.destroy();
        server.close(() => resolve());
      }),
  };
}
