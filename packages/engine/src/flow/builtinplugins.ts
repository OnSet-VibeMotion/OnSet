/**
 * 内置插件：ArticleToMotion 自己的可选功能也写成插件，放在 assets/plugins/<id>/，用同一份 am-station.json。
 * 只有它们能写 am_ops / am_skills / am_stations（认领 am 自带的操作、渲染技能与站）和 in_use。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assetsBase } from '../assets';
import { compareBytes } from '../gojson';
import { checkFiles } from './fetch';
import { lockRootOf, readLock, writeLock, type LoadedStation, type Lock } from './lock';
import { ManifestFile, type Manifest } from './manifest';
import { parseManifest } from './parse';
import * as plugin from '../plugin';
import { pluginStationOwners } from './registered';

/** 内置插件的目录：assets/plugins/<id>/am-station.json，随客户端下发（extraResources 带着整棵 assets）。 */
export function builtinPluginsDir(): string {
  return path.join(assetsBase(), 'assets', 'plugins');
}

let builtinCache: { dir: string; plugins: LoadedStation[] } | null = null;

/** 全部内置插件（按 id 排序）。清单坏了直接报错：那是 ArticleToMotion 自己的 bug，不能静默少一个功能。 */
export function builtinPlugins(): LoadedStation[] {
  let dir: string;
  try {
    dir = builtinPluginsDir();
  } catch {
    return [];
  }
  if (builtinCache && builtinCache.dir === dir) return builtinCache.plugins;
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort(compareBytes);
  } catch {
    names = [];
  }
  const plugins = names.map((name): LoadedStation => {
    const pluginDir = path.join(dir, name);
    const manifest = parseManifest(fs.readFileSync(path.join(pluginDir, ManifestFile), 'utf8'), { builtin: true });
    if (manifest.id !== name) throw new Error(`内置插件 ${name} 的 id 写成了 ${manifest.id}`);
    checkFiles(pluginDir, manifest);
    return { entry: { id: manifest.id, version: manifest.version, source: 'builtin', commit: '', digest: '' }, dir: pluginDir, manifest, builtin: true };
  });
  builtinCache = { dir, plugins };
  return plugins;
}

/** 内置插件的 id（第三方站不能重名）。 */
export function builtinPluginIDs(): string[] {
  return builtinPlugins().map((p) => p.manifest.id);
}

/** 这个项目关掉的内置插件的 am 操作（清单 am_ops 认领的与 apply 登记的）：工具服务据此把它们从工具列表里拿掉。 */
export function disabledAmOps(root: string): Set<string> {
  let lock: Lock;
  try {
    lock = readLock(root);
  } catch {
    return new Set();
  }
  const disabled = new Set(lock.disabled ?? []);
  return new Set([
    ...builtinPlugins().filter((p) => disabled.has(p.manifest.id)).flatMap((p) => p.manifest.am_ops),
    ...plugin.pluginOps().filter((o) => disabled.has(o.owner)).map((o) => o.value.name),
  ]);
}

/**
 * 镜头所在项目关掉的内置插件认领的渲染技能。从镜头目录向上找有锁文件的项目根；没有锁文件就一个都没关。
 */
export function disabledAmSkills(sceneDir: string): Set<string> {
  const root = lockRootOf(sceneDir);
  if (root === '') return new Set();
  let lock: Lock;
  try {
    lock = readLock(root);
  } catch {
    return new Set();
  }
  const disabled = new Set(lock.disabled ?? []);
  return new Set(builtinPlugins().filter((p) => disabled.has(p.manifest.id)).flatMap((p) => p.manifest.am_skills));
}

/**
 * 打开或关掉这个项目的一个内置插件。项目正在用它（清单的 in_use 文件存在，例如歌曲讲解的 song.yaml）时不许关：
 * 关了它，正在做的片子就少了工具。
 */
export function setBuiltinEnabled(root: string, id: string, enabled: boolean): Lock {
  const plugin = builtinPlugins().find((p) => p.manifest.id === id);
  if (!plugin) throw new Error(`没有内置插件 ${id}`);
  if (!enabled) {
    const busy = inUse(root, plugin.manifest);
    if (busy !== '') throw new Error(`这个项目正在用「${plugin.manifest.name}」（有 ${busy}），不能关掉`);
  }
  const lock = readLock(root);
  const disabled = new Set(lock.disabled ?? []);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  const next: Lock = { ...lock };
  if (disabled.size > 0) next.disabled = [...disabled].sort(compareBytes);
  else delete next.disabled;
  writeLock(root, next);
  return next;
}

/** 项目在用这个内置插件的凭据文件（清单 in_use 里第一个存在的）；没有为空。 */
export function inUse(root: string, m: Manifest): string {
  return m.in_use.find((rel) => fs.existsSync(path.join(root, rel))) ?? '';
}

/** 这个项目关掉的内置插件的站（清单 am_stations 认领的与 apply 登记的）。 */
export function disabledAmStations(root: string): string[] {
  let lock: Lock;
  try {
    lock = readLock(root);
  } catch {
    return [];
  }
  const disabled = new Set(lock.disabled ?? []);
  return [
    ...builtinPlugins()
      .filter((p) => disabled.has(p.manifest.id))
      .flatMap((p) => p.manifest.am_stations),
    ...plugin.pluginStations().filter((s) => disabled.has(s.owner)).map((s) => s.value.id),
  ];
}

/** 自带的站归哪个内置插件（清单认领的与 apply 登记的；没有归属的不在表里）。生成制作提示词时据此加标记。 */
export function stationOwners(): Map<string, string> {
  const out = pluginStationOwners();
  for (const p of builtinPlugins()) for (const sid of p.manifest.am_stations) out.set(sid, p.manifest.id);
  return out;
}
