/**
 * 官网品牌提取的安全网络边界：
 * - 仅允许公网 HTTPS，拒绝回环、私网、链路本地、CGNAT、文档段与 IPv4-mapped IPv6（防 SSRF）；
 * - 当本机 DNS 返回的全部地址均落入代理 Fake-IP 网段（198.18.0.0/15）时，
 *   通过直连 1.1.1.1 的 Cloudflare DoH 独立解析公网 A 记录并再次核对公网边界；
 * - 使用 DNS-pinned https.request 发起抓取，逐跳核验重定向，并实施单资源体积与总预算上限。
 */
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

export const MaxBrandFetchBytes = 5 * 1024 * 1024;
export const MaxBrandRedirects = 5;

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return nums;
}

/** 判断 IPv4 地址是否落入常见代理 Fake-IP 网段（198.18.0.0/15，RFC 2544）。 */
export function isFakeIpV4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

/** 判断 IP（v4 或 v6）是否属于可安全访问的公网单播地址。 */
export function isPublicIP(raw: string): boolean {
  const ip = raw.trim().toLowerCase();
  if (net.isIPv4(ip)) {
    const o = parseIpv4(ip)!;
    const [a, b, c] = o;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
    if (a === 169 && b === 254) return false; // Link-local
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false; // Benchmark / Fake-IP
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a >= 224) return false; // Multicast & reserved
    return true;
  }
  if (net.isIPv6(ip)) {
    // 兼容 ::ffff:a.b.c.d 映射地址
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIP(mapped[1]);
    if (ip === '::' || ip === '::1') return false;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return false; // ULA fc00::/7
    if (/^fe[89ab]/.test(ip)) return false; // Link-local fe80::/10
    if (ip.startsWith('ff')) return false; // Multicast
    if (ip.startsWith('2001:db8:')) return false; // Documentation
    return true;
  }
  return false;
}

/** 校验并规范化外部公开 HTTPS 地址。 */
export function assertSafePublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`无效的网址：${rawUrl}`);
  }
  if (url.protocol !== 'https:') throw new Error('品牌提取仅支持公开 HTTPS 网址');
  if (url.username || url.password) throw new Error('网址不允许携带账号或密码');
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`拒绝访问本地或内网域名：${host}`);
  }
  if (net.isIP(host) && !isPublicIP(host)) {
    throw new Error(`拒绝访问非公网 IP 地址：${host}`);
  }
  return url;
}

export interface DnsResolverDeps {
  lookupAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  dohResolve?: (hostname: string) => Promise<string[]>;
}

async function defaultCloudflareDoH(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '1.1.1.1',
        servername: 'cloudflare-dns.com',
        path: `/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
        method: 'GET',
        headers: { accept: 'application/dns-json' },
        timeout: 8_000,
      },
      (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          res.resume();
          reject(new Error(`DoH 查询失败（HTTP ${res.statusCode}）`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              Answer?: Array<{ type: number; data: string }>;
            };
            const ips = (json.Answer ?? []).filter((a) => a.type === 1 && net.isIPv4(a.data)).map((a) => a.data);
            resolve(ips);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('DoH 查询超时')));
    req.end();
  });
}

/**
 * 解析目标域名的公网 IP：
 * - 若 OS DNS 返回任一非公网且非 Fake-IP 地址（如混合私网），直接拒绝；
 * - 若全部为代理 Fake-IP（198.18.0.0/15），自动通过 Cloudflare DoH 独立解析公网 IP 并复验。
 */
export async function resolvePublicHost(
  hostname: string,
  deps: DnsResolverDeps = {},
): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.toLowerCase();
  if (net.isIP(host)) {
    if (!isPublicIP(host)) throw new Error(`拒绝访问非公网 IP：${host}`);
    return { address: host, family: net.isIPv6(host) ? 6 : 4 };
  }
  const lookupAll = deps.lookupAll ?? ((h: string) => dns.lookup(h, { all: true }));
  const records = await lookupAll(host);
  if (records.length === 0) throw new Error(`无法解析域名：${host}`);

  const allFakeIp = records.every((r) => isFakeIpV4(r.address));
  if (allFakeIp) {
    const doh = deps.dohResolve ?? defaultCloudflareDoH;
    const answers = await doh(host);
    const pub = answers.find((ip) => isPublicIP(ip));
    if (!pub) throw new Error(`代理 Fake-IP 经公网 DoH 复验后未得到合法公网 IP：${host}`);
    return { address: pub, family: 4 };
  }

  for (const r of records) {
    if (!isPublicIP(r.address)) {
      throw new Error(`域名 ${host} 解析到非公网地址 ${r.address}，已拦截`);
    }
  }
  const first = records[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/**
 * 构造兼容 Node 20+/22+ Happy Eyeballs（options.all === true）与传统标量回调的 DNS-pinning lookup 函数。
 */
export function pinnedLookup(
  address: string,
  family: 4 | 6,
): (
  hostname: string,
  options: { all?: boolean } | number | undefined,
  cb: (
    err: NodeJS.ErrnoException | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void,
) => void {
  return (_host, options, cb) => {
    if (typeof options === 'object' && options !== null && options.all) {
      cb(null, [{ address, family }]);
      return;
    }
    cb(null, address, family);
  };
}

/** 使用 DNS-pinned HTTPS 安全抓取公开文本资源（带重定向与字节上限）。 */
export async function fetchPublicText(
  rawUrl: string,
  opts: { maxBytes?: number; timeoutMs?: number; deps?: DnsResolverDeps; signal?: AbortSignal } = {},
): Promise<{ url: string; contentType: string; body: string }> {
  const maxBytes = opts.maxBytes ?? MaxBrandFetchBytes;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let current = assertSafePublicUrl(rawUrl);

  for (let hop = 0; hop <= MaxBrandRedirects; hop++) {
    const resolved = await resolvePublicHost(current.hostname, opts.deps);
    const result = await new Promise<{ status: number; location?: string; contentType: string; body: string }>(
      (resolve, reject) => {
        const req = https.request(
          {
            hostname: current.hostname,
            port: current.port ? Number(current.port) : 443,
            path: current.pathname + current.search,
            method: 'GET',
            headers: {
              'user-agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              accept: 'text/html,text/css,application/xhtml+xml,*/*;q=0.8',
            },
            timeout: timeoutMs,
            signal: opts.signal,
            lookup: pinnedLookup(resolved.address, resolved.family),
          },
          (res) => {
            const status = res.statusCode ?? 0;
            const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
            const contentType = String(res.headers['content-type'] ?? '');
            if (status >= 300 && status < 400 && location) {
              res.resume();
              resolve({ status, location, contentType, body: '' });
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxBytes) {
                req.destroy(new Error(`资源体积超过上限（${maxBytes} 字节）`));
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error(`抓取超时（${timeoutMs}ms）：${current.href}`)));
        req.end();
      },
    );

    if (result.status >= 300 && result.status < 400 && result.location) {
      current = assertSafePublicUrl(new URL(result.location, current).href);
      continue;
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`抓取失败（HTTP ${result.status}）：${current.href}`);
    }
    return { url: current.href, contentType: result.contentType, body: result.body };
  }
  throw new Error(`重定向次数超过上限（${MaxBrandRedirects}）`);
}
