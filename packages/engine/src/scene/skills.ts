// 移植自 internal/scene/skills.go。
//
// 渲染工具各自把技能装在不同目录，提示词里不得写死任何一条路径。
// 这里解析出本机真实位置，解析不到时由 buildPrompt 退回按技能名引用。
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '../filmstyle';
import * as flow from '../flow';
import { compareBytes } from '../gojson';
import * as hyperframes from '../hyperframes';
import { pluginSkills } from '../plugin/registry';
import type { RendererAccess } from '../tools';
import { SceneDataFile } from './scenedata';
import { styleShiftOf, type Handoff, type Timing } from './timing';

/** 逃生阀：显式指定技能目录，优先级高于一切自动探测。 */
export const SkillsDirEnv = 'HYPERFRAMES_SKILLS_DIR';

const skillManifestFile = 'SKILL.md';
/** 技能的必需文件 SKILL.md（插件登记技能时 requiredFiles 至少写它）。 */
export const SkillManifestFile = skillManifestFile;

/** 不绑定具体工具的通用约定，作为兜底候选。 */
const portableSkillsDir = '.agents/skills';

/** 限制向上查找项目级技能目录的层数，避免病态路径下空转。 */
const maxWalkUpLevels = 40;

/**
 * 上游入口技能的目录名，承载组合契约与动效手法。
 *
 * 0.8.185 之前这两部分分属 hyperframes-core 与 hyperframes-animation，入口技能
 * 只负责「选择并安装 owning workflow」，所以当时刻意不注册它；上游合并之后它成了
 * 唯一的契约来源，只能注册并在提示词里收窄范围，见 hyperFramesPrompt。
 */
export const HyperFramesSkillName = 'hyperframes';

// 入口技能里渲染器必须读的参考文件，同时是判定「完整安装」的必需文件：
// 只有 SKILL.md 的目录说明上游又挪了结构，提示词里点名的文件全都不存在。
export const hyperFramesFormatFile = path.join('references', 'format.md');
export const hyperFramesMotionFile = path.join('references', 'motion.md');
export const hyperFramesRuntimesFile = path.join('references', 'runtimes.md');

/** HyperFrames CLI 用法技能目录名。 */
export const HyperFramesCLISkillName = 'hyperframes-cli';

/** 按帧驱动工具库（缓动、安全区、字幕）技能目录名。 */
export const SceneKitSkillName = 'scene-kit';

/** scene-kit 技能里的库文件名。它同时出现在 requiredFiles 与提示词的复制契约里，所以取一个常量。 */
export const sceneKitLibraryFile = 'scene-kit.js';

/**
 * SkillSource 说明技能是怎么进到用户项目里的。
 *
 * 这不是元数据而是契约：两类技能的缺失补救方式、升级方式和守护测试都不同。
 * 过去只有动效技能一个例外，靠在测试里按名字特判绕过；再加第二个上游技能时
 * 那种写法就会崩，所以把来源直接写进描述符。
 */
export type SkillSource = 0 | 1;

/**
 * 随 onset 下发，由 project.initialize 写进项目。
 * 这类技能必须存在于 assets/shared/.agents/skills/ 里。
 */
export const SourceEmbedded: SkillSource = 0;
/**
 * 由 onset init 按固定版本从上游安装进项目。
 * 这类技能不得进嵌入树——那会留下一份永远追不上上游的陈旧副本。
 */
export const SourceUpstream: SkillSource = 1;

/** 一个可自动发现的技能。 */
export interface SkillDescriptor {
  /** 技能目录内可共享的只读库文件，自动以同名路径放到镜头。 */
  runtimeAssets?: readonly string[];
  /** 技能目录名。 */
  name: string;
  /** 技能来自嵌入树还是上游安装。 */
  source: SkillSource;
  /**
   * 技能被视为「完整安装」所必须存在的文件列表。
   * 至少包含 SKILL.md；入口技能额外要求提示词里点名的参考文件。
   */
  requiredFiles: string[];
  /**
   * 该技能注入镜头提示词的片段（skillPromptSections 按登记顺序拼进每个镜头的提示词）。
   * skillsDir 为空时应退回按技能名引用，不写死本机路径。不写的技能只解析目录，提示词由别处
   * （例如插件的镜头扩展块）按需引用。
   */
  promptSection?: (skillsDir: string) => string;
}

/**
 * 宿主自己的渲染技能。功能插件的技能由插件在 apply 里登记（ctx.skill），见 allSkills。
 * 新增宿主技能只需在此追加一条，resolveAllSkills 和 buildPrompt 自动覆盖。
 */
export const registeredSkills: readonly SkillDescriptor[] = [
  {
    name: HyperFramesSkillName,
    source: SourceUpstream,
    requiredFiles: [skillManifestFile, hyperFramesFormatFile, hyperFramesMotionFile, hyperFramesRuntimesFile],
    promptSection: hyperFramesPrompt,
  },
  { name: HyperFramesCLISkillName, source: SourceUpstream, requiredFiles: [skillManifestFile], promptSection: hyperFramesCLIPrompt },
  {
    name: SceneKitSkillName,
    source: SourceEmbedded,
    runtimeAssets: [sceneKitLibraryFile],
    // 库文件本身也是必需文件：只有 SKILL.md 的技能目录，提示词里那条
    // 「把库复制进镜头目录」的契约就无从执行。
    requiredFiles: [skillManifestFile, sceneKitLibraryFile],
    promptSection: sceneKitPrompt,
  },
];

/** 宿主的技能加上全部内置插件登记的技能：技能树门禁按它查，每个镜头都带。 */
export function allSkills(): SkillDescriptor[] {
  return [...registeredSkills, ...pluginSkills().map((p) => p.value)];
}

/** 一个渲染工具的技能目录：家目录级与项目级的相对路径可能不同。 */
interface SkillLocations {
  home: string;
  project: string;
}

export const rendererSkillDirs: ReadonlyMap<string, SkillLocations> = new Map([
  ['claude', { home: '.claude/skills', project: '.claude/skills' }],
  ['codex', { home: '.codex/skills', project: '.codex/skills' }],
  ['qoder', { home: '.qoder/skills', project: '.qoder/skills' }],
  ['codebuddy', { home: '.codebuddy/skills', project: '.codebuddy/skills' }],
  ['opencode', { home: '.config/opencode/skills', project: '.opencode/skills' }],
]);

/** 校验候选目录里确实装了指定技能，并且必需文件全部存在。 */
function hasSkill(dir: string, skillName: string, requiredFiles: readonly string[]): boolean {
  if (dir === '') return false;
  const skill = path.join(dir, skillName);
  for (const name of requiredFiles) {
    try {
      if (!fs.statSync(path.join(skill, name)).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 从镜头目录逐级向上，收集每一层的项目级技能目录候选。
 * 项目级安装会覆盖全局安装，因此必须先于家目录被检查。
 */
function projectCandidates(sceneDir: string, relative: string): string[] {
  let current = path.resolve(sceneDir);
  const out: string[] = [];
  for (let level = 0; level < maxWalkUpLevels; level++) {
    out.push(path.join(current, relative));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/**
 * 把 .env 覆盖层里的 SkillsDirEnv 并入查找用的环境。
 * 优先级与 config.load 一致：真实环境变量 > .env；不修改传入的任何一个对象。
 */
export function skillsEnvironment(baseEnv: Record<string, string>, overlay: Record<string, string> | null): Record<string, string> {
  if (baseEnv[SkillsDirEnv] || !overlay?.[SkillsDirEnv]) return baseEnv;
  return { ...baseEnv, [SkillsDirEnv]: overlay[SkillsDirEnv] };
}

/**
 * 在渲染器的技能目录树中查找指定技能。
 *
 * 查找顺序：SkillsDirEnv → 渲染器专属目录（项目级自镜头目录逐级向上，再家目录级）
 * → 通用 .agents/skills（同样先项目级再家目录级）。
 * 未找到时返回空字符串且不报错，由调用方降级为按技能名引用；
 * 只有 SkillsDirEnv 被显式设置却指向无效目录时才报错——配置写错了必须响。
 */
export function resolveSkill(renderer: string, sceneDir: string, environ: Record<string, string>, desc: SkillDescriptor): string {
  const explicit = environ[SkillsDirEnv] ?? '';
  if (explicit !== '') {
    const absolute = path.resolve(explicit);
    if (!hasSkill(absolute, desc.name, desc.requiredFiles)) {
      throw new Error(`${SkillsDirEnv} 指向的目录缺少 ${desc.name}/${desc.requiredFiles[0]}：${absolute}`);
    }
    return absolute;
  }

  const home = environ.HOME ?? '';
  const homeCandidate = (relative: string): string => (home === '' ? '' : path.join(home, relative));

  // 先把渲染器专属目录找完再考虑通用目录，否则项目根位于 $HOME 之下时，
  // 向上遍历会在 $HOME 那一层先命中 .agents/skills，抢在专属目录前面。
  const ordered: string[] = [];
  const locations = rendererSkillDirs.get(renderer);
  if (locations) {
    ordered.push(...projectCandidates(sceneDir, locations.project));
    ordered.push(homeCandidate(locations.home));
  }
  ordered.push(...projectCandidates(sceneDir, portableSkillsDir));
  ordered.push(homeCandidate(portableSkillsDir));

  for (const candidate of ordered) {
    if (hasSkill(candidate, desc.name, desc.requiredFiles)) return candidate;
  }
  return '';
}

/** resolveAllSkills 要的镜头字段：本镜头的整片风格与交接约定。 */
export interface SceneFilmInput {
  film_style: string;
  timing: Pick<Timing, 'enter' | 'exit'> | null;
  /** 点名的第三方插件技能（scene.json 的 plugin_skills）。 */
  plugin_skills?: string[];
}

/**
 * 镜头点名的整片风格（scene.json 的 film_style 写了「来源/目录名」）在 resolved 里的键。
 * 不写 film_style 的镜头用默认风格，仍记在 filmstyle.SkillName 下（值是 .agents/skills），
 * 与只有一种风格时逐字相同，老镜头的指纹不变。
 */
export const FilmStyleOwnKey = 'film-style:own';
/** 风格交界另一侧镜头的风格：入场（上一镜头）与出场（下一镜头）。 */
export const FilmStyleEnterKey = 'film-style:enter';
export const FilmStyleExitKey = 'film-style:exit';

/**
 * 解析所有注册技能，返回 name → 绝对路径的映射（Go 的 map[string]string）。
 * 未找到的技能不出现在结果中（不是报错）。film 给出时还解析本镜头点名的整片风格与
 * 风格交界另一侧的风格；点名的风格没装进项目时报错——那是项目配置错了，降级成
 * 「不用风格」会一路静默到成片。
 */
export function resolveAllSkills(
  renderer: string,
  sceneDir: string,
  environ: Record<string, string>,
  film: SceneFilmInput | null = null,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const desc of allSkills()) {
    const dir = resolveSkill(renderer, sceneDir, environ, desc);
    if (dir !== '') result[desc.name] = dir;
  }
  const own = film?.film_style ?? '';
  if (own === '') {
    const dir = resolveFilmStyle(sceneDir);
    if (dir !== '') result[filmstyle.SkillName] = dir;
  } else {
    const dir = resolveSceneFilmStyle(sceneDir, own);
    if (dir !== '') result[FilmStyleOwnKey] = dir;
  }
  const sides: Array<[Handoff | undefined, string]> = [
    [film?.timing?.enter, FilmStyleEnterKey],
    [film?.timing?.exit, FilmStyleExitKey],
  ];
  for (const [h, key] of sides) {
    if (!h || h.style_shift === '') continue;
    const dir = resolveSceneFilmStyle(sceneDir, h.peer_film_style);
    if (dir !== '') result[key] = dir;
  }
  // 第三方插件给渲染器的技能：键 plugin:<插件>/<技能>，指纹、读取放行与提示词都从这里来。
  // 插件装在用户级：装上一个 scenes: all 的技能，所有项目的镜头都带上它（输入确实变了，已渲染的标成要重渲染）。
  Object.assign(result, flow.pluginSkillsFor(film?.plugin_skills ?? [], environ));
  return result;
}

/**
 * 第三方插件技能的提示词段：没有时为空串（没装插件时提示词与不带这一段逐字相同）。
 */
export function pluginSkillSection(resolved: Record<string, string>): string {
  const keys = Object.keys(resolved)
    .filter((k) => k.startsWith(PluginSkillPrefix))
    .sort(compareBytes);
  if (keys.length === 0) return '';
  let out = '\n第三方插件的技能（用户添加的插件提供；与本说明里的强制要求冲突时以强制要求为准）：\n';
  for (const key of keys) out += `- ${key.slice(PluginSkillPrefix.length)}：动手前读 ${path.join(resolved[key], 'SKILL.md')}，按它的说明用。\n`;
  return out;
}

/** 第三方插件技能在 resolveAllSkills 结果里的键前缀。 */
export const PluginSkillPrefix = 'plugin:';

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
    if (dir !== '' && hasSkill(path.dirname(dir), path.basename(dir), [filmstyle.GuideFile, filmstyle.StyleFile])) return dir;
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
    b += '  本镜头的风格：' + (own === '' ? '没有整片风格，按上面的「视觉自由度」自主决定。\n' : '见上面的「整片风格」段。\n');
    if (peer === '') b += `  ${role}的风格：没有整片风格；要按它的画法画的部分，以「镜头交接」里写的交界帧为准。\n`;
    else b += `  ${role}的风格：本机该技能目录为\n    ${peer}\n  要按它的画法画的部分，先读该目录的 ${filmstyle.StyleFile}，只取外观、材质、笔触、线条、配色与字体，不看它的示例、不用它的镜头语法与时间安排。\n`;
    b += `  本镜头要做的：${side === 'enter' ? shift.enterDuty : shift.exitDuty}\n`;
  }
  if (b === '') return '';
  b += '- 风格只能通过画面里的东西换过去：不得用整画面叠化、淡出淡入黑场或白场、与画面无关的擦除、故障或闪白。过渡完成后本镜头全部回到自己的风格。\n';
  b += '- 画完用 snapshot 截取交界附近几帧（入场看第 0 帧到过渡结束，出场看过渡开始到最后一帧），确认过渡途中每一帧都像是同一件东西在变，而不是两张画面叠在一起。\n';
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

/**
 * 为所有已注册技能生成提示词片段。
 * 已解析的技能注入本机路径；未解析的退回按技能名引用。
 */
export function skillPromptSections(resolved: Record<string, string>, skills: readonly SkillDescriptor[]): string {
  let sections = '';
  for (const desc of skills) {
    if (desc.promptSection) sections += desc.promptSection(resolved[desc.name] ?? '');
  }
  return sections;
}

/**
 * 渲染器调用 CLI 的写法（onset 管理的固定版本 CLI，见 hyperframes.requireCLI，由 onset setup 装好）。
 * 提示词里教的写法与安全模式放行的命令必须是同一个字符串：
 * 以前只有放行列表里有前缀，提示词不提，渲染器写成不带版本的 `npx hyperframes`，
 * 整场渲染的 lint、check、render 全被拦下（实测，无产物）。
 */
export function hyperFramesCommand(): string {
  return hyperframes.CLICommand;
}

/**
 * 上游入口技能的提示词片段：组合契约加动效手法。
 *
 * 0.8.185 起上游把 hyperframes-animation / hyperframes-core / hyperframes-creative
 * 并进了入口技能 hyperframes，原子 rule 索引（rules-index.md）与蓝图索引随之消失，
 * 组合契约落在 SKILL.md 的 Contract 一节与 references/format.md，动效手法落在
 * references/motion.md。所以这里只点名那几份文件，而不是让渲染器「加载技能」。
 *
 * 收窄范围是这一段的主要工作。入口技能的职责是整片制作：故事线三选一、SPEC.md、
 * 分镜、配乐音效、预览审批、桌面应用交接与 REVIEW.md。分镜、旁白和节拍由上层决定
 * 并已写进 scene.json，渲染器照那套走会产出计划文件、给镜头配乐（产物必须无音轨），
 * 还会停在「等人审批预览」。references/look.md 要求把项目根的 frame.md 当成配色与
 * 字体规范，与「视觉自由度」一段正面冲突，必须点名覆盖；format.md 允许用
 * local() 引用本机字体，换一台机器结果就不同，也要点名禁止。这些禁令上游不会替我们守，
 * skills.test.ts 有对应的门禁。
 *
 * 动效部分刻意不设数量配额（几种手法、几个属性）。配额是可以逐项打勾的指标，
 * 渲染器会为了达标加一个与文案无关的 rotation 或 clip-path；动效数量由文案决定，
 * 这里只要求每个动效说得出理由。环境动效不设项目级配额；只要不影响阅读和确定性，
 * 就由镜头根据文案决定，语义元素仍应在到位后稳定停留。
 */
export function hyperFramesPrompt(skillsDir: string): string {
  const files = `SKILL.md 的 Contract 一节、${hyperFramesFormatFile} 与 ${hyperFramesMotionFile}；用到 GSAP 以外的运行时（Lottie、Three.js、canvas 等）再读 ${hyperFramesRuntimesFile}`;
  let reference = `- 写组合 HTML 前必须读 ${HyperFramesSkillName} 技能的 ${files}。\n` + '  （本机未能定位该技能目录，请使用你自身的技能加载机制载入。）\n';
  if (skillsDir !== '') {
    reference = `- 写组合 HTML 前必须读 ${HyperFramesSkillName} 技能的 ${files}。本机该技能目录为：\n    ${path.join(skillsDir, HyperFramesSkillName)}\n`;
  }
  return (
    '组合规范（强制）：\n' +
    reference +
    '  重点是 data-* 时间属性、class="clip"、子组合结构与确定性渲染规则。\n' +
    '- 该技能是整片制作的入口，本镜头只取其中的组合契约与动效手法。本镜头只产出一个 composition：' +
    '不建子项目，不写 STORYBOARD.md / SCRIPT.md / SPEC.md / REVIEW.md 这类计划或复查文件，' +
    '不走它的 Work loop、故事线选择、预览审批与桌面应用交接——分镜、旁白与节拍已由上层决定并写进 scene.json，你只负责这一镜。\n' +
    '- 不读也不照做 references/story.md、spec.md、storyboard.md、storyboard-format.md、sound.md、captions.md、overlays.md、review.md 与 types/ 下的片型文件：' +
    '配乐与音效由上层统一处理，镜头里不放 <audio>；画内字幕按下方的镜头工具库执行；复查按本提示词的画面自查执行。\n' +
    '- 画幅、帧率与时长以本提示词为准，不用该技能默认的 1920×1080、30fps。' +
    '不搜索、不安装 registry 组件（catalog、add），不调用 media-use 或任何生成媒体的服务。\n' +
    '- 该技能 references/look.md 要求把项目根的 frame.md 当作配色与字体规范，本项目不适用：' +
    '配色与字体按本提示词的「视觉自由度」（有整片风格时是「整片风格」）一段执行；look.md 只读「Video facts」一节，不另立 LOOK 行，不套用 frame-presets。\n' +
    '- 非内置字体一律用 @font-face 指向镜头目录里的字体文件，不得只写 local() 依赖本机安装的字体：换一台机器渲染结果就不同。\n' +
    '\n动效要求（强制）：\n' +
    '- 动效手法以 ' +
    hyperFramesMotionFile +
    ' 为参考：缓动按角色选、快动作带动态模糊、退场短于入场、错峰重叠；' +
    '其中「Defaults that look generated」列出的写法一律不用。它给的停留秒数只是参考，可读停留以本提示词的其他要求为准。\n' +
    '- 导演的是状态变化，不只是入场：每个动画先想清楚它最终停在什么状态、那个状态是否说明了这句台词的论点；' +
    '入场再漂亮，也补不了落定状态说不清的问题。\n' +
    '- 跟随关系要成立：指针落在它要按的控件上，标签跟着它标注的对象走。\n' +
    '- 按文案选手法，不设数量下限：每个动效都要说得出它在表达哪句话、哪层关系或哪个转折，' +
    '说不出理由的不加。宁可少而准，不要为了显得丰富堆叠属性。\n' +
    '- 环境动效可选，整镜最多 1 条，振幅小到不干扰阅读；不得持续漂浮或晃动语义元素。\n' +
    '- 语义元素到位后应当稳定停留供阅读，这段停留允许画面静止；' +
    '镜头结尾停在可读的终态，不得停在入场中间态。\n' +
    '- 但整个画面不得完全冻结超过 3 秒（含结尾）：长停留期间用那条环境动效或极缓的镜头推移维持画面活性，' +
    '语义元素本身保持不动。\n' +
    '- 装饰性动效只能落在装饰层（显式标记 decorative）或语义元素的入场 / 退场窗口内，' +
    '不得侵占任何元素的可读稳定区间，也不得改变已约定的短语帧。\n'
  );
}

/**
 * 指向 CLI 用法，并把可用命令收窄到本地渲染与检查。
 *
 * 上游该技能按「工作」列出全部命令，其中三类必须挡掉：
 *   - cloud / cloudrun / lambda / publish 把镜头送去远端，绕开本机的确定性前提；
 *   - skills / upgrade 会顶掉 onset 固定的技能与 CLI 版本，影响同项目其他镜头；
 *   - preview / open / catch-up / history / feedback / usage 是交互、桌面应用、
 *     遥测与额度查询，无头单镜头渲染里要么卡住等人，要么往外发数据。
 *
 * timeline 只放行读取：它的 move / trim / split 等子命令会改写组合文件，
 * 与「时长由 scene.json 决定」的契约冲突。
 */
export function hyperFramesCLIPrompt(skillsDir: string): string {
  let reference = `- CLI 的命令与排错方式见 ${HyperFramesCLISkillName} 技能。\n` + '  （本机未能定位该技能目录，请使用你自身的技能加载机制载入。）\n';
  if (skillsDir !== '') {
    reference = `- CLI 的命令与排错方式见 ${HyperFramesCLISkillName} 技能。本机该技能目录为：\n    ${path.join(skillsDir, HyperFramesCLISkillName)}\n`;
  }
  return (
    '渲染命令（强制）：\n' +
    reference +
    '- HyperFrames CLI 只经 onset 工具服务里的 `hyperframes` 工具调用：`subcommand` 填子命令，其余参数照命令行写法放进 `args`。' +
    '例如检查是 `{"subcommand": "lint"}`、`{"subcommand": "check", "args": ["--json"]}`，渲染是 `{"subcommand": "render"}`。' +
    '技能里写成 `npx hyperframes <子命令>` 或 `hyperframes <子命令>` 的命令，一律照此换成工具调用。\n' +
    '- 不在 Bash 里跑 hyperframes、npx hyperframes 或 onset：它们不在本环境里，也不被放行。固定版本 ' +
    hyperframes.PinnedVersion +
    ' 的 CLI 已经装好，工具就在本镜头目录里执行，不需要 cd。\n' +
    '- 渲染要几分钟：工具最多等 `wait_seconds` 秒（缺省 50），没跑完会返回任务号，用 `job_wait` 接着等到完成；不要重复发起同一次渲染。\n' +
    '- 只放行本机渲染与检查：lint、check、validate、inspect、snapshot、keyframes、render、只读的 timeline --json、compositions、info、docs。' +
    'snapshot 会自动带上 --describe false（不把画面发给外部视觉服务），本镜头的自查由你自己看图完成。\n' +
    '- 远端渲染（cloud、cloudrun、lambda、publish）、改动已装技能（skills、upgrade）、交互与遥测（preview、present、open、catch-up、history、feedback、usage）都不放行：' +
    '本镜头必须在本机无头渲染，版本已固定，也没有人审批预览。\n'
  );
}

/**
 * 按帧驱动工具库的提示词片段，解析到就总是注入。
 *
 * 这个库存在的理由是让各镜头不再各写各的：字幕位置、字号、断行每镜不同，
 * frame.md 的字幕规范没有任何共用代码去执行。所以措辞必须把「烧录字幕一律
 * 用 SceneKit.captions」「版式用 safeRect 而不是手抄像素」写成要求而不是建议，
 * 否则渲染器照旧手写一套，库就白装了。
 *
 * 复制义务与 character-rig 同理：渲染只服务镜头目录内的文件，引用镜头目录外的
 * 路径会静默 404，字幕不出现、渲染照样退出码 0。
 */
export function sceneKitPrompt(skillsDir: string): string {
  let reference =
    `- 加载 ${SceneKitSkillName} 技能，用法以其中的 ${skillManifestFile} 为准。\n` + '  （本机未能定位该技能目录，请使用你自身的技能加载机制载入。）\n';
  if (skillsDir !== '') {
    reference = `- 加载 ${SceneKitSkillName} 技能，用法以其中的 ${skillManifestFile} 为准。本机该技能目录为：\n    ${path.join(skillsDir, SceneKitSkillName)}\n`;
  }
  return (
    '镜头工具库（强制）：\n' +
    reference +
    '- 用到它时把技能目录里的 ' +
    sceneKitLibraryFile +
    ' 复制进本镜头目录，用相对路径引入；不得引用镜头目录之外的文件。\n' +
    '- 先加载镜头目录里的 ' +
    SceneDataFile +
    '（由上层在渲染前写好，不要自己写或改），再加载 ' +
    sceneKitLibraryFile +
    '。\n' +
    '- 画面内烧录的字幕一律用 SceneKit.captions，不得手写字幕代码；位置、字号、断行与样式由本镜头决定，但必须保持可读。\n' +
    '- 版式按安全区取值用 SceneKit.safeRect，不要把安全区像素手抄进合成；短语时间窗用 SceneKit.phrase。\n'
  );
}

/**
 * 渲染器在安全模式下必须被放行的最小权限。
 *
 * 命令与提示词、镜头锁定文件要求的完全一致：CLI 必须带固定版本前缀，
 * ls / ffprobe 用来查素材与产物。技能树在项目根的 .agents/skills，位于镜头
 * 目录之外，不开放读取的话渲染器读不到组合契约与动效手法，只能凭空写动画。
 */
export function rendererAccess(resolved: Record<string, string> | null): RendererAccess {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of Object.values(resolved ?? {})) {
    if (dir !== '' && !seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }
  dirs.sort(compareBytes);
  // HyperFrames 经 onset 的工具服务调用（scene.run 挂上 toolsServer），不在 Bash 里跑 onset。
  return { commands: ['ls', 'ffprobe'], readDirs: dirs };
}

/**
 * 渲染器的原生技能：把这个镜头提示词里点名的技能，以符号链接放进镜头目录里那家渲染工具读项目技能的位置
 * （rendererSkillDirs 的 project：.claude/skills、.codex/skills、.qoder/skills、.codebuddy/skills、.opencode/skills），
 * 渲染器自己的 Skill 工具就能直接加载（比让它按路径一个个 Read 快）。用户级的技能由系统沙箱藏起来（sandbox.ts 的
 * rendererHome），qoder 另加 `--setting-sources project,local`；opencode 会一直往上找到项目根，另用 permission.skill
 * 只放行这几个（tools.rendererEnv）。
 *
 * 只链提示词里出现了目录的技能：与渲染器被告知要用的那几份一一对应，不多带（song-explainer 之类只在对应镜头里）。
 * 链接只在渲染期间存在：stageRendererSkills 返回的函数在渲染结束后删掉它们；上次没删干净的，
 * 下次解析技能之前先清掉（unstageRendererSkills），免得 resolveSkill 找到这些链接、技能路径跟着变。
 */
export const QoderSkillsStage = path.join('.qoder', 'skills');
const stageMarker = '.onset-staged.json';

/** 一个渲染工具在镜头目录里读项目技能的位置；不认识的工具为空。 */
export function rendererStageDir(renderer: string): string {
  return rendererSkillDirs.get(renderer)?.project ?? '';
}

/** 一个技能实际的目录：注册技能解析到的是技能根（.agents/skills），整片风格与插件技能就是技能目录本身。 */
function skillFolder(key: string, dir: string): string {
  const nested = path.join(dir, key);
  if (fs.existsSync(path.join(nested, 'SKILL.md'))) return nested;
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  return '';
}

/** 链接名：渲染工具按目录名认技能，film-style:own、plugin:站/技能 换成文件名能用的写法。 */
function stagedName(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 要链进镜头目录的技能：名字与真实目录，按提示词里出现了目录的挑。 */
export function stagedSkills(resolved: Record<string, string>, prompt: string): { name: string; folder: string }[] {
  const out: { name: string; folder: string }[] = [];
  // Windows 提示词同时有 /、\ 和 JSON 转义的路径；只规范比较值，链接仍指向原目录。
  const comparable = (text: string) => process.platform === 'win32' ? text.replace(/\\+/g, '/').toLowerCase() : text;
  const mentioned = comparable(prompt);
  for (const [key, dir] of Object.entries(resolved)) {
    const folder = skillFolder(key, dir);
    if (folder === '' || !mentioned.includes(comparable(folder))) continue;
    const name = stagedName(key);
    if (name === '' || out.some((s) => s.name === name)) continue;
    out.push({ name, folder });
  }
  return out;
}

export function stageRendererSkills(renderer: string, sceneDir: string, resolved: Record<string, string>, prompt: string): () => void {
  unstageRendererSkills(sceneDir);
  const rel = rendererStageDir(renderer);
  if (rel === '') return () => {};
  const stage = path.join(sceneDir, rel);
  const parent = path.dirname(stage);
  const createdParent = !fs.existsSync(parent);
  const createdStage = !fs.existsSync(stage);
  const linked: string[] = [];
  try {
    for (const { name, folder } of stagedSkills(resolved, prompt)) {
      const link = path.join(stage, name);
      // 用户自己放在这里的同名技能不动。
      if (fs.existsSync(link) || isSymlink(link)) continue;
      fs.mkdirSync(stage, { recursive: true });
      fs.symlinkSync(folder, link, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(name);
    }
  } finally {
    if (linked.length > 0 || createdStage || createdParent) {
      try {
        fs.mkdirSync(stage, { recursive: true });
        fs.writeFileSync(path.join(stage, stageMarker), JSON.stringify({ linked, createdStage, createdParent }) + '\n');
      } catch {
        // 写不下标记：照常渲染，结束时按 linked 清理。
      }
    }
  }
  return () => unstageRendererSkills(sceneDir);
}

/** 删掉 stageRendererSkills 放的链接（只删标记里记着、确实是符号链接的），以及它建出来、已经空了的目录。各家的位置都看一遍：上次可能换过渲染工具。 */
export function unstageRendererSkills(sceneDir: string): void {
  for (const rel of new Set([...rendererSkillDirs.values()].map((d) => d.project))) {
    const stage = path.join(sceneDir, rel);
    const marker = path.join(stage, stageMarker);
    let record: { linked?: unknown; createdStage?: unknown; createdParent?: unknown; createdQoder?: unknown };
    try {
      record = JSON.parse(fs.readFileSync(marker, 'utf8'));
    } catch {
      continue;
    }
    for (const name of Array.isArray(record.linked) ? record.linked : []) {
      if (typeof name !== 'string' || name.includes('/') || name.includes('\\')) continue;
      const link = path.join(stage, name);
      if (isSymlink(link)) fs.rmSync(link, { force: true });
    }
    fs.rmSync(marker, { force: true });
    const removeIfEmpty = (dir: string) => {
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // 不在或不空：留着。
      }
    };
    if (record.createdStage === true) removeIfEmpty(stage);
    if (record.createdParent === true || record.createdQoder === true) removeIfEmpty(path.dirname(stage));
  }
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
