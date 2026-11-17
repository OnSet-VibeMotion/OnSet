/**
 * 插件中心（/api/market）：浏览插件中心目录（flow.market）、和已装插件对比；装与升级照旧是两步，
 * 这里只把目录里的一版翻成来源，交给 station_add / station_update（取到暂存、给用户看、点「装上」才装）：
 *   GET  /api/market                         缓存的目录与每个插件的状态；缓存没有或太旧时在后台刷新（不等网络）
 *   POST /api/market/refresh                 现在刷新（后台跑，界面轮询 GET 看 refreshing 与 error）
 *   POST /api/market/install    {id, commit} 取回目录里的这一版给用户看（任务 station_add，带 expect_id / expect_commit）
 *   POST /api/market/update     {id, commit} 取回新一版给用户看（任务 station_update，带 source 与 expect_commit）
 *   GET  /api/market/images/{id}/{icon|0..} 图标与截图（后端代取并缓存，界面不直接连外网）
 *
 * 来源只从目录算，不收界面给的地址：界面只说「装目录里 id 的 commit 这一版」。
 */
import * as config from '../config';
import { envMap } from '../envutil';
import * as flow from '../flow';
import * as market from '../flow/market';
import { decodeJSON, DecodeError, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { startUserTask } from './stations';
import type { Server } from './studio';

interface MarketState {
  refreshing: Promise<void> | null;
  /** 最近一次刷新失败的原因（成功后清空）。 */
  error: string;
  /** 最近一次试着刷新的时间：失败后不在每次 GET 时重试。 */
  attempted: number;
  attemptedURL: string;
}

const state: MarketState = { refreshing: null, error: '', attempted: 0, attemptedURL: '' };

/** 自动刷新失败后，至少隔这么久才在 GET 时再试（手动刷新不受限）。 */
const retryAfterMs = 5 * 60 * 1000;

function settingURL(env: Record<string, string | undefined>): string {
  return config.machineSetting(env, 'PLUGIN_CATALOG_URL', config.parseConfFile);
}

/** 测试用：清掉内存里的刷新状态。 */
export function resetMarketState(): void {
  state.refreshing = null;
  state.error = '';
  state.attempted = 0;
  state.attemptedURL = '';
}

/** 开始刷新（已经在刷新就沿用）。返回那次刷新。 */
export function startRefresh(): Promise<void> {
  if (state.refreshing) return state.refreshing;
  const env = envMap();
  state.attempted = Date.now();
  state.attemptedURL = settingURL(env);
  state.error = '';
  state.refreshing = market
    .refreshCatalog(env, market.catalogURLs(settingURL(env)))
    .then(() => {
      state.error = '';
    })
    .catch((err: unknown) => {
      state.error = (err as Error).message;
    })
    .finally(() => {
      state.refreshing = null;
    });
  return state.refreshing;
}

function cachedFor(env: Record<string, string | undefined>): market.CachedCatalog | null {
  const cached = market.readCachedCatalog(env);
  // 换了目录地址：旧地址的缓存不算数。
  if (cached && settingURL(env) !== '' && cached.url !== settingURL(env)) return null;
  if (cached && settingURL(env) === '' && !market.DefaultCatalogURLs.includes(cached.url)) return null;
  return cached;
}

function imageURL(id: string, which: string): string {
  return `/api/market/images/${encodeURIComponent(id)}/${which}`;
}

export function marketJSON(): Record<string, unknown> {
  const env = envMap();
  const cached = cachedFor(env);
  const stale = !cached || Date.now() - Date.parse(cached.fetched_at) > market.CatalogMaxAgeMs;
  if (stale && !state.refreshing && (state.attemptedURL !== settingURL(env) || Date.now() - state.attempted > retryAfterMs)) void startRefresh();
  let installed: flow.InstalledEntry[] = [];
  let installedError = '';
  try {
    installed = flow.readInstalled(flow.stationsDir(env)).plugins;
  } catch (err) {
    installedError = (err as Error).message;
  }
  const items = cached ? market.marketItems(cached.catalog, installed, flow.onsetVersion(), new Set(flow.builtinPluginIDs())) : [];
  return goMap({
    catalog_url: cached?.url ?? market.catalogURLs(settingURL(env))[0],
    custom_url: settingURL(env) !== '',
    fetched_at: cached?.fetched_at ?? '',
    refreshing: state.refreshing !== null,
    error: state.error,
    installed_error: installedError,
    onset_version: flow.onsetVersion(),
    items: items.map((it) =>
      goMap({
        id: it.plugin.id,
        name: it.plugin.name,
        description: it.plugin.description,
        author: it.plugin.author,
        license: it.plugin.license,
        tags: it.plugin.tags,
        homepage: it.plugin.homepage,
        source: it.plugin.source,
        icon: it.plugin.icon !== '' ? imageURL(it.plugin.id, 'icon') : '',
        screenshots: it.plugin.screenshots.map((_, i) => imageURL(it.plugin.id, String(i))),
        state: it.state,
        latest: it.latest,
        requires_onset: it.requires_onset,
        installed_version: it.installed_version,
        installed_commit: it.installed_commit,
        installed_yanked: it.installed_yanked,
        deprecated: it.plugin.deprecated,
        maintainers: it.plugin.maintainers,
      }),
    ),
  });
}

async function readPick(request: Request): Promise<{ id: string; commit: string } | Response> {
  try {
    const body = await decodeJSON(request);
    const id = fieldString(body, 'id').trim();
    const commit = fieldString(body, 'commit').trim();
    if (id === '' || commit === '') return writeError(400, 'invalid_request', '要写插件的 id 与 commit');
    return { id, commit };
  } catch (err) {
    return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
  }
}

export async function marketAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(decodeURIComponent);
  const env = envMap();

  if (parts.length === 0) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return writeJSON(200, marketJSON());
  }

  if (parts.length === 1 && parts[0] === 'refresh') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    void startRefresh();
    return writeJSON(202, goMap({ refreshing: true }));
  }

  if (parts.length === 1 && (parts[0] === 'install' || parts[0] === 'update')) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const pick = await readPick(request);
    if (pick instanceof Response) return pick;
    const cached = cachedFor(env);
    if (!cached) return writeError(409, 'no_catalog', '还没有取到插件中心的目录，请先刷新');
    let found: { plugin: market.CatalogPlugin; version: market.CatalogVersion };
    try {
      found = market.catalogVersion(cached.catalog, pick.id, pick.commit);
    } catch (err) {
      return writeError(404, 'not_found', (err as Error).message);
    }
    let entry: flow.InstalledEntry | undefined;
    try {
      entry = flow.installedEntry(pick.id);
    } catch (err) {
      return writeError(500, 'invalid_installed', (err as Error).message);
    }
    if (flow.builtinPluginIDs().includes(pick.id)) return writeError(409, 'builtin', `${pick.id} 与片场自带的功能同名，不能装`);
    const item = market.marketItem(found.plugin, entry, flow.onsetVersion());
    if (found.version.requires_onset !== '' && flow.validSemver(flow.onsetVersion()) && flow.compareSemver(flow.onsetVersion(), found.version.requires_onset) < 0) {
      return writeError(409, 'incompatible', `这一版要片场 ${found.version.requires_onset} 或更新的版本，请先更新片场`);
    }
    if (found.version.yanked !== '') return writeError(409, 'yanked', `这一版已经撤回：${found.version.yanked}`);
    if (found.plugin.deprecated !== '') return writeError(409, 'deprecated', `这个插件不再维护：${found.plugin.deprecated}`);
    const source = market.versionSource(found.plugin, found.version);
    // 有内容摘要时执行进程先试着下压缩包（不用 git），对不上或下不来再克隆。
    const digest = found.version.digest !== '' ? { expect_digest: found.version.digest } : {};
    const label = `${found.plugin.name} ${found.version.version}`;
    if (parts[0] === 'install') {
      if (entry) return writeError(409, 'installed', `已经装了 ${pick.id}；要换版本请点「更新」`);
      return startUserTask(s, 'station.stage', `从插件中心取回：${label}`, 'station_add', { source, expect_id: pick.id, expect_commit: pick.commit, ...digest });
    }
    if (!entry) return writeError(404, 'not_found', `没有装插件 ${pick.id}`);
    if (item.state === 'other_source') return writeError(409, 'other_source', `装着的 ${pick.id} 不是从插件中心的仓库装的（${entry.source}）；要换成插件中心的版本请先去掉再装`);
    return startUserTask(s, 'station.stage', `从插件中心取回新版本：${label}`, 'station_update', { id: pick.id, source, expect_commit: pick.commit, ...digest });
  }

  if (parts.length === 3 && parts[0] === 'images') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const cached = cachedFor(env);
    const plugin = cached?.catalog.plugins.find((p) => p.id === parts[1]);
    if (!cached || !plugin) return writeError(404, 'not_found', '插件中心里没有这个插件');
    const which = parts[2];
    const rel = which === 'icon' ? plugin.icon : /^\d+$/.test(which) ? (plugin.screenshots[Number(which)] ?? '') : '';
    if (rel === '') return writeError(404, 'not_found', '没有这张图');
    try {
      const img = await market.marketImage(env, market.assetURL(cached.url, rel));
      return new Response(img.body, { status: 200, headers: { 'Content-Type': img.type, 'Cache-Control': 'max-age=86400' } });
    } catch (err) {
      return writeError(502, 'image_unavailable', (err as Error).message);
    }
  }

  return writeError(404, 'not_found', 'Studio API 路径不存在');
}
