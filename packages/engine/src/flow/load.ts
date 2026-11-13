/**
 * 读出项目加的站（第三方站加上没关掉的内置插件）、路线用的站、项目选用的流程。
 */
import fs from 'node:fs';
import { builtinPlugins, disabledAmStations } from './builtinplugins';
import { treeDigest } from './digest';
import { checkFiles, readManifest, sourceDir } from './fetch';
import { readLock, writeLock, type LoadedStation, type Lock } from './lock';
import { toExtra } from './pages';
import type { ExtraStation } from './types';

/**
 * 读出项目加的全部第三方站。读不到、摘要对不上、清单坏了的站不返回，原因放进 problems：
 * 制作路线、提示词照常工作，界面把问题告诉用户。
 */
export function loadProjectStations(root: string, env: Record<string, string | undefined> = process.env): { stations: LoadedStation[]; problems: string[] } {
  const out: LoadedStation[] = [];
  const problems: string[] = [];
  let lock: Lock;
  try {
    lock = readLock(root);
  } catch (err) {
    return { stations: [], problems: [(err as Error).message] };
  }
  for (const entry of lock.stations) {
    try {
      const dir = sourceDir(entry, env);
      if (!fs.existsSync(dir)) throw new Error(`本机没有这个站（${entry.source}），在设置里重新添加`);
      if (entry.digest !== '' && treeDigest(dir) !== entry.digest) throw new Error(`内容和添加时不一样了（${dir}），为安全起见不用它；在设置里重新添加`);
      const manifest = readManifest(dir);
      if (manifest.id !== entry.id) throw new Error(`清单里的 id 是 ${manifest.id}，与记录的 ${entry.id} 不符`);
      checkFiles(dir, manifest);
      out.push({ entry, dir, manifest });
    } catch (err) {
      problems.push(`第三方站 ${entry.id}：${(err as Error).message}`);
    }
  }
  // 内置插件：默认启用，项目关掉的（锁文件 disabled）不算。排在第三方站前面，按 id 排序。
  const disabled = new Set(lock.disabled ?? []);
  const builtins = builtinPlugins().filter((b) => !disabled.has(b.manifest.id));
  return { stations: [...builtins, ...out], problems };
}

/** 项目路线用的第三方站。 */
export function projectExtras(root: string, env: Record<string, string | undefined> = process.env): ExtraStation[] {
  const extras = loadProjectStations(root, env).stations.map((s) => toExtra(s.manifest));
  // 关掉的内置插件认领的站：用一个没有站点的站顶替，路线上就没有它了。排在最后：第三方站顶替了同一个站时以第三方为准。
  for (const sid of disabledAmStations(root)) {
    extras.push({ station: { id: `off:${sid}`, name: '', nodes: [], prompt: [] }, after: '', replaces: sid });
  }
  return extras;
}

/** 选用某个站带来的流程（id 为空回到内置流程）。 */
export function setProjectFlow(root: string, id: string, env: Record<string, string | undefined> = process.env): Lock {
  const lock = readLock(root);
  if (id !== '') {
    const s = loadProjectStations(root, env).stations.find((x) => x.manifest.id === id);
    if (!s) throw new Error(`这个项目没有加第三方站 ${id}`);
    if (!s.manifest.flow) throw new Error(`第三方站 ${s.manifest.name} 没有带流程`);
  }
  const next: Lock = { ...lock };
  if (id !== '') next.flow = id;
  else delete next.flow;
  writeLock(root, next);
  return next;
}

/** 项目选用的第三方流程的站；没选或读不到为 null。 */
export function activeFlowStation(root: string, stations: readonly LoadedStation[]): LoadedStation | null {
  let lock: Lock;
  try {
    lock = readLock(root);
  } catch {
    return null;
  }
  if (!lock.flow) return null;
  const s = stations.find((x) => x.manifest.id === lock.flow);
  return s?.manifest.flow ? s : null;
}
