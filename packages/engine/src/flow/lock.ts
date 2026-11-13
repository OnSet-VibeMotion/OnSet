/**
 * 项目里的 article-to-motion.flow.json（LockFile）：记下这个项目加了哪些第三方站、从哪来、内容摘要，
 * 选用了哪个站带来的流程，关掉了哪些内置插件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { isObject } from './fields';
import type { Manifest } from './manifest';

export const LockFile = 'article-to-motion.flow.json';

export interface LockEntry {
  id: string;
  version: string;
  /** 添加时写的来源：`link:/绝对路径`、`github:owner/repo#ref`、git 地址加 `#ref`。 */
  source: string;
  /** git 来源的 commit；link 为空。 */
  commit: string;
  /** 站目录的内容摘要；link 为空。 */
  digest: string;
}

/**
 * 新建项目时记下的流程（片型）与提示词组合方式。有它的项目，制作提示词由运行期按流程组合（compose.ts）；
 * 没有它的老项目照旧读项目里的提示词文件（兼容路径），也不补写。
 */
export interface FlowRecord {
  /** 内置流程或内置插件的流程：speech、beat、song。第三方流程仍记在 Lock.flow（站 id）。 */
  id: string;
  /** 提示词组合的版本（flow.ComposeVersion）。不认识的版本按老路径读文件。 */
  compose: number;
  /** 画幅（预设 id），运行期组合时替换画幅占位符用。 */
  canvas: string;
  /**
   * 新建时项目里那份制作说明（口播、卡点是 PROMPT-PRODUCTION.md，歌曲讲解是 PROMPT-SONG.md）的 sha256；
   * 文件之后变了就是用户改过：以文件为准（老路径），界面提示「这个项目用的是自己改过的制作说明」。
   */
  prompt_sha256: string;
}

export interface Lock {
  version: 1;
  /** 新建项目时记下的流程（没有它的是老项目）。 */
  production?: FlowRecord;
  /** 选用了哪个站带来的流程（站 id）；空是内置流程。 */
  flow?: string;
  /** 这个项目关掉的内置插件。 */
  disabled?: string[];
  stations: LockEntry[];
}

/** 一个已加进项目、读得到的第三方站。 */
export interface LoadedStation {
  entry: LockEntry;
  dir: string;
  manifest: Manifest;
  /** 随 ArticleToMotion 下发的内置插件（assets/plugins/），不是用户加的。 */
  builtin?: boolean;
}

export function readLock(root: string): Lock {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, LockFile), 'utf8');
  } catch {
    return { version: 1, stations: [] };
  }
  const raw = JSON.parse(text) as unknown;
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.stations)) throw new Error(`${LockFile} 格式不对`);
  const stations = raw.stations.map((e, i): LockEntry => {
    if (!isObject(e)) throw new Error(`${LockFile} 的 stations[${i}] 要是对象`);
    const get = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '');
    if (get('id') === '' || get('source') === '') throw new Error(`${LockFile} 的 stations[${i}] 缺 id 或 source`);
    return { id: get('id'), version: get('version'), source: get('source'), commit: get('commit'), digest: get('digest') };
  });
  const out: Lock = { version: 1, stations };
  const rec = raw.production;
  if (isObject(rec) && typeof rec.id === 'string' && rec.id !== '') {
    out.production = {
      id: rec.id,
      compose: typeof rec.compose === 'number' ? rec.compose : 0,
      canvas: typeof rec.canvas === 'string' ? rec.canvas : '',
      prompt_sha256: typeof rec.prompt_sha256 === 'string' ? rec.prompt_sha256 : '',
    };
  }
  if (typeof raw.flow === 'string' && raw.flow !== '') out.flow = raw.flow;
  if (Array.isArray(raw.disabled)) {
    const disabled = raw.disabled.filter((x): x is string => typeof x === 'string').sort(compareBytes);
    if (disabled.length > 0) out.disabled = disabled;
  }
  return out;
}

export function writeLock(root: string, lock: Lock): void {
  const file = path.join(root, LockFile);
  if (lock.stations.length === 0 && !lock.flow && !lock.production && !(lock.disabled ?? []).length) {
    fs.rmSync(file, { force: true });
    return;
  }
  atomicWrite(file, marshalIndent(lock) + '\n', 0o644);
}

/** 新建时记下的流程；老项目或读不了锁文件为 null。 */
export function flowRecord(root: string): FlowRecord | null {
  try {
    return readLock(root).production ?? null;
  } catch {
    return null;
  }
}

/** 新建项目时记下流程（写在锁文件最前面）。 */
export function recordFlow(root: string, rec: FlowRecord): Lock {
  const { version, ...rest } = readLock(root);
  const next: Lock = { version, production: rec, ...rest };
  writeLock(root, next);
  return next;
}

/** 锁文件里选的流程（x:<站 id>），没选为空。读不了锁文件也当没选。 */
export function chosenFlow(root: string): string {
  try {
    const flow = readLock(root).flow;
    return flow ? `x:${flow}` : '';
  } catch {
    return '';
  }
}

/** 从镜头目录向上找有锁文件的项目根（最多 12 层）；找不到为空。 */
export function lockRootOf(sceneDir: string): string {
  let current = path.resolve(sceneDir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(current, LockFile))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

/** 把站加进项目（同 id 的换成新的），返回新锁文件。 */
export function addToProject(root: string, entry: LockEntry): Lock {
  const lock = readLock(root);
  const others = lock.stations.filter((e) => e.id !== entry.id);
  const next: Lock = { ...lock, stations: [...others, entry].sort((a, b) => compareBytes(a.id, b.id)) };
  writeLock(root, next);
  return next;
}

export function removeFromProject(root: string, id: string): Lock {
  const lock = readLock(root);
  if (!lock.stations.some((e) => e.id === id)) throw new Error(`这个项目没有加第三方站 ${id}`);
  // 去掉的站带着项目选用的流程：回到内置流程。
  const next: Lock = { ...lock, stations: lock.stations.filter((e) => e.id !== id) };
  if (next.flow === id) delete next.flow;
  writeLock(root, next);
  return next;
}
