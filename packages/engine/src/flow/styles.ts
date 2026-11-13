/**
 * 第三方插件带来的整片风格库：清单的 film_styles 指向站目录里的一个目录式风格库（filmstyle.DirectorySource），
 * 来源 ID 是 x-<站 id>。与内置插件登记的来源是同一种 filmstyle.Source，区别只在可见范围：
 * 插件来源只对加了这个插件的项目可见，用到风格来源的地方先 syncStyleSources(项目根)。
 *
 * 风格库在插件目录里（随插件按 commit 钉死），不联网、没有前置资源。
 */
import path from 'node:path';
import * as filmstyle from '../filmstyle';
import { loadProjectStations, type LoadedStation } from './external';

/** 一个第三方站的风格库来源。 */
export function pluginStyleSource(station: LoadedStation): filmstyle.Source {
  const m = station.manifest;
  return new filmstyle.DirectorySource({
    id: filmstyle.PluginSourcePrefix + m.id,
    name: `${m.film_styles!.name}（插件）`,
    dir: path.join(station.dir, m.film_styles!.dir),
    version: station.entry.commit || `${m.id}@${m.version}`,
    origin: `用户添加的第三方插件「${m.name}」`,
  });
}

/** 按项目换上插件的风格来源（root 为空时只去掉插件来源）。 */
export function syncStyleSources(root: string, env: Record<string, string | undefined> = process.env): void {
  const stations = root === '' ? [] : loadProjectStations(root, env).stations;
  filmstyle.useProjectSources(stations.filter((s) => s.manifest.film_styles).map(pluginStyleSource));
}
