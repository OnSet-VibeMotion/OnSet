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
 * 新建项目时记下的流程（片型）与画幅。制作提示词由运行期按它组合（compose.ts）；项目用哪个流程也只看它
 * （第三方流程另记在 Lock.flow）。没有它的目录不是这一版建的项目：detectFlow 直接报错，不按标记文件推断。
 */
export interface FlowRecord {
  /** 内置流程或内置插件的流程：speech、beat、song。第三方流程记在 Lock.flow（站 id）。 */
  id: string;
  /** 画幅（预设 id），组合提示词时替换画幅占位符用。 */
  canvas: string;
}

export interface Lock {
  version: 1;
  /** 新建项目时记下的流程。 */
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
    out.production = { id: rec.id, canvas: typeof rec.canvas === 'string' ? rec.canvas : '' };
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

/** 新建时记下的流程；没有记录或读不了锁文件为 null。 */
export function flowRecord(root: string): FlowRecord | null {
  try {
    return readLock(root).production ?? null;
  } catch {
    return null;
  }
}

/** 记下（或换掉）项目的流程（写在锁文件最前面）。 */
export function recordFlow(root: string, rec: FlowRecord): Lock {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { version, production: _old, ...rest } = readLock(root);
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
