// 整片风格与风格切换的目录解析及提示词段落生成。
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '../filmstyle';
import {
  FilmStyleEnterKey,
  FilmStyleExitKey,
  FilmStyleOwnKey,
  hasSkill,
  portableSkillsDir,
  projectCandidates,
} from './skills_constants';
import { styleShiftOf } from './timing_handoff';
import type { Handoff, Timing } from './timing_types';

/** resolveAllSkills 要的镜头字段：本镜头的整片风格与交接约定。 */
export interface SceneFilmInput {
  film_style: string;
  timing: Pick<Timing, 'enter' | 'exit'> | null;
  /** 点名的第三方插件技能（scene.json 的 plugin_skills）。 */
  plugin_skills?: string[];
  /** 点名的动效标识（scene.json 的 motion_effects），命中的第三方插件动效自动联动其 renderer_skill。 */
  motion_effects?: string[];
}

/**
 * 镜头 film_style 取值对应的风格目录（含 STYLE.md 与 SKILL.md 的那一层）：
 * 空是默认风格，none 或项目没有默认风格时为空串，「来源/目录名」在项目里找默认或额外风格。
 */
export function resolveSceneFilmStyle(sceneDir: string, value: string): string {
  if (value === filmstyle.NoFilmStyle) return '';
  if (value === '') {
    const root = resolveFilmStyle(sceneDir);
    return root === '' ? '' : filmStyleDir(root);
  }
  for (const project of projectCandidates(sceneDir, '.')) {
    let dir: string;
    try {
      dir = filmstyle.styleDirOf(project, value);
    } catch {
      continue;
    }
    if (dir !== '' && hasSkill(path.dirname(dir), path.basename(dir), [filmstyle.GuideFile, filmstyle.StyleFile])) {
      return dir;
    }
  }
  throw new Error(`镜头要用的整片风格 ${value} 没装进项目：运行 film_style_add({"style": "${value}"})`);
}

/** 本镜头实际用的风格目录（默认或点名），没有整片风格时为空串。 */
function ownFilmStyleDir(s: SceneFilmInput, resolved: Record<string, string>): string {
  if (s.film_style === '') {
    const root = resolved[filmstyle.SkillName] ?? '';
    return root === '' ? '' : filmStyleDir(root);
  }
  return resolved[FilmStyleOwnKey] ?? '';
}

/**
 * 镜头点名的风格段：与 filmStyleSection 同一套要求，只是不再说「本片所有镜头」——
 * 别的镜头可能是另一种风格。
 */
export function sceneFilmStyleSection(dir: string, hasLook: boolean): string {
  let palette = '配色按 STYLE.md 的配色逻辑为本镜头选定';
  if (hasLook) palette = '配色遵守下面的「全片配色」（在 STYLE.md 的配色逻辑里只用这几种颜色）';
  return (
    '\n整片风格（强制）：本镜头画成下面这种风格（本片不同段落可能用不同风格，本镜头只管自己这一种），本机该技能目录为：\n    ' +
    dir +
    '\n' +
    '- 动手前先读该目录的 ' +
    filmstyle.GuideFile +
    ' 与 ' +
    filmstyle.StyleFile +
    ' 全文。STYLE.md 规定的外观、材质、字体、动效质感、镜头语法、标志手法与禁忌全部遵守；' +
    palette +
    '。\n' +
    '- 画什么只取本镜头的说明、字幕与素材，不照搬风格自带的示例（demo 等）的故事、镜头、道具与文案；示例与引擎只用来学技法，按 SKILL.md 说的把用到的文件拷进本镜头目录再改，不得引用镜头目录之外的路径。\n' +
    '- STYLE.md 里关于声音、配乐的内容对本镜头无效：产物静音、无音轨。\n' +
    '- 项目里的 frame.md 只提供画布、安全区、字幕版式与响度目标，不是视觉命令。\n'
  );
}

/**
 * 风格切换段：交界两侧风格不同时，告诉本侧渲染器手法、自己负责哪一段，以及对方风格在哪。
 *
 * 两侧分别渲染、互相看不到，只拿到同一份约定；画法的过渡由约定指定的一侧完成
 * （材质转化、画内揭开由下一镜头开场完成，画中画推入由上一镜头末段完成），
 * 另一侧只要把交界帧画对。需要按对方风格画的那一侧拿到对方 STYLE.md 的路径。
 */
export function styleShiftSection(s: SceneFilmInput, resolved: Record<string, string>): string {
  const own = ownFilmStyleDir(s, resolved);
  let b = '';
  const sides: Array<[Handoff | undefined, string, string, 'enter' | 'exit']> = [
    [s.timing?.enter, FilmStyleEnterKey, '上一镜头', 'enter'],
    [s.timing?.exit, FilmStyleExitKey, '下一镜头', 'exit'],
  ];
  for (const [h, key, role, side] of sides) {
    if (!h || h.style_shift === '') continue;
    const shift = styleShiftOf(h.style_shift);
    if (!shift) continue;
    const peer = resolved[key] ?? '';
    if (peer === own) continue;
    if (b === '') b = '\n风格切换（强制，由分镜计划约定；交界两侧的风格不同，画法要在画面里换过去，不能突变）：\n';
    b += `- ${side === 'enter' ? '入场' : '出场'}：与${role} ${h.peer} 的交界用「${shift.name}」（${shift.id}）——${shift.guide}。\n`;
    b +=
      '  本镜头的风格：' +
      (own === '' ? '没有整片风格，按上面的「视觉自由度」自主决定。\n' : '见上面的「整片风格」段。\n');
    if (peer === '') b += `  ${role}的风格：没有整片风格；要按它的画法画的部分，以「镜头交接」里写的交界帧为准。\n`;
    else {
      b += `  ${role}的风格：本机该技能目录为\n    ${peer}\n  要按它的画法画的部分，先读该目录的 ${filmstyle.StyleFile}，只取外观、材质、笔触、线条、配色与字体，不看它的示例、不用它的镜头语法与时间安排。\n`;
    }
    b += `  本镜头要做的：${side === 'enter' ? shift.enterDuty : shift.exitDuty}\n`;
  }
  if (b === '') return '';
  b +=
    '- 风格只能通过画面里的东西换过去：不得用整画面叠化、淡出淡入黑场或白场、与画面无关的擦除、故障或闪白。过渡完成后本镜头全部回到自己的风格。\n';
  b +=
    '- 画完用 snapshot 截取交界附近几帧（入场看第 0 帧到过渡结束，出场看过渡开始到最后一帧），确认过渡途中每一帧都像是同一件东西在变，而不是两张画面叠在一起。\n';
  return b;
}

/**
 * 从镜头目录逐级向上找项目里的整片风格，返回它所在的技能目录
 * （.agents/skills 的绝对路径）；没有时返回空串。
 *
 * 只找项目级，不找家目录：整片风格是一个项目的选择，家目录里的一份会悄悄套到
 * 本机所有项目上。它不进 registeredSkills——那张表的契约是「解析不到时退回按
 * 名字引用」，而整片风格解析不到的意思是本片没有整片风格，镜头照旧自主定视觉。
 * 解析到时它和注册技能一样进 resolved：输入指纹记它的内容摘要，安全模式放行读取。
 * 这里只认契约（STYLE.md + SKILL.md），不关心风格来自哪个来源。
 */
export function resolveFilmStyle(sceneDir: string): string {
  for (const candidate of projectCandidates(sceneDir, portableSkillsDir)) {
    if (filmStyleDir(candidate) !== '') return candidate;
  }
  return '';
}

/** 技能目录里的整片风格目录；没有时为空。 */
function filmStyleDir(skillsDir: string): string {
  const name = filmstyle.SkillName;
  return hasSkill(skillsDir, name, [filmstyle.GuideFile, filmstyle.StyleFile]) ? path.join(skillsDir, name) : '';
}

/**
 * 整片风格段，替换掉「视觉自由度」。不点名任何风格来源：
 * 来源特有的用法（引擎、页面契约、技法参考在哪）写在各自的 SKILL.md 里。
 */
export function filmStyleSection(skillsDir: string, hasLook: boolean): string {
  const dir = filmStyleDir(skillsDir);
  let palette = '配色按 STYLE.md 的配色逻辑为本镜头选定';
  if (hasLook) palette = '配色遵守下面的「全片配色」（它是在 STYLE.md 的配色逻辑里为本片选定的）';
  return (
    '\n整片风格（强制）：本片所有镜头画成同一种风格，本机该技能目录为：\n    ' +
    dir +
    '\n' +
    '- 动手前先读该目录的 ' +
    filmstyle.GuideFile +
    ' 与 ' +
    filmstyle.StyleFile +
    ' 全文。STYLE.md 规定的外观、材质、字体、动效质感、镜头语法、标志手法与禁忌全部遵守；' +
    palette +
    '。\n' +
    '- 画什么只取本镜头的说明、字幕与素材，不照搬风格自带的示例（demo 等）的故事、镜头、道具与文案；示例与引擎只用来学技法，按 SKILL.md 说的把用到的文件拷进本镜头目录再改，不得引用镜头目录之外的路径。\n' +
    '- STYLE.md 里关于声音、配乐的内容对本镜头无效：产物静音、无音轨。\n' +
    '- 项目里的 frame.md 只提供画布、安全区、字幕版式与响度目标，不是视觉命令。\n'
  );
}

/** v6 内联进跨镜头公共前缀的默认整片风格 STYLE.md 摘要上限（字符），省去每镜重复读 20KB+ 风格文档。 */
const styleInlineLimit = 3200;
/** v7 去掉声音/配乐段落后的内联上限（字符），完整覆盖绝大多数 STYLE.md 的视觉规范，杜绝渲染器再去通读 STYLE.md / DEMO.md / demo/。 */
const styleInlineLimitV7 = 8500;

/** 去掉 STYLE.md 里仅与声音、配乐、音效有关的二级章节（单镜产物恒为静音无音轨）。 */
export function stripSoundSections(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      skipping = /^##\s+.*(?:\b(?:sound|audio|music)\b|声音|配乐|音效)/i.test(line);
    }
    if (!skipping) out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * v6/v7 整片风格段：把默认风格的 STYLE.md 核心内容直接内联进跨镜头静态前缀（同项目所有镜头共享一份前缀缓存），
 * 减少每镜 1–2 轮 read(SKILL.md) + read(STYLE.md)；v7 去掉声音段并放宽上限，同时明确禁止通读 DEMO.md / demo/ / SKILL.md 全文。
 */
export function filmStyleBriefSection(skillsDir: string, hasLook: boolean, v7 = false): string {
  const dir = filmStyleDir(skillsDir);
  if (dir === '') return filmStyleSection(skillsDir, hasLook);
  let palette = '配色按下列 STYLE.md 规范为本镜头选定';
  if (hasLook) palette = '配色遵守下文「全片配色」（在 STYLE.md 的配色逻辑里只用这几种颜色）';
  let inline = '';
  let truncated = false;
  try {
    const raw = fs.readFileSync(path.join(dir, filmstyle.StyleFile), 'utf8').trim();
    if (raw !== '') {
      const prepared = v7 ? stripSoundSections(raw) : raw;
      const limit = v7 ? styleInlineLimitV7 : styleInlineLimit;
      truncated = prepared.length > limit;
      const clipped = truncated
        ? prepared.slice(0, limit).trimEnd() + '\n…（后文已省略，需查细节时按需读取 STYLE.md）'
        : prepared;
      inline = `\n<onset-film-style-brief>\n${clipped}\n</onset-film-style-brief>\n`;
    }
  } catch {
    // 读不到时退回按目录读取。
  }
  if (v7) {
    const fullInline = inline !== '' && !truncated;
    const styleLead = fullInline
      ? `- 下方已内联该风格 ${filmstyle.StyleFile} 的完整视觉规范（已略去与无音轨镜头无关的声音条款），直接按此设计实现；${palette}。\n` +
        `- 禁止通读该目录的 ${filmstyle.GuideFile}、${filmstyle.StyleFile}、DEMO.md 或 demo/ 源码全文（共享的 core/ 已链接到本镜头目录，直接引用）；只有确实需要复用某个特定引擎函数时，才按需定位读取对应片段并拷入本镜头目录。\n`
      : inline !== ''
        ? `- 下方已内联该风格 ${filmstyle.StyleFile} 的前段视觉规范（已略去声音条款，后文有截断）；${palette}。如需查阅被截断的视觉规范，可按需读取 ${filmstyle.StyleFile} 的剩余小节。\n` +
          `- 禁止通读该目录的 ${filmstyle.GuideFile}、DEMO.md 或 demo/ 源码全文（共享的 core/ 已链接到本镜头目录，直接引用）；只有确实需要复用某个特定引擎函数时，才按需定位读取对应片段并拷入本镜头目录。\n`
        : `- 未能预读 ${filmstyle.StyleFile}，请先按需读取该目录的 ${filmstyle.StyleFile}（跳过声音条款）；${palette}。禁止通读 DEMO.md 或 demo/ 源码全文。\n`;
    return (
      '\n整片风格（强制）：本片所有镜头画成同一种风格，本机该技能目录为：\n    ' +
      dir +
      '\n' +
      styleLead +
      '- 画什么只取本镜头的说明、字幕与素材，不照搬风格自带示例的文案与故事；不得引用镜头目录之外的路径；声音与配乐条款无效（产物静音无音轨）。\n' +
      inline
    );
  }
  return (
    '\n整片风格（强制）：本片所有镜头画成同一种风格，本机该技能目录为：\n    ' +
    dir +
    '\n' +
    '- 下方已内联该风格 STYLE.md 核心规范，可直接按此设计实现；仅在需要风格专用引擎或示例技法时，按需查阅该目录的 ' +
    filmstyle.GuideFile +
    ' 或完整 ' +
    filmstyle.StyleFile +
    '。' +
    palette +
    '。\n' +
    '- 画什么只取本镜头的说明、字幕与素材，不照搬风格自带示例的文案与故事；不得引用镜头目录之外的路径；声音与配乐条款无效（产物静音无音轨）。\n' +
    inline
  );
}
