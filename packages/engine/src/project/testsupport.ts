// 本包测试共用的常量与辅助，对应 Go 测试文件里的包级辅助（skilltree_test.go、init_test.go）。
// 不从 index.ts 导出。
import * as assets from '../assets';
import * as flow from '../flow';
import * as preset from '../preset';
import { substituteCanvas } from '../preset/gen/gen';
import { compareBytes } from '../gojson';
import type { SourceTree } from './init';

/** skillManifest 是每个技能的必需清单文件，与 scene 包的约定保持一致。 */
export const skillManifest = 'SKILL.md';

/**
 * skillTreeRoot 是技能树在项目根下的位置。scene.resolveSkill 从镜头目录逐级
 * 向上找的就是这个相对路径。
 */
export const skillTreeRoot = '.agents/skills';

/** builtinSources 返回一次真实 am init 会用到的两棵源树。 */
export function builtinSources(): SourceTree[] {
  return [assets.shared(), assets.style(preset.defaultStyle().id, preset.defaultPreset().id)];
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

/** 有自己提示词段落顺序的内置流程（口播、卡点、歌曲讲解）。 */
export function builtinFlowIDs(): string[] {
  return flow
    .allFlows()
    .filter((f) => f.prompt)
    .map((f) => f.id);
}

/** 按流程组合出的制作提示词（不加任何项目里的站）；disabled 是关掉的内置插件的站。 */
export function composeFor(id: string, canvas: string, disabled: readonly string[] = []): string {
  const p = preset.byID(canvas);
  if (!p) throw new Error(`没有画幅 ${canvas}`);
  return flow.composeFlowPrompt({ flow: id, stations: [], disabled: new Set(disabled), canvas: (t) => substituteCanvas(p, t) });
}

/** 每个内置流程 × 每个画幅 × 发布开与关的组合结果，给对全部提示词成立的门禁用。 */
export function everyBuiltinPrompt(): { name: string; flow: string; canvas: string; text: string }[] {
  const out: { name: string; flow: string; canvas: string; text: string }[] = [];
  for (const id of builtinFlowIDs()) {
    for (const p of preset.all()) {
      for (const disabled of [[], ['publish']]) {
        out.push({ name: `${id}/${p.id}${disabled.length ? '（关掉发布）' : ''}`, flow: id, canvas: p.id, text: composeFor(id, p.id, disabled) });
      }
    }
  }
  return out;
}
