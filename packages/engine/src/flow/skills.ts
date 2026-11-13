/**
 * 第三方插件带给渲染器的技能（清单的 renderer_skills）。插件装在用户级，对所有项目一样。
 */
import path from 'node:path';
import { loadStations } from './load';

/**
 * 镜头要带上的第三方渲染技能：键是 plugin:<插件>/<技能>，值是技能目录的绝对路径。`scenes: all` 的每个镜头都带，
 * opt-in 的只给镜头 plugin_skills 点名的。读不出来的插件不算（参与制作的项目开工时会报错）。
 * 点名了却没有的技能直接报错：降级成「不用」会一路静默到成片。
 */
export function pluginSkillsFor(named: readonly string[], env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of loadStations(env).stations) {
    for (const rs of s.manifest.renderer_skills) {
      const ref = `${s.manifest.id}/${rs.name}`;
      if (rs.scenes === 'all' || named.includes(ref)) out[`plugin:${ref}`] = path.join(s.dir, rs.dir);
    }
  }
  for (const ref of named) {
    if (!(`plugin:${ref}` in out)) throw new Error(`镜头要用的插件技能 ${ref} 不在这台电脑装的插件里`);
  }
  return out;
}
