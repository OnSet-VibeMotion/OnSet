/**
 * 内置插件「Lottie 图层」（text-to-lottie）：登记渲染技能 text-to-lottie 与它在镜头提示词里的那一段。
 * 技能本体随项目骨架下发（assets/shared/.agents/skills/text-to-lottie/）。
 */
import path from 'node:path';
import type { BuiltinPlugin } from '../../plugin/types';
import { SkillManifestFile, SourceEmbedded } from '../../scene/skills';

/** Lottie 图层制作技能目录名。 */
export const TextToLottieSkillName = 'text-to-lottie';

/**
 * Lottie 图层技能的提示词片段。
 *
 * Lottie 是可选项而非默认项：烘进 JSON 的东西后期改不动，且文字与数据类动画
 * 交给 Lottie 会与 HTML 动效要求给出互相冲突的指令。因此这里的措辞必须把
 * 「默认不用」和「不计入动效预算」两条写死，否则渲染器会拿一个 Lottie 顶替
 * 整镜头的动效工作量。
 */
export function textToLottiePrompt(skillsDir: string): string {
  let reference = `- 需要时加载 ${TextToLottieSkillName} 技能。\n` + '  （本机未能定位该技能目录，请使用你自身的技能加载机制载入。）\n';
  if (skillsDir !== '') {
    const skill = path.join(skillsDir, TextToLottieSkillName);
    reference =
      `- 需要时加载 ${TextToLottieSkillName} 技能。本机该技能目录为：\n    ${skill}\n` +
      `  读取其中的 ${SkillManifestFile} 判断该不该用，再按其路由表只读匹配的 references/ 文件；\n` +
      `  若该路径不存在，改用你自身的技能加载机制载入 ${TextToLottieSkillName}。\n`;
  }
  return (
    'Lottie 图层（可选）：\n' +
    reference +
    '- 默认不用 Lottie。只有矢量图形、时间线自成一体、且用 CSS/GSAP 表达明显更笨重时才考虑，' +
    '典型是 logo 演绎、图标变形、loader、状态反馈、SVG 描边绘制、矢量质感特效。\n' +
    '- 文字排版、逐字动画、数字滚动、图表、转场与运镜一律不得交给 Lottie，' +
    '这些归 HTML 与上面的动效要求。任何时候都不得产出铺满画幅、承担镜头全部内容的 Lottie。\n' +
    '- Lottie 图层不计入上述动效要求的任何一条，持续性环境动效也不得用 Lottie 循环顶替；' +
    'HTML 侧必须独立满足全部动效要求。\n' +
    '- Lottie 由渲染框架逐帧 seek：播放器实例 autoplay 与 loop 均为 false 并注册到框架约定的全局数组，' +
    'JSON 内不得使用表达式、时钟或未播种随机，粒子与物理一类系统必须烘成关键帧。\n'
  );
}

export const textToLottie: BuiltinPlugin = {
  id: 'text-to-lottie',
  apply(ctx) {
    ctx.skill({ name: TextToLottieSkillName, source: SourceEmbedded, requiredFiles: [SkillManifestFile], promptSection: textToLottiePrompt });
  },
};
