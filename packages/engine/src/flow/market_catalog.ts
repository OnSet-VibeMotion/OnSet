import { parseSource } from './fetch';
import { idPattern, isObject } from './fields';
import type { InstalledEntry } from './installed';
import { compareSemver, validSemver } from './manifest';

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
  /** 这一版压缩包的内容摘要（treeDigest 的写法）；有它时 GitHub 来源不用 git 也能装（archive.ts）。 */
  digest: string;
  /** 撤回的原因；撤回的版本不再给人装，装着它的人会看到这句话。空是没撤回。 */
  yanked: string;
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
  /** 能改这一条登记的 GitHub 账号（插件中心的 CI 核对 PR 作者）；客户端只显示。 */
  maintainers: string[];
  /** 不再维护的原因；不再给人装，装着它的人会看到这句话。空是还在维护。 */
  deprecated: string;
  versions: CatalogVersion[];
}

export interface Catalog {
  schema: number;
  plugins: CatalogPlugin[];
}

const commitPattern = /^[0-9a-f]{40}$/;

function text(raw: Record<string, unknown>, key: string, where: string, required: boolean): string {
  const v = raw[key];
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || (required && v.trim() === '')) throw new Error(`${where}.${key} 要是非空字符串`);
  return v.trim();
}

function texts(raw: Record<string, unknown>, key: string, where: string): string[] {
  const v = raw[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) {
    throw new Error(`${where}.${key} 要是字符串数组`);
  }
  return (v as string[]).map((x) => x.trim());
}

/** 图标、截图：目录里的相对路径（不能跑出去）或 https 地址。 */
function assetPath(p: string, where: string): string {
  if (p === '') return p;
  if (p.startsWith('https://')) return p;
  const norm = p.replaceAll('\\', '/');
  if (/^[a-z]+:/i.test(norm) || norm.startsWith('/') || norm.split('/').includes('..')) {
    throw new Error(`${where}：${p} 要是目录仓库里的相对路径或 https 地址`);
  }
  return norm;
}

/**
 * 解析 index.json。所有已经装出去的客户端读的是同一份目录，所以这里**不拒绝不认识的字段**：目录加了新字段，
 * 旧客户端照样能读，只是用不上它。认得的字段照样严格校验；改了已有字段意思的大改动递增 schema，
 * 旧客户端报「要更新的片场」。拒收不认识的字段是插件中心 CI（scripts/validate.mjs）的事。
 */
export function parseCatalog(body: string): Catalog {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new Error(`插件目录不是合法的 JSON：${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new Error('插件目录要是 JSON 对象');
  if (typeof raw.schema !== 'number' || !Number.isInteger(raw.schema) || raw.schema < 1) {
    throw new Error('插件目录缺 schema（格式版本）');
  }
  if (raw.schema > CatalogSchema) {
    throw new Error(`插件目录是第 ${raw.schema} 版格式，要更新的片场才能读（这一版只认到第 ${CatalogSchema} 版）`);
  }
  if (!Array.isArray(raw.plugins)) throw new Error('插件目录的 plugins 要是数组');
  const seen = new Set<string>();
  const plugins = raw.plugins.map((p, i): CatalogPlugin => {
    const where = `plugins[${i}]`;
    if (!isObject(p)) throw new Error(`${where} 要是对象`);
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
    if (src.kind !== 'git' || !/^(https|file):\/\//.test(src.url)) {
      throw new Error(`${where}.source 要是 github:owner/repo 或 https 的 git 地址`);
    }
    let author = { name: '', url: '' };
    if (p.author !== undefined) {
      if (!isObject(p.author)) throw new Error(`${where}.author 要是对象`);
      author = {
        name: text(p.author, 'name', `${where}.author`, true),
        url: text(p.author, 'url', `${where}.author`, false),
      };
    }
    const homepage = text(p, 'homepage', where, false);
    if (homepage !== '' && !homepage.startsWith('https://')) throw new Error(`${where}.homepage 要是 https 地址`);
    if (author.url !== '' && !author.url.startsWith('https://')) throw new Error(`${where}.author.url 要是 https 地址`);
    if (!Array.isArray(p.versions) || p.versions.length === 0) throw new Error(`${where}.versions 至少写一版`);
    const versions = p.versions.map((v, j): CatalogVersion => {
      const vw = `${where}.versions[${j}]`;
      if (!isObject(v)) throw new Error(`${vw} 要是对象`);
      const version = text(v, 'version', vw, true);
      if (!validSemver(version)) throw new Error(`${vw}.version 要是 x.y.z：${version}`);
      const commit = text(v, 'commit', vw, true);
      if (!commitPattern.test(commit)) throw new Error(`${vw}.commit 要是 40 位小写十六进制：${commit}`);
      const requires = text(v, 'requires_onset', vw, false);
      if (requires !== '' && !validSemver(requires)) throw new Error(`${vw}.requires_onset 要是 x.y.z：${requires}`);
      const digest = text(v, 'digest', vw, false);
      if (digest !== '' && !/^sha256:[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`${vw}.digest 要是 sha256:<64 位十六进制>`);
      }
      return {
        version,
        ref: text(v, 'ref', vw, false),
        commit,
        requires_onset: requires,
        digest,
        yanked: text(v, 'yanked', vw, false),
      };
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
      maintainers: texts(p, 'maintainers', where),
      deprecated: text(p, 'deprecated', where, false),
      versions,
    };
  });
  return { schema: raw.schema, plugins };
}

/** 这台片场能装的最新一版：requires_onset 不高于 onset 的版本。onset 的版本不是 x.y.z（开发版）时不查。 */
export function pickVersion(p: CatalogPlugin, onset: string): CatalogVersion | null {
  const ok = p.versions
    .filter((v) => v.yanked === '')
    .filter((v) => v.requires_onset === '' || !validSemver(onset) || compareSemver(onset, v.requires_onset) >= 0);
  if (ok.length === 0) return null;
  return ok.reduce((a, b) => (compareSemver(b.version, a.version) > 0 ? b : a));
}

/** 没撤回的版本里最新的一版（这台片场装不上时，告诉用户要更新到哪一版）；全撤回了为 null。 */
export function newestVersion(p: CatalogPlugin): CatalogVersion | null {
  const live = p.versions.filter((v) => v.yanked === '');
  return live.length === 0 ? null : live.reduce((a, b) => (compareSemver(b.version, a.version) > 0 ? b : a));
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
    return src.url
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .toLowerCase();
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
 * - unavailable：没装，但插件不再维护或每一版都撤回了，不给装
 */
export type MarketState =
  | 'available'
  | 'incompatible'
  | 'installed'
  | 'update'
  | 'other_source'
  | 'builtin'
  | 'unavailable';

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
  /** 装着的那一版被撤回了：撤回的原因（只在从这个仓库装的时候看）。 */
  installed_yanked: string;
}

export function marketItem(
  p: CatalogPlugin,
  installed: InstalledEntry | undefined,
  onset: string,
  builtinIDs: ReadonlySet<string> = new Set(),
): MarketItem {
  // 不再维护的插件不给新装，也不提示升级；装着的照旧能用，界面把原因告诉用户。
  const latest = p.deprecated === '' ? pickVersion(p, onset) : null;
  const sameRepo = !!installed && repoKey(installed.source) === repoKey(p.source);
  const yanked = sameRepo ? (p.versions.find((v) => v.commit === installed!.commit)?.yanked ?? '') : '';
  const base = {
    plugin: p,
    latest,
    latest_source: latest ? versionSource(p, latest) : '',
    requires_onset: latest ? '' : (newestVersion(p)?.requires_onset ?? ''),
    installed_version: installed?.version ?? '',
    installed_commit: installed?.commit ?? '',
    installed_yanked: yanked,
  };
  if (builtinIDs.has(p.id)) return { ...base, state: 'builtin' };
  if (!installed) {
    if (latest) return { ...base, state: 'available' };
    return { ...base, state: p.deprecated !== '' || newestVersion(p) === null ? 'unavailable' : 'incompatible' };
  }
  if (!sameRepo) return { ...base, state: 'other_source' };
  if (!latest || installed.commit === latest.commit) return { ...base, state: 'installed' };
  // 装着的版本号已经比目录里能装的新（例如从分支装的开发版），不提示「有新版本」；装着的那一版被撤回时照样给换。
  const newer =
    yanked !== '' || !validSemver(installed.version) || compareSemver(latest.version, installed.version) > 0;
  return { ...base, state: newer ? 'update' : 'installed' };
}

/** 在列表与已装插件间对比。 */
export function marketItems(
  c: Catalog,
  installed: InstalledEntry[],
  onset: string,
  builtinIDs: ReadonlySet<string> = new Set(),
): MarketItem[] {
  const byID = new Map(installed.map((e) => [e.id, e]));
  return c.plugins.map((p) => marketItem(p, byID.get(p.id), onset, builtinIDs));
}

/** 目录里的一个插件（按 id），并核对要装的 commit 确实是它列出的某一版。 */
export function catalogVersion(
  c: Catalog,
  id: string,
  commit: string,
): { plugin: CatalogPlugin; version: CatalogVersion } {
  const plugin = c.plugins.find((p) => p.id === id);
  if (!plugin) throw new Error(`插件中心里没有 ${id}`);
  const version = plugin.versions.find((v) => v.commit === commit);
  if (!version) throw new Error(`插件中心里 ${id} 没有 commit 为 ${commit.slice(0, 12)} 的版本，请刷新插件中心后再试`);
  return { plugin, version };
}
