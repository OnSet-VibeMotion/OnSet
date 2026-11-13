/**
 * 第三方站带给渲染器的技能（清单的 renderer_skills）。
 */
import path from 'node:path';
import { loadProjectStations } from './load';
import { lockRootOf } from './lock';

/**
 * 镜头要带上的第三方渲染技能：键是 plugin:<站>/<技能>，值是技能目录的绝对路径。
 * 从镜头目录向上找到有锁文件的项目根；读不出来的站不算（制作提示词那边会报错）。
 * 点名了却没有的技能直接报错：降级成「不用」会一路静默到成片。
 */
export function pluginSkillsFor(sceneDir: string, named: readonly string[], env: Record<string, string | undefined> = process.env): Record<string, string> {
  const root = lockRootOf(sceneDir);
  const out: Record<string, string> = {};
  const stations = root === '' ? [] : loadProjectStations(root, env).stations;
  for (const s of stations) {
    for (const rs of s.manifest.renderer_skills) {
      const ref = `${s.manifest.id}/${rs.name}`;
      if (rs.scenes === 'all' || named.includes(ref)) out[`plugin:${ref}`] = path.join(s.dir, rs.dir);
    }
  }
  for (const ref of named) {
    if (!(`plugin:${ref}` in out)) throw new Error(`镜头要用的插件技能 ${ref} 不在这个项目加的第三方站里`);
  }
  return out;
}
