//
// 把上游官方技能按固定 commit 装进用户项目。
//
// 不调用上游的 `hyperframes skills`，有两个各自独立的理由。
//
// 一、它只认 homedir()：把技能写进 ~/.claude/skills 与 ~/.agents/skills，再
// 镜像到本机其余几十个 agent 目录。没有任何命令行选项或环境变量能改这个落点
// （`skills update --dir` 的帮助原文就写着 "scopes the prune, not the install"）。
// 装在机器级有三个后果，第三个是硬伤：
//
//   - 项目不自包含。整个项目拷到另一台机器就渲不出来，技能不在里面。
//   - 污染用户 HOME，一次安装会写进本机所有已安装 agent 的目录。
//   - 项目之间互相覆盖。下发的 PROMPT 要求「固定 HyperFrames 版本为 X」，
//     可机器上只有一份技能：两个项目固定不同版本时谁后初始化谁说了算，
//     另一个项目的固定版本悄悄失效。
//
// 二、它给不了可复现性。它 git clone 仓库的**默认分支**再取技能，没有任何
// 指定 tag 或 commit 的口子。实测同机分别用 hyperframes@0.8.1 与 @0.8.14
// 安装，产出的 26 个技能逐字节相同、都等于当天 main 的状态——npm 版本号固定
// 的只是 CLI 二进制，而技能内容直接决定成片动效。
//
// 所以这里自己按 tag v<Version> 浅克隆上游仓库，从 skills/ 与 .agents/skills/
// 两处取出含 SKILL.md 的目录搬进项目的 .agents/skills/。实测这套筛选在同一个
// commit 上与上游安装器的产出逐字节相同。确定性由 cloneSkills 的三个环境开关
// 与 PinnedSkillsCommit / PinnedSkillsCount 两道校验保证。
//
// scene.ResolveSkill 本来就优先项目级候选，搬进去即可被优先命中，不需要改
// 解析逻辑。安装只依赖 git，不再依赖 Node/npx。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { missing } from '../prereq';
import { cachedTree, copySkills, pathExists, type Result, storeCache } from './cache';
import {
  PinnedSkillsCommit,
  PinnedSkillsCount,
  PinnedVersion,
  SkillsRepoURL,
  SkillsSubdir,
  skillsSubdirsInRepo,
} from './constants';
import { fetchSkills } from './fetch';
import { writeManifest } from './manifest';
import { checkoutStart, copyStart, type Progress, type Writer } from './progress';
import { errorText, goList } from './util';

export {
  cachedTree,
  cacheMarker,
  copySkills,
  copyTree,
  defaultCacheDir,
  type Result,
  skillsReady,
  storeCache,
} from './cache';
export { cloneEnv } from './fetch';

/** 一次安装。 */
export interface Options {
  /** 用户项目根目录。 */
  projectDir?: string;
  /** 要安装的上游版本，例如 "0.8.225"。技能按 tag v<version> 克隆。 */
  version?: string;
  /** 技能来源仓库，留空取 SkillsRepoURL。测试用它指向本地夹具仓库。 */
  repoURL?: string;
  /**
   * tag 必须解析到的 commit，留空取 PinnedSkillsCommit。
   * 显式传入 "-" 表示跳过校验（只在无法预知 commit 的夹具场景下使用）。
   */
  expectCommit?: string;
  /** 期望拼装出的技能数，留空（0）取 PinnedSkillsCount。 */
  expectSkills?: number;
  /**
   * 当前进程环境。安装器要在改写过 HOME 的副本里运行，
   * 但 PATH、代理、npm 配置这些必须沿用，否则公司内网装不上。
   */
  env?: Record<string, string>;
  /** 不允许被上游同名技能覆盖的技能，即随二进制下发的那些。 */
  protectedSkills?: ReadonlySet<string>;
  /** 接收安装器的进度输出。 */
  output?: Writer;
  /**
   * 非空时汇报整体进度：克隆时让 git 输出 --progress 并解析百分比，
   * 检出时报告不确定进度，拷贝时按技能逐个计数。
   */
  progress?: (p: Progress) => void;
  /**
   * 本机缓存的根目录（见 defaultCacheDir），留空不用缓存。
   * 缓存按 commit 分目录存放校验过的技能树，同一台机器上第二个项目起不再联网。
   */
  cacheDir?: string;
  /**
   * 为 true 时只从缓存拷贝，缓存里没有就抛 prereq.MissingError，不联网。
   * onset init 与 Studio 新建项目都这样装：技能是前置资源，由 onset setup 下载（见 prepareSkills）。
   */
  cacheOnly?: boolean;
}

/** 补齐默认值之后的选项。 */
interface Resolved extends Options {
  version: string;
  repoURL: string;
  expectCommit: string;
  expectSkills: number;
  env: Record<string, string>;
}

function resolve(opts: Options, defaultVersion: string): Resolved {
  return {
    ...opts,
    version: opts.version || defaultVersion,
    repoURL: opts.repoURL || SkillsRepoURL,
    expectCommit: opts.expectCommit || PinnedSkillsCommit,
    expectSkills: opts.expectSkills || PinnedSkillsCount,
    env: opts.env ?? {},
  };
}

/**
 * 把固定版本的技能树下载进本机缓存（onset setup 用）。已有就不动。
 * 与 install 走同一套克隆与校验，只是不往项目里拷。
 */
export async function prepareSkills(options: Options, signal?: AbortSignal): Promise<void> {
  const opts = resolve(options, PinnedVersion);
  if (!opts.cacheDir) throw new Error('无法确定 HyperFrames 技能的缓存目录：环境里没有 HOME');
  if (cachedTree(opts.cacheDir, opts.expectCommit, opts.expectSkills) !== '') return;
  const report = opts.progress ?? (() => {});
  const tmp = makeTemp();
  try {
    report({ stage: '连接上游仓库', percent: 0 });
    const commit = await fetchSkills(tmp, opts, report, signal);
    report({ stage: '存进本机缓存', percent: copyStart });
    try {
      storeCache(opts.cacheDir, commit, tmp);
    } catch (err) {
      throw new Error(`存进本机缓存：${errorText(err)}`, { cause: err });
    }
    if (cachedTree(opts.cacheDir, opts.expectCommit, opts.expectSkills) === '') {
      fs.rmSync(path.join(opts.cacheDir, commit), { recursive: true, force: true });
      throw new Error(
        `上游 ${commit} 拼装出的技能数不是 ${opts.expectSkills}：技能目录结构可能已变，核对 ${goList(skillsSubdirsInRepo)} 两处后同步 PinnedSkillsCount`,
      );
    }
    report({ stage: '完成', percent: 100 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function makeTemp(): string {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'onset-hyperframes-'));
  } catch (err) {
    throw new Error(`无法创建临时目录：${errorText(err)}`, { cause: err });
  }
}

/**
 * 把固定版本的上游技能装进 opts.projectDir 下的 .agents/skills/。
 *
 * 全程不碰用户 HOME：安装器在一个临时目录里以为自己在写 home，结束后整棵树
 * 被搬进项目，临时目录删除。
 */
export async function install(options: Options, signal?: AbortSignal): Promise<Result> {
  if (!options.version) throw new Error('必须指定 HyperFrames 版本');
  const opts = resolve(options, options.version);
  const report = opts.progress ?? (() => {});
  let tmp: string;
  let commit: string;
  let cleanup: string | undefined;
  const cached = cachedTree(opts.cacheDir, opts.expectCommit, opts.expectSkills);
  if (cached !== '') {
    // 缓存里是同一个 commit 上校验过的技能树，与重新克隆逐字节相同，不联网。
    tmp = cached;
    commit = opts.expectCommit;
    report({ stage: '从本机缓存读取', percent: checkoutStart });
  } else if (opts.cacheOnly) {
    throw missing('HyperFrames ' + opts.version + ' 技能', '本机缓存里没有');
  } else {
    // 克隆目录必须在项目之外：放项目里会把 .git 和中间产物留在交付目录，
    // 而且 onset archive 会连它们一起归档。
    tmp = makeTemp();
    cleanup = tmp;
  }
  try {
    if (cleanup) {
      report({ stage: '连接上游仓库', percent: 0 });
      commit = await fetchSkills(tmp, opts, report, signal);
      // 克隆已经过 commit 校验；技能数在下面拼装时再校验，不合格的不会被后续读到
      // （cachedTree 按技能数判可用）。缓存写不进去只是下次还要联网，照常继续。
      try {
        storeCache(opts.cacheDir, commit, tmp);
      } catch (err) {
        opts.output?.write(`警告：HyperFrames 技能没能存进本机缓存（${errorText(err)}），下次安装仍会联网\n`);
      }
    }
    const sources: string[] = [];
    for (const sub of skillsSubdirsInRepo) {
      const p = path.join(tmp, sub);
      if (pathExists(p)) sources.push(p);
    }
    if (sources.length === 0) {
      throw new Error(
        `上游仓库 ${opts.repoURL} 在 ${commit!} 上没有 ${goList(skillsSubdirsInRepo)} 中的任何一处，技能目录结构已变`,
      );
    }
    report({ stage: '拷进项目', percent: copyStart });
    const result = copySkills(sources, path.join(opts.projectDir ?? '', SkillsSubdir), opts.protectedSkills, (done) => {
      report({ stage: '拷进项目', percent: copyStart + (5 * done) / Math.max(opts.expectSkills, done) });
    });
    const total = result.installed.length + result.protected.length;
    if (total !== opts.expectSkills) {
      throw new Error(
        `上游 ${commit!} 拼装出 ${total} 个技能，期望 ${opts.expectSkills} 个：技能目录结构可能已变，` +
          `核对 ${goList(skillsSubdirsInRepo)} 两处后同步 PinnedSkillsCount`,
      );
    }
    // 记录这次到底装到了哪一份技能：commit 加每个技能目录的内容摘要。
    // 版本号本身不足以还原——上游安装器不认 ref，这份记录才是可复现的凭据。
    writeManifest(opts.projectDir ?? '', opts.version, commit!, result.installed);
    report({ stage: '完成', percent: 100 });
    return result;
  } finally {
    if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
  }
}
