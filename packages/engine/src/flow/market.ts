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
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { parseSource, stationsDir } from './fetch';
import { idPattern, isObject } from './fields';
import type { InstalledEntry } from './installed';
import { compareSemver, validSemver } from './manifest';

type Env = Record<string, string | undefined>;

/** 官方插件中心。PLUGIN_CATALOG_URL 没设时依次试这几个地址（jsDelivr 在国内多半连得上）。 */
export const DefaultCatalogURLs = [
  'https://raw.githubusercontent.com/OnSet-VibeMotion/onset-plugins/main/index.json',
  'https://cdn.jsdelivr.net/gh/OnSet-VibeMotion/onset-plugins@main/index.json',
];

/** 目录格式版本。 */
export const CatalogSchema = 1;

/** 取目录、取图的超时（毫秒）。 */
export const MarketTimeoutMs = 10_000;
/** 目录文件与图标的大小上限。 */
export const MaxCatalogBytes = 2 * 1024 * 1024;
export const MaxIconBytes = 200 * 1024;
/** 缓存放这么久就在打开插件中心时后台刷新一次。 */
export const CatalogMaxAgeMs = 6 * 60 * 60 * 1000;

/** 缓存目录（点开头：插件 id 以小写字母开头，不会撞上）。 */
export const MarketDir = '.market';

export interface CatalogVersion {
  version: string;
  /** 给人看的 tag 或分支名；装的时候只认 commit。 */
  ref: string;
  /** 40 位 commit。 */
  commit: string;
  /** 这一版要的最低片场版本，空是不限。 */
  requires_onset: string;
}

export interface CatalogPlugin {
  id: string;
  name: string;
  description: string;
  author: { name: string; url: string };
  license: string;
  tags: string[];
  homepage: string;
  /** git 来源，不带 #ref：github:owner/repo 或 https 地址。 */
  source: string;
  /** 图标：目录仓库里的相对路径或 https 地址，空是没有。 */
  icon: string;
  screenshots: string[];
  versions: CatalogVersion[];
}

export interface Catalog {
  schema: number;
  plugins: CatalogPlugin[];
}

const commitPattern = /^[0-9a-f]{40}$/;

function known(raw: Record<string, unknown>, keys: string[], where: string): void {
  for (const k of Object.keys(raw)) if (!keys.includes(k)) throw new Error(`${where} 里有不认识的字段 ${k}`);
}

function text(raw: Record<string, unknown>, key: string, where: string, required: boolean): string {
  const v = raw[key];
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || (required && v.trim() === '')) throw new Error(`${where}.${key} 要是非空字符串`);
  return v.trim();
}

function texts(raw: Record<string, unknown>, key: string, where: string): string[] {
  const v = raw[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) throw new Error(`${where}.${key} 要是字符串数组`);
  return (v as string[]).map((x) => x.trim());
}

/** 图标、截图：目录里的相对路径（不能跑出去）或 https 地址。 */
function assetPath(p: string, where: string): string {
  if (p === '') return p;
  if (p.startsWith('https://')) return p;
  const norm = p.replaceAll('\\', '/');
  if (/^[a-z]+:/i.test(norm) || norm.startsWith('/') || norm.split('/').includes('..')) throw new Error(`${where}：${p} 要是目录仓库里的相对路径或 https 地址`);
  return norm;
}

/** 严格解析 index.json。格式更新时（schema 更大）报「要更新的片场」，不列一串不认识的字段。 */
export function parseCatalog(body: string): Catalog {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new Error(`插件目录不是合法的 JSON：${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new Error('插件目录要是 JSON 对象');
  if (typeof raw.schema !== 'number' || !Number.isInteger(raw.schema) || raw.schema < 1) throw new Error('插件目录缺 schema（格式版本）');
  if (raw.schema > CatalogSchema) throw new Error(`插件目录是第 ${raw.schema} 版格式，要更新的片场才能读（这一版只认到第 ${CatalogSchema} 版）`);
  known(raw, ['$schema', 'schema', 'plugins'], '插件目录');
  if (!Array.isArray(raw.plugins)) throw new Error('插件目录的 plugins 要是数组');
  const seen = new Set<string>();
  const plugins = raw.plugins.map((p, i): CatalogPlugin => {
    const where = `plugins[${i}]`;
    if (!isObject(p)) throw new Error(`${where} 要是对象`);
    known(p, ['id', 'name', 'description', 'author', 'license', 'tags', 'homepage', 'source', 'icon', 'screenshots', 'versions'], where);
    const id = text(p, 'id', where, true);
    if (!idPattern.test(id)) throw new Error(`${where}.id 只能用小写字母、数字与 -，以字母开头：${id}`);
    if (seen.has(id)) throw new Error(`插件目录里 ${id} 出现了两次`);
    seen.add(id);
    const source = text(p, 'source', where, true);
    if (source.includes('#')) throw new Error(`${where}.source 不带 #ref，版本写在 versions 里：${source}`);
    let src: ReturnType<typeof parseSource>;
    try {
      src = parseSource(source);
    } catch (err) {
      throw new Error(`${where}.source：${(err as Error).message}`);
    }
    // file:// 只给本机的目录仓库（开发与测试）；官方插件中心的 CI 只收 github: 与 https。
    if (src.kind !== 'git' || !/^(https|file):\/\//.test(src.url)) throw new Error(`${where}.source 要是 github:owner/repo 或 https 的 git 地址`);
    let author = { name: '', url: '' };
    if (p.author !== undefined) {
      if (!isObject(p.author)) throw new Error(`${where}.author 要是对象`);
      known(p.author, ['name', 'url'], `${where}.author`);
      author = { name: text(p.author, 'name', `${where}.author`, true), url: text(p.author, 'url', `${where}.author`, false) };
    }
    const homepage = text(p, 'homepage', where, false);
    if (homepage !== '' && !homepage.startsWith('https://')) throw new Error(`${where}.homepage 要是 https 地址`);
    if (author.url !== '' && !author.url.startsWith('https://')) throw new Error(`${where}.author.url 要是 https 地址`);
    if (!Array.isArray(p.versions) || p.versions.length === 0) throw new Error(`${where}.versions 至少写一版`);
    const versions = p.versions.map((v, j): CatalogVersion => {
      const vw = `${where}.versions[${j}]`;
      if (!isObject(v)) throw new Error(`${vw} 要是对象`);
      known(v, ['version', 'ref', 'commit', 'requires_onset'], vw);
      const version = text(v, 'version', vw, true);
      if (!validSemver(version)) throw new Error(`${vw}.version 要是 x.y.z：${version}`);
      const commit = text(v, 'commit', vw, true);
      if (!commitPattern.test(commit)) throw new Error(`${vw}.commit 要是 40 位小写十六进制：${commit}`);
      const requires = text(v, 'requires_onset', vw, false);
      if (requires !== '' && !validSemver(requires)) throw new Error(`${vw}.requires_onset 要是 x.y.z：${requires}`);
      return { version, ref: text(v, 'ref', vw, false), commit, requires_onset: requires };
    });
    const vs = new Set<string>();
    for (const v of versions) {
      if (vs.has(v.version)) throw new Error(`${where} 的版本 ${v.version} 出现了两次`);
      vs.add(v.version);
    }
    return {
      id,
      name: text(p, 'name', where, true),
      description: text(p, 'description', where, true),
      author,
      license: text(p, 'license', where, false),
      tags: texts(p, 'tags', where),
      homepage,
      source,
      icon: assetPath(text(p, 'icon', where, false), `${where}.icon`),
      screenshots: texts(p, 'screenshots', where).map((s, k) => assetPath(s, `${where}.screenshots[${k}]`)),
      versions,
    };
  });
  return { schema: raw.schema, plugins };
}

/** 这台片场能装的最新一版：requires_onset 不高于 onset 的版本。onset 的版本不是 x.y.z（开发版）时不查。 */
export function pickVersion(p: CatalogPlugin, onset: string): CatalogVersion | null {
  const ok = p.versions.filter((v) => v.requires_onset === '' || !validSemver(onset) || compareSemver(onset, v.requires_onset) >= 0);
  if (ok.length === 0) return null;
  return ok.reduce((a, b) => (compareSemver(b.version, a.version) > 0 ? b : a));
}

/** 所有版本里最新的一版（这台片场装不上时，告诉用户要更新到哪一版）。 */
export function newestVersion(p: CatalogPlugin): CatalogVersion {
  return p.versions.reduce((a, b) => (compareSemver(b.version, a.version) > 0 ? b : a));
}

/** 装某一版用的来源：钉在 commit 上。 */
export function versionSource(p: CatalogPlugin, v: CatalogVersion): string {
  return `${p.source}#${v.commit}`;
}

/** git 地址的比较用写法：去掉 #ref、末尾的 .git 与 /，不分大小写。link 来源为空。 */
export function repoKey(source: string): string {
  try {
    const src = parseSource(source);
    if (src.kind !== 'git') return '';
    return src.url.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 目录里的一个插件与这台电脑的关系：
 * - available：没装，可以装；incompatible：没装，但每一版都要更新的片场
 * - installed：装的就是能装的最新一版（或更新）；update：有新版本
 * - other_source：装了同 id 的插件，但不是从这个仓库装的（不给升级，免得悄悄换了作者）
 * - builtin：和内置插件同名（目录写错了），不给装
 */
export type MarketState = 'available' | 'incompatible' | 'installed' | 'update' | 'other_source' | 'builtin';

export interface MarketItem {
  plugin: CatalogPlugin;
  state: MarketState;
  /** 能装的最新一版；incompatible 时为空。 */
  latest: CatalogVersion | null;
  /** 装这一版用的来源（`<source>#<commit>`）。 */
  latest_source: string;
  /** 每一版都装不上时，最新一版要的片场版本。 */
  requires_onset: string;
  /** 已装的版本与 commit。 */
  installed_version: string;
  installed_commit: string;
}

export function marketItem(p: CatalogPlugin, installed: InstalledEntry | undefined, onset: string, builtinIDs: ReadonlySet<string> = new Set()): MarketItem {
  const latest = pickVersion(p, onset);
  const base = {
    plugin: p,
    latest,
    latest_source: latest ? versionSource(p, latest) : '',
    requires_onset: latest ? '' : newestVersion(p).requires_onset,
    installed_version: installed?.version ?? '',
    installed_commit: installed?.commit ?? '',
  };
  if (builtinIDs.has(p.id)) return { ...base, state: 'builtin' };
  if (!installed) return { ...base, state: latest ? 'available' : 'incompatible' };
  if (repoKey(installed.source) !== repoKey(p.source)) return { ...base, state: 'other_source' };
  if (!latest || installed.commit === latest.commit) return { ...base, state: 'installed' };
  // 装着的版本号已经比目录里能装的新（例如从分支装的开发版），不提示「有新版本」。
  const newer = !validSemver(installed.version) || compareSemver(latest.version, installed.version) > 0;
  return { ...base, state: newer ? 'update' : 'installed' };
}

/** 在列表与已装插件间对比。 */
export function marketItems(c: Catalog, installed: InstalledEntry[], onset: string, builtinIDs: ReadonlySet<string> = new Set()): MarketItem[] {
  const byID = new Map(installed.map((e) => [e.id, e]));
  return c.plugins.map((p) => marketItem(p, byID.get(p.id), onset, builtinIDs));
}

/** 目录里的一个插件（按 id），并核对要装的 commit 确实是它列出的某一版。 */
export function catalogVersion(c: Catalog, id: string, commit: string): { plugin: CatalogPlugin; version: CatalogVersion } {
  const plugin = c.plugins.find((p) => p.id === id);
  if (!plugin) throw new Error(`插件中心里没有 ${id}`);
  const version = plugin.versions.find((v) => v.commit === commit);
  if (!version) throw new Error(`插件中心里 ${id} 没有 commit 为 ${commit.slice(0, 12)} 的版本，请刷新插件中心后再试`);
  return { plugin, version };
}

// ---------- 取目录 ----------

/** 取一个地址：返回状态码、类型与正文。抛错是没连上（超时、DNS、代理）。 */
export type HttpFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ status: number; contentType: string; body: Uint8Array }>;

let injected: HttpFetch | null = null;

/** 客户端主进程注入自己的取法（net.fetch：走系统代理或设置里的代理）。传 null 恢复缺省。 */
export function useHttpFetch(fn: HttpFetch | null): void {
  injected = fn;
}

const globalFetch: HttpFetch = async (url, init) => {
  const r = await fetch(url, { signal: init.signal, redirect: 'follow' });
  return { status: r.status, contentType: r.headers.get('content-type') ?? '', body: new Uint8Array(await r.arrayBuffer()) };
};

async function readFileURL(url: string): Promise<{ status: number; contentType: string; body: Uint8Array }> {
  const file = decodeURIComponent(new URL(url).pathname);
  try {
    return { status: 200, contentType: '', body: new Uint8Array(fs.readFileSync(file)) };
  } catch {
    return { status: 404, contentType: '', body: new Uint8Array() };
  }
}

/** 按超时取一个地址；file:// 直接读（本机的目录仓库，开发与测试用）。 */
export async function httpGet(url: string, maxBytes: number, signal?: AbortSignal): Promise<{ contentType: string; body: Uint8Array }> {
  const timeout = AbortSignal.timeout(MarketTimeoutMs);
  const all = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let r: Awaited<ReturnType<HttpFetch>>;
  try {
    r = url.startsWith('file://') ? await readFileURL(url) : await (injected ?? globalFetch)(url, { signal: all });
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
    const raw = JSON.parse(fs.readFileSync(path.join(marketDir(env), 'catalog.json'), 'utf8')) as { url?: unknown; fetched_at?: unknown; body?: unknown };
    if (typeof raw.url !== 'string' || typeof raw.fetched_at !== 'string' || typeof raw.body !== 'string') return null;
    return { url: raw.url, fetched_at: raw.fetched_at, catalog: parseCatalog(raw.body) };
  } catch {
    return null;
  }
}

/**
 * 依次试各个地址，第一个取到且解析得了的写进缓存。都不行时抛错，把每个地址的原因列出来；缓存不动。
 */
export async function refreshCatalog(env: Env, urls: string[], signal?: AbortSignal, now = () => new Date()): Promise<CachedCatalog> {
  const problems: string[] = [];
  for (const url of urls) {
    try {
      const got = await httpGet(url, MaxCatalogBytes, signal);
      const body = new TextDecoder().decode(got.body);
      const catalog = parseCatalog(body);
      const cached: CachedCatalog = { url, fetched_at: now().toISOString(), catalog };
      atomicWrite(path.join(marketDir(env), 'catalog.json'), marshalIndent({ url, fetched_at: cached.fetched_at, body }) + '\n');
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

const imageTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** 认图片：按文件头，不信对方给的类型（SVG 不收：它能带脚本）。 */
export function imageType(body: Uint8Array): string {
  const b = body;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return imageTypes.png;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return imageTypes.jpg;
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return imageTypes.webp;
  return '';
}

/** 取一张图（图标或截图），按地址缓存在 <stationsDir>/.market/images/。返回类型与内容。 */
export async function marketImage(env: Env, url: string, signal?: AbortSignal): Promise<{ type: string; body: Uint8Array }> {
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
