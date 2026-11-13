/**
 * 内置插件「生成式艺术」（algorithmic-art）：登记渲染技能 algorithmic-art 与它在镜头提示词里的那一段。
 * 技能本体随项目骨架下发（assets/shared/.agents/skills/algorithmic-art/）。项目关掉这个插件时，渲染器拿不到它、
 * 提示词里也没有这一段（已渲染的镜头因此变成要重渲染，这是对的：渲染输入变了）。
 */
import path from 'node:path';
import type { BuiltinPlugin } from '../../plugin/types';
import { SkillManifestFile, SourceEmbedded } from '../../scene/skills';

/** 生成式艺术技能目录名。 */
export const AlgorithmicArtSkillName = 'algorithmic-art';

/** 生成式艺术技能的提示词片段。 */
export function algorithmicArtPrompt(skillsDir: string): string {
  if (skillsDir !== '') {
    const skill = path.join(skillsDir, AlgorithmicArtSkillName);
    return (
      '生成式艺术参考：\n' +
      `- 如需使用算法艺术/生成式视觉效果，加载 ${AlgorithmicArtSkillName} 技能。本机该技能目录为：\n    ${skill}\n` +
      '  读取其中的 SKILL.md（工作流与不变量）和 references/ 目录（技术目录、配色规则、动画配方）。\n' +
      '- 该技能提供 50+ 算法技术（10 个分类）、OKLab 配色插值、完美循环动画模板。\n' +
      '- 使用时遵守反默认规则：禁止单独使用 Perlin 流场/粒子轨迹/圆填充/递归树/Voronoi 作为唯一想法，\n' +
      '  必须组合两个正交技术或使用目录中更冷门的算法。\n'
    );
  }
  return (
    '生成式艺术参考：\n' +
    `- 如需使用算法艺术/生成式视觉效果，加载 ${AlgorithmicArtSkillName} 技能。\n` +
    '  （本机未能定位该技能目录，请使用你自身的技能加载机制载入。）\n' +
    '- 该技能提供 50+ 算法技术、OKLab 配色、完美循环动画。使用时遵守反默认规则。\n'
  );
}

export const algorithmicArt: BuiltinPlugin = {
  id: 'algorithmic-art',
  apply(ctx) {
    ctx.skill({ name: AlgorithmicArtSkillName, source: SourceEmbedded, requiredFiles: [SkillManifestFile], promptSection: algorithmicArtPrompt });
  },
};
