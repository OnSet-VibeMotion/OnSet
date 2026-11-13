/**
 * 内置插件「多角色对话」（cast）：几个角色你一句我一句地讲。
 *
 * | 登记的 | 是什么 |
 * |---|---|
 * | 操作 | cast_new / cast_add / cast_validate / cast_preview、dialogue_beats / dialogue_assemble、validate_cast（ops.ts） |
 * | 渲染技能 | character-rig（skill.ts）：角色驱动库与它在镜头提示词里的那一段 |
 * | 镜头扩展块 | scene.json 的 cast 块（block.ts）：校验、角色段提示词、角色包摘要进指纹 |
 * | 叙事模式 | cast：新建项目时写出 cast.yaml 与空的 cast/（scaffold.ts） |
 * | 在用判断 | 项目里有 cast.yaml 就不许关 |
 *
 * 引擎里的角色包格式（cast/）、对白（dialogue/）与节拍切分（castbeats/）仍在原包里，这里引用它们。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as cast from '../../cast';
import type { BuiltinPlugin } from '../../plugin/types';
import { castBlock } from './block';
import { castOps } from './ops';
import { writeCastScaffold } from './scaffold';
import { characterRigSkill } from './skill';

export { castBlock } from './block';
export type { Actor, Beat, Cast } from './block';
export { BeatOverlapToleranceSeconds, castSection, castToJSON, castType, validateCast } from './block';
export { CastDefaultGapMs, CastDefaultGroundY, castYAML, writeCastScaffold } from './scaffold';
export { CastRequiredHeading, CharacterRigSkillName, castDriverFile, characterRigPrompt } from './skill';
export { beatsRecomputeHint, castProblems, setDialogueRelPath } from './validate';
export { copyTree } from './ops';

/** 叙事模式 id（am init --narration cast）。 */
export const NarrationCast = 'cast';

export const castPlugin: BuiltinPlugin = {
  id: 'cast',
  apply(ctx) {
    castOps(ctx);
    ctx.skill(characterRigSkill());
    ctx.sceneBlock(castBlock);
    ctx.narration({ id: NarrationCast, name: '多角色对话', hint: '几个角色你一句我一句地讲', init: writeCastScaffold });
    ctx.preset({
      id: 'cast',
      label: '角色对白',
      hint: '多个角色你一言我一语',
      delivery: 'speech',
      narration: NarrationCast,
      canvas: 'vertical-3x4',
      example: '用两个角色一问一答的方式讲这件事，一个好奇一个专业',
    });
    ctx.inUse((root) => (fs.existsSync(path.join(root, cast.RosterFile)) ? cast.RosterFile : ''));
  },
};
