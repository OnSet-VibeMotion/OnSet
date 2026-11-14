// 歌曲讲解插件的渲染技能 song-explainer。它的提示词只在歌曲镜头里出现（song 块的提示词段引用它），
// 所以描述符不写 promptSection，不进每个镜头都有的技能段。
import path from 'node:path';
import { SkillManifestFile, SourceEmbedded, type SkillDescriptor } from '../../scene/skills';


export const SongExplainerSkillName = 'song-explainer';

export function songExplainerPrompt(dir: string): string {
  if (dir === '') return '读取 song-explainer 技能，仅执行单镜头歌词驱动动画规则。\n';
  return `读取 ${path.join(dir, SongExplainerSkillName, SkillManifestFile)}，仅执行单镜头歌词驱动动画规则。\n`;
}

/** 描述符在 apply 时才造：scene/skills 与插件互相引用，模块加载期它的常量可能还没初始化。 */
export const songExplainerSkill = (): SkillDescriptor => ({ name: SongExplainerSkillName, source: SourceEmbedded, requiredFiles: [SkillManifestFile] });
