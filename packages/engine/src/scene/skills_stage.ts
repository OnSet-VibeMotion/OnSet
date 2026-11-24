// 渲染器安全模式权限与镜头目录内的原生技能临时挂载/清理。
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import type { RendererAccess } from '../tools';
import { isSymlink, rendererSkillDirs } from './skills_constants';

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
  const comparable = (text: string) => (process.platform === 'win32' ? text.replace(/\\+/g, '/').toLowerCase() : text);
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

export function stageRendererSkills(
  renderer: string,
  sceneDir: string,
  resolved: Record<string, string>,
  prompt: string,
): () => void {
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
      if (isSymlink(link)) {
        // Windows junction 是目录重解析点；rm(非 recursive) 会报 EISDIR。
        // rmdir 只移除已经由 lstat 确认的链接本身，不遍历或删除技能目标。
        if (process.platform === 'win32') fs.rmdirSync(link);
        else fs.rmSync(link, { force: true });
      }
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
