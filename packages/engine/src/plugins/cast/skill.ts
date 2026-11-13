// 多角色对话插件的渲染技能 character-rig：目录名、驱动库文件名、契约标题与提示词片段。
import path from 'node:path';
import { SkillManifestFile, SourceEmbedded, type SkillDescriptor } from '../../scene/skills';

/** 角色驱动技能目录名。 */
export const CharacterRigSkillName = 'character-rig';

/** character-rig 技能里的驱动库文件名。它同时出现在 requiredFiles 与 castSection 的复制契约里，所以取一个常量。 */
export const castDriverFile = 'cast.js';

/**
 * castSection 在"本镜头有角色出场"时输出的段标题（不含前导换行与冒号），三处共同的契约锚点：
 * castSection 产出它、characterRigPrompt 的角色驱动门控靠"下方是否出现这个标题"决定要不要让
 * 渲染 agent 加载 character-rig 技能、character-rig/SKILL.md 里的复制义务说明也引用同一个标题
 * 告诉读者去哪找这条硬要求。前两处共享这一个常量，保证不会各自改动后措辞漂移；SKILL.md
 * 是纯文本，改动后不会编译失败，只能靠 assets 的测试把它钉在这个字面量上
 * （见 rig.test.ts 的 character-rig skill mentions CastRequiredHeading）。
 */
export const CastRequiredHeading = '角色（强制）';

/**
 * 角色驱动技能的提示词片段。
 *
 * 这里刻意不写驱动库的文件名，也不写任何角色契约的细节：那些属于
 * castSection，只在 scene.cast 不为 null 时才出现。没有角色的镜头必须拿不到
 * 任何角色相关的强制要求——老镜头（单口播）的提示词不能因为新增了这个技能
 * 就多出一段它永远用不上的契约，scene 的测试守着这一点。
 *
 * 本段只做一件事：把技能目录的本机绝对路径交出去。castSection 里那条
 * 「把驱动库复制进镜头目录」的契约需要一个源目录，而它就在这里。
 */
export function characterRigPrompt(skillsDir: string): string {
  if (skillsDir !== '') {
    return (
      '角色驱动（按需）：\n' +
      `- 本镜头如有角色出场（下方出现「${CastRequiredHeading}」段），必须加载 ${CharacterRigSkillName} 技能。本机该技能目录为：\n    ${path.join(skillsDir, CharacterRigSkillName)}\n` +
      `  实现前必须读其中的 ${SkillManifestFile}：它定义角色包目录结构、驱动库的挂载与转身/说话接口，以及四条硬规则。\n` +
      '- 没有角色的镜头忽略本段，不要自行引入角色。\n'
    );
  }
  return (
    '角色驱动（按需）：\n' +
    `- 本镜头如有角色出场（下方出现「${CastRequiredHeading}」段），必须加载 ${CharacterRigSkillName} 技能。\n` +
    '  （本机未能定位该技能目录，请使用你自身的技能加载机制载入。）\n' +
    '- 没有角色的镜头忽略本段，不要自行引入角色。\n'
  );
}

/** 描述符在 apply 时才造：scene/skills 与插件互相引用，模块加载期它的常量可能还没初始化。 */
export const characterRigSkill = (): SkillDescriptor => ({
  name: CharacterRigSkillName,
  source: SourceEmbedded,
  // 驱动库本身也是必需文件：只有 SKILL.md 而没有 cast.js 的技能目录，
  // 提示词里那条「把驱动库复制进镜头目录」的契约就无从执行。
  requiredFiles: [SkillManifestFile, castDriverFile],
  promptSection: characterRigPrompt,
});
