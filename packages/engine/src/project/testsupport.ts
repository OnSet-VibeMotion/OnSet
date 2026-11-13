// 本包测试共用的常量与辅助，对应 Go 测试文件里的包级辅助（skilltree_test.go、init_test.go）。
// 不从 index.ts 导出。
import * as assets from '../assets';
import { defaultPreset, defaultStyle } from '../preset';
import { compareBytes } from '../gojson';
import type { SourceTree } from './init';

/** skillManifest 是每个技能的必需清单文件，与 scene 包的约定保持一致。 */
export const skillManifest = 'SKILL.md';

/**
 * skillTreeRoot 是技能树在项目根下的位置。scene.resolveSkill 从镜头目录逐级
 * 向上找的就是这个相对路径。
 */
export const skillTreeRoot = '.agents/skills';

/** builtinSources 返回一次真实 am init 会用到的三棵源树。 */
export function builtinSources(): SourceTree[] {
  const shared = assets.shared();
  const chosen = assets.preset(defaultPreset().id);
  const style = assets.style(defaultStyle().id, defaultPreset().id);
  return [shared, chosen, style];
}

/** mapTree 对应 testing/fstest.MapFS：键是 / 分隔的相对路径。 */
export function mapTree(files: Record<string, string>): SourceTree {
  return {
    walkFiles: () => Object.keys(files).sort(compareBytes),
    readFile: (rel: string) => {
      if (!(rel in files)) throw new Error(`open ${rel}: file does not exist`);
      return Buffer.from(files[rel]);
    },
  };
}
