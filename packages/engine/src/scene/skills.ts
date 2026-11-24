// 移植自 internal/scene/skills.go。
//
// 渲染工具各自把技能装在不同目录，提示词里不得写死任何一条路径。
// 这里解析出本机真实位置，解析不到时由 buildPrompt 退回按技能名引用。
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '../filmstyle';
import * as flow from '../flow';
import { compareBytes } from '../gojson';
import { pluginSkills } from '../plugin/registry';
import {
  FilmStyleEnterKey,
  FilmStyleExitKey,
  FilmStyleOwnKey,
  HyperFramesCLISkillName,
  HyperFramesSkillName,
  hasSkill,
  hyperFramesFormatFile,
  hyperFramesMotionFile,
  hyperFramesRuntimesFile,
  isSymlink,
  PluginSkillPrefix,
  portableSkillsDir,
  projectCandidates,
  rendererSkillDirs,
  SceneKitSkillName,
  type SkillDescriptor,
  SkillManifestFile,
  SkillsDirEnv,
  SourceEmbedded,
  SourceUpstream,
  sceneKitLibraryFile,
} from './skills_constants';
import { resolveFilmStyle, resolveSceneFilmStyle, type SceneFilmInput } from './skills_filmstyle';
import { hyperFramesCLIPrompt, hyperFramesPrompt, sceneKitPrompt } from './skills_prompts';
import type { Handoff } from './timing_types';

export {
  FilmStyleEnterKey,
  FilmStyleExitKey,
  FilmStyleOwnKey,
  HyperFramesCLISkillName,
  HyperFramesSkillName,
  hyperFramesFormatFile,
  hyperFramesInputFiles,
  hyperFramesMotionFile,
  hyperFramesRuntimesFile,
  PluginSkillPrefix,
  rendererSkillDirs,
  SceneKitSkillName,
  type SkillDescriptor,
  SkillManifestFile,
  type SkillSource,
  SkillsDirEnv,
  SourceEmbedded,
  SourceUpstream,
  sceneKitLibraryFile,
} from './skills_constants';
export {
  filmStyleBriefSection,
  filmStyleSection,
  resolveFilmStyle,
  resolveSceneFilmStyle,
  type SceneFilmInput,
  sceneFilmStyleSection,
  stripSoundSections,
  styleShiftSection,
} from './skills_filmstyle';
export {
  hyperFramesCLIPrompt,
  hyperFramesCommand,
  hyperFramesPrompt,
  optionalSkillTail,
  sceneKitPrompt,
  skillPromptSections,
} from './skills_prompts';
export {
  QoderSkillsStage,
  rendererAccess,
  rendererStageDir,
  stagedSkills,
  stageRendererSkills,
  unstageRendererSkills,
} from './skills_stage';

/**
 * 宿主自己的渲染技能。功能插件的技能由插件在 apply 里登记（ctx.skill），见 allSkills。
 * 新增宿主技能只需在此追加一条，resolveAllSkills 和 buildPrompt 自动覆盖。
 */
export const registeredSkills: readonly SkillDescriptor[] = [
  {
    name: HyperFramesSkillName,
    source: SourceUpstream,
    requiredFiles: [SkillManifestFile, hyperFramesFormatFile, hyperFramesMotionFile, hyperFramesRuntimesFile],
    promptSection: hyperFramesPrompt,
  },
  {
    name: HyperFramesCLISkillName,
    source: SourceUpstream,
    requiredFiles: [SkillManifestFile],
    promptSection: hyperFramesCLIPrompt,
  },
  {
    name: SceneKitSkillName,
    source: SourceEmbedded,
    runtimeAssets: [sceneKitLibraryFile],
    // 库文件本身也是必需文件：只有 SKILL.md 的技能目录，提示词里那条
    // 「把库复制进镜头目录」的契约就无从执行。
    requiredFiles: [SkillManifestFile, sceneKitLibraryFile],
    promptSection: sceneKitPrompt,
  },
];

/** 宿主的技能加上全部内置插件登记的技能：技能树门禁按它查，每个镜头都带。 */
export function allSkills(): SkillDescriptor[] {
  return [...registeredSkills, ...pluginSkills().map((p) => p.value)];
}

/**
 * 把 .env 覆盖层里的 SkillsDirEnv 并入查找用的环境。
 * 优先级与 config.load 一致：真实环境变量 > .env；不修改传入的任何一个对象。
 */
export function skillsEnvironment(
  baseEnv: Record<string, string>,
  overlay: Record<string, string> | null,
): Record<string, string> {
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
export function resolveSkill(
  renderer: string,
  sceneDir: string,
  environ: Record<string, string>,
  desc: SkillDescriptor,
): string {
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
    if (process.platform === 'win32' && isSymlink(path.join(candidate, desc.name))) {
      try {
        const staged = JSON.parse(fs.readFileSync(path.join(candidate, '.onset-staged.json'), 'utf8'));
        // 渲染临时 junction 不是新的技能来源。残留链接不能改变原技能目录与输入指纹。
        if (Array.isArray(staged.linked) && staged.linked.includes(desc.name)) continue;
      } catch {
        /* 用户自行安装的技能仍按原优先级查找。 */
      }
    }
    if (hasSkill(candidate, desc.name, desc.requiredFiles)) return candidate;
  }
  return '';
}

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
  for (const key of keys) {
    out += `- ${key.slice(PluginSkillPrefix.length)}：动手前读 ${path.join(resolved[key], 'SKILL.md')}，按它的说明用。\n`;
  }
  return out;
}

/** 内置与默认风格的解析值是技能根；插件与点名风格直接给出技能目录。 */
export function skillInputPath(name: string, dir: string): string {
  return name.startsWith(PluginSkillPrefix) || name.startsWith('film-style:') ? dir : path.join(dir, name);
}
