// 技能目录常量、技能描述符类型、渲染工具技能路径表与基础路径探测工具。
import fs from 'node:fs';
import path from 'node:path';

/** 逃生阀：显式指定技能目录，优先级高于一切自动探测。 */
export const SkillsDirEnv = 'HYPERFRAMES_SKILLS_DIR';

const skillManifestFile = 'SKILL.md';
/** 技能的必需文件 SKILL.md（插件登记技能时 requiredFiles 至少写它）。 */
export const SkillManifestFile = skillManifestFile;

/** 不绑定具体工具的通用约定，作为兜底候选。 */
export const portableSkillsDir = '.agents/skills';

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
const hyperFramesLookFile = path.join('references', 'look.md');

/** 上游入口技能还含整片制作流程，镜头只看这几份。其余技能可自由引用目录内的文件。 */
export const hyperFramesInputFiles = [
  skillManifestFile,
  hyperFramesFormatFile,
  hyperFramesMotionFile,
  hyperFramesRuntimesFile,
  hyperFramesLookFile,
];

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
  /** 技能只用于某类镜头时，声明它何时参与渲染输入摘要。 */
  renderInput?: (scene: import('./scene').Scene) => boolean;
  /**
   * 该技能注入镜头提示词的片段（skillPromptSections 按登记顺序拼进每个镜头的提示词）。
   * skillsDir 为空时应退回按技能名引用，不写死本机路径。不写的技能只解析目录，提示词由别处
   * （例如插件的镜头扩展块）按需引用。
   */
  promptSection?: (skillsDir: string) => string;
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
  ['qoder-intl', { home: '.qoder/skills', project: '.qoder/skills' }],
  ['codebuddy', { home: '.codebuddy/skills', project: '.codebuddy/skills' }],
  ['opencode', { home: '.config/opencode/skills', project: '.opencode/skills' }],
  // mcode 0.6.12 实测：项目里认 .agents/skills、.minimax/skills、.claude/skills，并一直往上找到 git 根；家目录是数据目录 ~/.minimax/skills。
  ['mcode', { home: '.minimax/skills', project: '.minimax/skills' }],
  // Antigravity CLI（agy）认项目级 .agents/skills 与 .agent/skills，家目录技能在 ~/.gemini/skills；链进 .agent/skills 避开镜头目录里的 .agents/mcp_config.json。
  ['agy', { home: '.gemini/skills', project: '.agent/skills' }],
]);

/**
 * 镜头点名的整片风格（scene.json 的 film_style 写了「来源/目录名」）在 resolved 里的键。
 * 不写 film_style 的镜头用默认风格，仍记在 filmstyle.SkillName 下（值是 .agents/skills），
 * 与只有一种风格时逐字相同，老镜头的指纹不变。
 */
export const FilmStyleOwnKey = 'film-style:own';
/** 风格交界另一侧镜头的风格：入场（上一镜头）与出场（下一镜头）。 */
export const FilmStyleEnterKey = 'film-style:enter';
export const FilmStyleExitKey = 'film-style:exit';

/** 第三方插件技能在 resolveAllSkills 结果里的键前缀。 */
export const PluginSkillPrefix = 'plugin:';

/** 校验候选目录里确实装了指定技能，并且必需文件全部存在。 */
export function hasSkill(dir: string, skillName: string, requiredFiles: readonly string[]): boolean {
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
export function projectCandidates(sceneDir: string, relative: string): string[] {
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

export function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
