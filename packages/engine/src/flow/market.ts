/**
 * 插件中心：一个独立的目录仓库（官方是 OnSet-VibeMotion/onset-plugins）里的 index.json，列出可以装的第三方插件，
 * 每一版钉在 git commit 上。这里只解析目录、挑版本、和已装插件对比、缓存与取图；装与升级照旧走两步（staging.ts）：
 * 来源写成 `<source>#<commit>`，取回后核对 id 与 commit（stageStation / stageUpdate 的 expect）。
 *
 * 取目录要联网：引擎不能 import electron，客户端主进程经 useHttpFetch 交进 net.fetch（走系统代理，设置了
 * NETWORK_PROXY 时走它）；没有注入时用全局 fetch。拉到的目录缓存在 <stationsDir>/.market/，离线时照样能看。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { stationsDir } from './fetch';
import {
  type Catalog,
  DefaultCatalogURLs,
  MarketDir,
  MarketTimeoutMs,
  MaxCatalogBytes,
  MaxIconBytes,
  parseCatalog,
} from './market_catalog';

export {
  type Catalog,
  CatalogMaxAgeMs,
  type CatalogPlugin,
  CatalogSchema,
  type CatalogVersion,
  catalogVersion,
  DefaultCatalogURLs,
  MarketDir,
  type MarketItem,
  type MarketState,
  MarketTimeoutMs,
  MaxCatalogBytes,
  MaxIconBytes,
  marketItem,
  marketItems,
  newestVersion,
  parseCatalog,
  pickVersion,
  repoKey,
  versionSource,
} from './market_catalog';

type Env = Record<string, string | undefined>;

// ---------- 取目录 ----------

/** 取一个地址：返回状态码、类型与正文。抛错是没连上（超时、DNS、代理）。 */
export type HttpFetch = (
  url: string,
  init: { signal: AbortSignal; maxBytes: number },
) => Promise<{ status: number; contentType: string; body: Uint8Array }>;

let injected: HttpFetch | null = null;

/** 客户端主进程注入自己的取法（net.fetch：走系统代理或设置里的代理）。传 null 恢复缺省。 */
export function useHttpFetch(fn: HttpFetch | null): void {
  injected = fn;
}

const globalFetch: HttpFetch = async (url, init) => {
  const r = await fetch(url, { signal: init.signal, redirect: 'follow' });
  return readHttpResponse(r, init.maxBytes);
};

/** 在读取过程中限制大小；引擎 fetch 与客户端 Chromium fetch 共用。 */
export async function readHttpResponse(response: Response, maxBytes: number): Promise<Awaited<ReturnType<HttpFetch>>> {
  const tooLarge = () => new Error(`响应太大（上限 ${maxBytes} 字节）`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw tooLarge();
        chunks.push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', body };
}

async function readFileURL(url: string): Promise<{ status: number; contentType: string; body: Uint8Array }> {
  const file = fileURLToPath(url);
  try {
    return { status: 200, contentType: '', body: new Uint8Array(fs.readFileSync(file)) };
  } catch {
    return { status: 404, contentType: '', body: new Uint8Array() };
  }
}

/** 按超时取一个地址；file:// 直接读（本机的目录仓库，开发与测试用）。 */
export async function httpGet(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ contentType: string; body: Uint8Array }> {
  const timeout = AbortSignal.timeout(MarketTimeoutMs);
  const all = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let r: Awaited<ReturnType<HttpFetch>>;
  try {
    r = url.startsWith('file://')
      ? await readFileURL(url)
      : await (injected ?? globalFetch)(url, { signal: all, maxBytes });
  } catch (err) {
    const host = url.startsWith('file://') ? url : new URL(url).host;
    if (timeout.aborted) throw new Error(`连不上 ${host}（${MarketTimeoutMs / 1000} 秒没有回应）`);
    if (signal?.aborted) throw new Error('已取消');
    throw new Error(`连不上 ${host}：${(err as Error).message}`);
  }
  if (r.status !== 200) throw new Error(`${url} 返回 HTTP ${r.status}`);
  if (r.body.byteLength > maxBytes) throw new Error(`${url} 太大（${r.body.byteLength} 字节，上限 ${maxBytes}）`);
  return { contentType: r.contentType, body: r.body };
}

/** 设置里写的目录地址；没写用官方的几个地址。 */
export function catalogURLs(setting: string): string[] {
  return setting.trim() !== '' ? [setting.trim()] : DefaultCatalogURLs;
}

export interface CachedCatalog {
  /** 实际取到目录的地址：图标等相对路径按它解析。 */
  url: string;
  fetched_at: string;
  catalog: Catalog;
}

function marketDir(env: Env): string {
  return path.join(stationsDir(env), MarketDir);
}

/** 读缓存；没有或读坏了为 null（读坏了等下次刷新覆盖）。 */
export function readCachedCatalog(env: Env): CachedCatalog | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(marketDir(env), 'catalog.json'), 'utf8')) as {
      url?: unknown;
      fetched_at?: unknown;
      body?: unknown;
    };
    if (typeof raw.url !== 'string' || typeof raw.fetched_at !== 'string' || typeof raw.body !== 'string') return null;
    return { url: raw.url, fetched_at: raw.fetched_at, catalog: parseCatalog(raw.body) };
  } catch {
    return null;
  }
}

/**
 * 依次试各个地址，第一个取到且解析得了的写进缓存。都不行时抛错，把每个地址的原因列出来；缓存不动。
 */
export async function refreshCatalog(
  env: Env,
  urls: string[],
  signal?: AbortSignal,
  now = () => new Date(),
): Promise<CachedCatalog> {
  const problems: string[] = [];
  for (const url of urls) {
    try {
      const got = await httpGet(url, MaxCatalogBytes, signal);
      const body = new TextDecoder().decode(got.body);
      const catalog = parseCatalog(body);
      const cached: CachedCatalog = { url, fetched_at: now().toISOString(), catalog };
      atomicWrite(
        path.join(marketDir(env), 'catalog.json'),
        marshalIndent({ url, fetched_at: cached.fetched_at, body }) + '\n',
      );
      return cached;
    } catch (err) {
      if (signal?.aborted) throw err;
      problems.push((err as Error).message);
    }
  }
  throw new Error(problems.join('；'));
}

/** 图标与截图的地址：相对路径按目录地址解析。 */
export function assetURL(catalogURL: string, p: string): string {
  if (p.startsWith('https://')) return p;
  return new URL(p, catalogURL).toString();
}

const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** 认图片：按文件头，不信对方给的类型（SVG 不收：它能带脚本）。 */
export function imageType(body: Uint8Array): string {
  const b = body;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return imageTypes.png;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return imageTypes.jpg;
  if (
    b.length > 12 &&
    String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.slice(8, 12)) === 'WEBP'
  ) {
    return imageTypes.webp;
  }
  return '';
}

/** 取一张图（图标或截图），按地址缓存在 <stationsDir>/.market/images/。返回类型与内容。 */
export async function marketImage(
  env: Env,
  url: string,
  signal?: AbortSignal,
): Promise<{ type: string; body: Uint8Array }> {
  const file = path.join(marketDir(env), 'images', crypto.createHash('sha256').update(url).digest('hex'));
  try {
    const body = new Uint8Array(fs.readFileSync(file));
    const type = imageType(body);
    if (type !== '') return { type, body };
  } catch {
    // 没缓存。
  }
  const got = await httpGet(url, MaxIconBytes, signal);
  const type = imageType(got.body);
  if (type === '') throw new Error(`${url} 不是 PNG、JPEG 或 WebP 图片`);
  atomicWrite(file, got.body);
  return { type, body: got.body };
}
