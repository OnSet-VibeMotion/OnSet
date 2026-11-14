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
import { compareBytes } from '../gojson';
import { missing } from '../prereq';
import { MissingToolPrefix, dataDir } from '../envutil';
import { gitHint, usableGit } from '../toolpath';
import { downloadTree, githubRepo } from './download';
import { PinnedSkillsCommit, PinnedSkillsCount, PinnedVersion, SkillsRepoURL, SkillsSubdir, manifestFile, skillsSubdirsInRepo } from './constants';
import { writeManifest } from './manifest';
import { GitProgress, checkoutStart, copyStart, type Progress, type Writer } from './progress';
import { errorText, goList, runCommand } from './util';

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
 * 用户级缓存根目录：<数据目录>/hyperframes（envutil.dataDir：XDG_DATA_HOME、Windows 的 LOCALAPPDATA 或 HOME）。
 * 都没有时返回空串（不用缓存），不去猜家目录。
 */
export function defaultCacheDir(env: Record<string, string | undefined>): string {
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'hyperframes');
}

/** 本机缓存里已有校验过的固定版本技能树。 */
export function skillsReady(cacheDir: string): boolean {
  return cachedTree(cacheDir, PinnedSkillsCommit, PinnedSkillsCount) !== '';
}

function exists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
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

/** 写在缓存目录里，内容是 commit：只有完整搬进去、校验过的技能树才有它。 */
export const cacheMarker = '.onset-commit';

/**
 * 返回 commit 的缓存目录；没有可用缓存时返回空串。
 *
 * 可用的标准与刚克隆下来的一样：标记里的 commit 对得上、拼装出的技能数等于期望。
 * 缓存被人动过（少了目录）就当作没有，重新下载并覆盖。
 */
export function cachedTree(cacheRoot: string | undefined, commit: string, expectSkills: number): string {
  if (!cacheRoot || commit === '' || commit === '-') return '';
  const dir = path.join(cacheRoot, commit);
  let body: string;
  try {
    body = fs.readFileSync(path.join(dir, cacheMarker), 'utf8');
  } catch {
    return '';
  }
  if (body.trim() !== commit) return '';
  let count = 0;
  for (const sub of skillsSubdirsInRepo) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(dir, sub));
    } catch {
      continue;
    }
    for (const name of entries) if (exists(path.join(dir, sub, name, manifestFile))) count++;
  }
  return count === expectSkills ? dir : '';
}

/**
 * 把刚克隆、校验过的技能树搬进缓存。先拷进同级临时目录再改名，
 * 别的进程读到的缓存要么没有、要么完整。失败只影响下次要不要联网，不让安装失败。
 */
export function storeCache(cacheRoot: string | undefined, commit: string, clone: string): void {
  if (!cacheRoot || commit === '') return;
  fs.mkdirSync(cacheRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cacheRoot, '.staging-'));
  try {
    for (const sub of skillsSubdirsInRepo) {
      const source = path.join(clone, sub);
      if (!exists(source)) continue;
      copyTree(source, path.join(staging, sub));
    }
    fs.writeFileSync(path.join(staging, cacheMarker), commit + '\n', { mode: 0o644 });
    const target = path.join(cacheRoot, commit);
    fs.rmSync(target, { recursive: true, force: true }); // 被判为不可用的旧缓存
    try {
      fs.renameSync(staging, target);
    } catch (err) {
      if (exists(path.join(target, cacheMarker))) return; // 另一个进程刚放好同一份
      throw err;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 安装结果。 */
export interface Result {
  /** 写进项目的技能名，已排序。 */
  installed: string[];
  /** 因为与内置技能重名而跳过的上游技能名。 */
  protected: string[];
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
      if (exists(p)) sources.push(p);
    }
    if (sources.length === 0) {
      throw new Error(`上游仓库 ${opts.repoURL} 在 ${commit!} 上没有 ${goList(skillsSubdirsInRepo)} 中的任何一处，技能目录结构已变`);
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

/**
 * 按 tag v<version> 浅克隆上游仓库，只检出技能所在的两个目录，
 * 校验解析出的 commit，返回该 commit。
 *
 * 三个开关都是承重的：
 *
 *   - GIT_LFS_SKIP_SMUDGE=1：仓库里有 LFS 管理的媒体文件。装了 git-lfs 的机器
 *     会把它们还原成真文件，没装的机器留下 132 字节的指针——同一个 commit 在
 *     两台机器上得到不同的树，"可复现"当场失效。上游安装器本身也不拉 LFS，
 *     所以跳过 smudge 同时也是与它产出保持逐字节一致的前提。
 *   - --filter=blob:none --sparse：仓库带着 packages/ 和测试产物，完整克隆几百 MB。
 *   - GIT_CONFIG_GLOBAL/SYSTEM=/dev/null：用户的 git 配置（钩子、filter、
 *     autocrlf）不能参与，否则同一个 commit 在不同人机器上检出结果不同。
 */
/**
 * 把固定 commit 的技能目录取到 dir：有能用的 git 就按 tag 浅克隆（原来的做法，带进度），
 * 没有 git 时从 GitHub 逐个文件下载并按 blob 摘要校验（download.ts）。返回 commit。
 */
async function fetchSkills(dir: string, opts: Resolved, report: (p: Progress) => void, signal: AbortSignal | undefined): Promise<string> {
  const git = usableGit(opts.env);
  if (git !== '') return cloneSkills(git, dir, opts, report, signal);
  const gh = githubRepo(opts.repoURL);
  // 前缀沿用 MissingToolPrefix：cli 靠它把错误映射成退出码 127。
  if (!gh || opts.expectCommit === '-') throw new Error(`${MissingToolPrefix}：git（无法获取 HyperFrames 技能：${gitHint()}）`);
  report({ stage: '下载技能文件', percent: 0 });
  try {
    await downloadTree({
      ...gh,
      commit: opts.expectCommit,
      subdirs: skillsSubdirsInRepo,
      dir,
      env: opts.env,
      signal,
      progress: (done, total) => report({ stage: `下载技能文件 ${done}/${total}`, percent: total === 0 ? 0 : (copyStart * done) / total }),
    });
  } catch (err) {
    throw new Error(`从 GitHub 下载 HyperFrames 技能失败（可以加 --proxy 走代理，重跑即可）：${errorText(err)}`, { cause: err });
  }
  return opts.expectCommit;
}

async function cloneSkills(
  git: string,
  dir: string,
  opts: Resolved,
  report: (p: Progress) => void,
  signal: AbortSignal | undefined,
): Promise<string> {
  const env = cloneEnv(opts.env);
  const run = async (stderr: Writer | undefined, args: string[]) =>
    (await runCommand(git, args, { cwd: dir, env, stderr, signal })).trim();
  const tag = 'v' + opts.version;
  // -c advice.detachedHead=false：按 tag 克隆必然是 detached HEAD，git 会
  // 往 stderr 打一段给人看的忠告，而 stderr 是接到 onset 输出上的。
  // 要进度时用 --progress（stderr 不是终端时 git 默认不报进度）：进度行解析成回调，
  // 原文照样转给 output，克隆失败时 git 的 fatal 信息还在。
  let verbosity = '--quiet';
  let cloneErr: Writer | undefined = opts.output;
  if (opts.progress) {
    verbosity = '--progress';
    cloneErr = new GitProgress(report, opts.output);
  }
  try {
    await run(cloneErr, [
      '-c', 'advice.detachedHead=false', 'clone', verbosity,
      '--depth', '1', '--filter=blob:none', '--sparse', '--branch', tag,
      opts.repoURL, '.',
    ]);
  } catch (err) {
    throw new Error(`克隆 ${opts.repoURL} 的 ${tag} 失败：${errorText(err)}`, { cause: err });
  }
  // 检出时才按需下载技能目录里的文件内容（--filter=blob:none），git 不报进度。
  report({ stage: '下载技能文件', percent: checkoutStart, indeterminate: true });
  try {
    await run(opts.output, ['sparse-checkout', 'set', ...skillsSubdirsInRepo]);
  } catch (err) {
    throw new Error(`检出技能目录失败：${errorText(err)}`, { cause: err });
  }
  let commit: string;
  try {
    commit = await run(opts.output, ['rev-parse', 'HEAD']);
  } catch (err) {
    throw new Error(`无法解析 ${tag} 指向的 commit：${errorText(err)}`, { cause: err });
  }
  if (opts.expectCommit !== '-' && commit !== opts.expectCommit) {
    throw new Error(`${tag} 指向 ${commit}，与固定的 ${opts.expectCommit} 不符：tag 被移动过，拒绝安装`);
  }
  return commit;
}

/** 组装 git 的运行环境：沿用 PATH 与代理设置，但屏蔽用户的 git 配置。 */
export function cloneEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** 按文件名字典序读目录（os.ReadDir 的顺序）。 */
function readDirSorted(dir: string): fs.Dirent[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}

/**
 * 把 sources 各目录下的每个技能目录整体搬进 dest。
 *
 * 收多个来源是因为上游把技能放在仓库的两处（skills/ 与 .agents/skills/）。
 * 判定标准仍是"目录里有 SKILL.md"，与上游安装器的筛选结果实测逐字节一致。
 *
 * 上游技能由 onset 按固定 commit 管理，所以同名目录整体替换而不是合并：残留上
 * 一版的文件会让技能树处于两个版本混合的状态，而那正是固定版本要消除的东西。
 * 随二进制下发的技能受 protectedSkills 保护，永远不会被上游同名技能覆盖。
 */
export function copySkills(
  sources: string[],
  dest: string,
  protectedSkills?: ReadonlySet<string>,
  copied?: (done: number) => void,
): Result {
  fs.mkdirSync(dest, { recursive: true });
  const result: Result = { installed: [], protected: [] };
  const seen = new Map<string, string>();
  for (const source of sources) {
    let entries: fs.Dirent[];
    try {
      entries = readDirSorted(source);
    } catch (err) {
      throw new Error(`无法读取安装产物：${errorText(err)}`, { cause: err });
    }
    for (const entry of entries) {
      const name = entry.name;
      if (!entry.isDirectory()) continue;
      if (!exists(path.join(source, name, manifestFile))) continue; // 不是技能目录
      // 两处出现同名技能时哪一份生效取决于遍历顺序，是静默的不确定性。
      const previous = seen.get(name);
      if (previous !== undefined) throw new Error(`技能 ${name} 在 ${previous} 与 ${source} 两处重复，无法确定用哪一份`);
      seen.set(name, source);
      if (protectedSkills?.has(name)) {
        result.protected.push(name);
        continue;
      }
      const target = path.join(dest, name);
      fs.rmSync(target, { recursive: true, force: true });
      try {
        copyTree(path.join(source, name), target);
      } catch (err) {
        throw new Error(`拷贝技能 ${name} 失败：${errorText(err)}`, { cause: err });
      }
      result.installed.push(name);
      copied?.(result.installed.length + result.protected.length);
    }
  }
  if (result.installed.length === 0) throw new Error(`安装产物里没有任何技能目录：${goList(sources)}`);
  result.installed.sort(compareBytes);
  result.protected.sort(compareBytes);
  return result;
}

/**
 * 递归拷贝目录。符号链接一律拒绝：上游在 Unix 上用符号链接做的是
 * 「镜像到其他 agent 目录」，指回它自己的 home store；搬进项目后那些链接会指向
 * 一个已经删掉的临时目录，成为静默失效的空技能。
 */
export function copyTree(source: string, dest: string): void {
  const walk = (relative: string) => {
    const from = relative === '' ? source : path.join(source, relative);
    const target = relative === '' ? dest : path.join(dest, relative);
    fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    for (const entry of readDirSorted(from)) {
      const rel = relative === '' ? entry.name : path.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`安装产物含符号链接，无法安全搬进项目：${rel}`);
      } else if (entry.isFile()) {
        const file = path.join(source, rel);
        const mode = fs.statSync(file).mode & 0o777;
        const body = fs.readFileSync(file);
        fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true, mode: 0o755 });
        fs.writeFileSync(path.join(dest, rel), body, { mode });
      }
      // 设备、套接字之类一律忽略
    }
  };
  walk('');
}
