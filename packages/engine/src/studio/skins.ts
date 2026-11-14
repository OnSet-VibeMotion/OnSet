/**
 * 界面皮肤：/api/skins。
 *
 *   GET /api/skins           全部皮肤（宿主的放映室、内置插件的、已装第三方插件的）、现在用的是哪个、读不出来的皮肤
 *   GET /api/skins/current   现在用的那一份（选的皮肤不在了就退回放映室，missing 写上原来选的）
 *   PUT /api/skins/current   {id}：换皮肤，回同 GET
 *
 * 选的是哪个记在用户级的项目登记里（与「保存到」的上次目录同一个文件），不进项目、不进 settings.conf：
 * 皮肤是这台电脑上客户端的样子，跟着人走，不跟着项目走；不占项目写锁、没打开项目也能换。
 * 主窗口与桌宠窗口都从这里取（桌宠经主进程收到「换了」再来取一次）。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as flow from '../flow';
import * as plugin from '../plugin';
import * as skin from '../skin';
import { DecodeError, decodeJSON, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { pageURL } from './stations';

export interface SkinEntry {
  /** 对外的标识：放映室是 default，插件的是「插件 id/皮肤 id」。 */
  key: string;
  skin: skin.Skin;
  origin: 'host' | 'builtin' | 'plugin';
  /** 带来它的插件名（放映室为空）。 */
  plugin: string;
  /** 桌宠换成插件页面时的地址。 */
  pageURL: string;
}

export interface SkinProblem {
  plugin: string;
  file: string;
  message: string;
}

/** 宿主自带的放映室：styles.css 的默认值，什么都不换。 */
const theater: skin.Skin = {
  id: skin.DefaultSkinID,
  name: '放映室',
  description: '暖黑底、象牙白字、一种黄铜色：作品是主角，界面往后退',
  scheme: 'dark',
  tokens: {},
  fonts: {},
  pet: {},
};

const maxSkinBytes = 64 << 10;

/** 读出一个第三方插件带的皮肤（读坏的进 problems，不影响别的）。 */
function stationSkins(st: flow.LoadedStation, problems: SkinProblem[]): SkinEntry[] {
  const m = st.manifest;
  const pages = m.pages.map((p) => p.id);
  const out: SkinEntry[] = [];
  for (const file of m.skins) {
    try {
      const full = path.join(st.dir, file);
      const real = fs.realpathSync(full);
      if (!real.startsWith(fs.realpathSync(st.dir) + path.sep)) throw new Error('文件跑出了插件目录');
      if (fs.statSync(real).size > maxSkinBytes) throw new Error('文件太大（上限 64 KB）');
      const sk = skin.parseSkin(JSON.parse(fs.readFileSync(real, 'utf8')), file, pages);
      const key = `${m.id}/${sk.id}`;
      if (out.some((e) => e.key === key)) throw new Error(`皮肤 ${sk.id} 重复了`);
      const page = sk.pet.page ? m.pages.find((p) => p.id === sk.pet.page) : undefined;
      out.push({ key, skin: sk, origin: 'plugin', plugin: m.name, pageURL: page ? pageURL(m.id, page.entry) : '' });
    } catch (err) {
      problems.push({ plugin: m.name, file, message: (err as Error).message });
    }
  }
  return out;
}

/** 全部皮肤：放映室在前，再是内置插件登记的（按登记顺序），最后是已装第三方插件带的（按插件 id）。 */
export function listSkins(): { skins: SkinEntry[]; problems: SkinProblem[] } {
  const loaded = flow.loadStations().stations;
  const name = (id: string) => loaded.find((s) => s.manifest.id === id)?.manifest.name ?? id;
  const problems: SkinProblem[] = [];
  const skins: SkinEntry[] = [{ key: skin.DefaultSkinID, skin: theater, origin: 'host', plugin: '', pageURL: '' }];
  for (const { owner, value } of plugin.pluginSkins()) skins.push({ key: `${owner}/${value.id}`, skin: value, origin: 'builtin', plugin: name(owner), pageURL: '' });
  for (const st of loaded) if (!st.builtin && st.manifest.skins.length > 0) skins.push(...stationSkins(st, problems));
  return { skins, problems };
}

/** 一个第三方插件里被皮肤拿去当桌宠的页面（插件菜单不列它们：它们只在桌宠里有意义）。 */
export function petPageIDs(st: flow.LoadedStation): string[] {
  if (st.builtin || st.manifest.skins.length === 0) return [];
  return stationSkins(st, []).flatMap((e) => (e.skin.pet.page ? [e.skin.pet.page] : []));
}

/** 给界面的一份：变量名不带 `--`，界面自己加。 */
export function skinJSON(e: SkinEntry): Record<string, unknown> {
  const s = e.skin;
  return goMap({
    id: e.key,
    name: s.name,
    description: s.description,
    scheme: s.scheme,
    origin: e.origin,
    plugin: e.plugin,
    tokens: s.tokens,
    fonts: s.fonts,
    radius: s.radius ?? null,
    swatch: skin.swatch(s),
    pet: goMap({
      materials: s.pet.materials ?? {},
      crew: s.pet.crew ?? {},
      room: s.pet.room ?? {},
      filter: s.pet.filter ?? {},
      page_url: e.pageURL,
    }),
  });
}

/** 现在用的皮肤：选的不在了（插件去掉了、皮肤文件坏了）就退回放映室。 */
export function currentSkin(choice: string): { entry: SkinEntry; missing: string } {
  const { skins } = listSkins();
  const found = skins.find((e) => e.key === choice);
  return found ? { entry: found, missing: '' } : { entry: skins[0], missing: choice && choice !== skin.DefaultSkinID ? choice : '' };
}

interface SkinStore {
  skinChoice(): string;
  setSkinChoice(id: string): void;
}

function currentResponse(s: SkinStore): Response {
  const { entry, missing } = currentSkin(s.skinChoice());
  return writeJSON(200, goMap({ skin: skinJSON(entry), missing }));
}

export function skinsAPI(s: SkinStore, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const { skins, problems } = listSkins();
  const { entry } = currentSkin(s.skinChoice());
  return writeJSON(200, goMap({ current: entry.key, skins: skins.map(skinJSON), problems: problems.map((p) => goMap({ plugin: p.plugin, file: p.file, message: p.message })) }));
}

export async function currentSkinAPI(s: SkinStore, request: Request): Promise<Response> {
  if (request.method === 'GET') return currentResponse(s);
  if (request.method !== 'PUT' && request.method !== 'POST') return methodNotAllowed('GET, PUT');
  let id: string;
  try {
    id = fieldString(await decodeJSON(request), 'id');
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    throw err;
  }
  if (!listSkins().skins.some((e) => e.key === id)) return writeError(404, 'not_found', `没有皮肤 ${id}`);
  s.setSkinChoice(id);
  return currentResponse(s);
}
