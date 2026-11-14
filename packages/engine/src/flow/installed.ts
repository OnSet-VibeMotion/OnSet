/**
 * 这台电脑上装了哪些第三方插件：用户级的 installed.json（在 stationsDir 里，ONSET_STATIONS_DIR 覆盖）。
 * 插件不按项目走：装一次，对所有项目生效，和内置插件一样常在。项目里只记「这个项目选了什么」（流程记录、
 * 配音与对齐的取值、镜头的 plugin_skills、整片风格）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { isObject } from './fields';
import type { Manifest } from './manifest';

/** 已装插件清单的文件名（在 stationsDir 里）。 */
export const InstalledFile = 'installed.json';

/**
 * 插件在制作里出现在哪：装上时按清单记下。插件读不出来（内容被改过、本机目录没了）时，凭它判断
 * 这个插件是不是参与某个项目的制作，参与的项目开工报错，其余项目只给提示。
 */
export interface InstalledRole {
  /** 带来一套流程（项目的流程记录是 x:<id> 时用它）。 */
  flow: boolean;
  /** 顶替的自带站（空是不顶替）。 */
  replaces: string;
  /** 接在哪个站点后面（空是接在路线最后）。 */
  after: string;
  /** 有没有自己的站点（没有站点就不进制作路线）。 */
  nodes: boolean;
}

export interface InstalledEntry {
  id: string;
  version: string;
  /** 添加时写的来源：`link:/绝对路径`、`github:owner/repo#ref`、git 地址加 `#ref`。 */
  source: string;
  /** git 来源的 commit；link 为空。 */
  commit: string;
  /** 插件目录的内容摘要；link 为空。 */
  digest: string;
  role: InstalledRole;
}

export interface Installed {
  version: 1;
  plugins: InstalledEntry[];
}

/** 一个读得到的插件（内置插件或已装的第三方插件）。 */
export interface LoadedStation {
  entry: InstalledEntry;
  dir: string;
  manifest: Manifest;
  /** 随片场下发的内置插件（assets/plugins/），不是用户装的。 */
  builtin?: boolean;
}

/** 清单在制作里出现在哪（InstalledRole）。 */
export function roleOf(m: Manifest): InstalledRole {
  return { flow: !!m.flow, replaces: m.replaces, after: m.after, nodes: m.nodes.length > 0 };
}

const noRole: InstalledRole = { flow: false, replaces: '', after: '', nodes: false };

/** 读已装插件清单；没有文件是一个都没装。 */
export function readInstalled(dir: string): Installed {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, InstalledFile), 'utf8');
  } catch {
    return { version: 1, plugins: [] };
  }
  const raw = JSON.parse(text) as unknown;
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.plugins)) throw new Error(`${path.join(dir, InstalledFile)} 格式不对`);
  const plugins = raw.plugins.map((e, i): InstalledEntry => {
    if (!isObject(e)) throw new Error(`${InstalledFile} 的 plugins[${i}] 要是对象`);
    const get = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '');
    if (get('id') === '' || get('source') === '') throw new Error(`${InstalledFile} 的 plugins[${i}] 缺 id 或 source`);
    const r = isObject(e.role) ? e.role : {};
    const role: InstalledRole = {
      flow: r.flow === true,
      replaces: typeof r.replaces === 'string' ? r.replaces : '',
      after: typeof r.after === 'string' ? r.after : '',
      nodes: r.nodes === true,
    };
    return { id: get('id'), version: get('version'), source: get('source'), commit: get('commit'), digest: get('digest'), role: isObject(e.role) ? role : { ...noRole } };
  });
  return { version: 1, plugins };
}

function writeInstalled(dir: string, list: Installed): void {
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, InstalledFile), marshalIndent(list) + '\n', 0o644);
}

/** 装上一个插件（同 id 的换成新的），返回新清单。 */
export function recordInstalled(dir: string, entry: InstalledEntry): Installed {
  const list = readInstalled(dir);
  const others = list.plugins.filter((e) => e.id !== entry.id);
  const next: Installed = { version: 1, plugins: [...others, entry].sort((a, b) => compareBytes(a.id, b.id)) };
  writeInstalled(dir, next);
  return next;
}

/** 去掉一个插件（只改清单，不删存着的插件目录，也不删它在项目里写过的文件）。 */
export function forgetInstalled(dir: string, id: string): Installed {
  const list = readInstalled(dir);
  if (!list.plugins.some((e) => e.id === id)) throw new Error(`没有装插件 ${id}`);
  const next: Installed = { version: 1, plugins: list.plugins.filter((e) => e.id !== id) };
  writeInstalled(dir, next);
  return next;
}
