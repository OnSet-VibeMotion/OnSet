/**
 * 内置插件：片场自己的功能也写成插件，清单（名字、说明）在 assets/plugins/<id>/onset-station.json，
 * 代码在 packages/engine/src/plugins/<id>/ 的 apply 里登记（站、操作、渲染技能、镜头扩展块……）。内置插件常开，
 * 没有关掉的办法：它登记的东西对每个项目都在，一个流程用不用得上由流程自己的声明决定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assetsBase } from '../assets';
import { compareBytes } from '../gojson';
import { checkFiles } from './fetch';
import { roleOf, type LoadedStation } from './installed';
import { ManifestFile } from './manifest';
import { parseManifest } from './parse';
import { pluginStationOwners } from './registered';

/** 内置插件的目录：assets/plugins/<id>/onset-station.json，随客户端下发（extraResources 带着整棵 assets）。 */
export function builtinPluginsDir(): string {
  return path.join(assetsBase(), 'assets', 'plugins');
}

let builtinCache: { dir: string; plugins: LoadedStation[] } | null = null;

/** 全部内置插件（按 id 排序）。清单坏了直接报错：那是片场自己的 bug，不能静默少一个功能。 */
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
    return { entry: { id: manifest.id, version: manifest.version, source: 'builtin', commit: '', digest: '', role: roleOf(manifest) }, dir: pluginDir, manifest, builtin: true };
  });
  builtinCache = { dir, plugins };
  return plugins;
}

/** 内置插件的 id（第三方站不能重名）。 */
export function builtinPluginIDs(): string[] {
  return builtinPlugins().map((p) => p.manifest.id);
}

/** 自带的站归哪个内置插件（apply 登记的；没有归属的不在表里）。生成制作提示词时据此加标记。 */
export function stationOwners(): Map<string, string> {
  return pluginStationOwners();
}
