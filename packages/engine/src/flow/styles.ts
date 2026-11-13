/**
 * 第三方插件带来的整片风格库：清单的 film_styles 指向插件目录里的一个目录式风格库（filmstyle.DirectorySource），
 * 来源 ID 是 x-<插件 id>。与内置插件登记的来源是同一种 filmstyle.Source；插件装在用户级，它的风格对所有项目
 * 与首页（还没有项目时）都可见：本模块加载时把读取函数交给 filmstyle（usePluginSources），filmstyle.sources() 现读。
 *
 * 风格库在插件目录里（随插件按 commit 钉死），不联网、没有前置资源。
 */
import path from 'node:path';
import * as filmstyle from '../filmstyle';
import type { LoadedStation } from './installed';
import { loadStations } from './load';

/** 一个第三方插件的风格库来源。 */
export function pluginStyleSource(station: LoadedStation): filmstyle.Source {
  const m = station.manifest;
  const fs = m.film_styles!;
  return new filmstyle.DirectorySource({
    id: filmstyle.PluginSourcePrefix + m.id,
    name: `${fs.name}（插件）`,
    dir: path.join(station.dir, fs.dir),
    version: station.entry.commit || `${m.id}@${m.version}`,
    origin: `用户装的第三方插件「${m.name}」`,
    ...(fs.only_referenced ? { onlyReferenced: true } : {}),
  });
}

/** 已装的第三方插件带来的风格来源（读不出来的插件不算）。 */
export function pluginStyleSources(env: Record<string, string | undefined> = process.env): filmstyle.Source[] {
  return loadStations(env)
    .stations.filter((s) => !s.builtin && s.manifest.film_styles)
    .map(pluginStyleSource);
}

filmstyle.usePluginSources(() => pluginStyleSources());
