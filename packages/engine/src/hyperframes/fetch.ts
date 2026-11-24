// 按固定 commit 拉取上游 HyperFrames 技能目录（git 浅克隆优先，无 git 时直下 GitHub blob）。
import { MissingToolPrefix } from '../envutil';
import { gitHint, usableGit } from '../toolpath';
import { skillsSubdirsInRepo } from './constants';
import { downloadTree, githubRepo } from './download';
import { checkoutStart, copyStart, GitProgress, type Progress, type Writer } from './progress';
import { errorText, runCommand } from './util';

export interface FetchOptions {
  version: string;
  repoURL: string;
  expectCommit: string;
  env: Record<string, string>;
  output?: Writer;
  progress?: (p: Progress) => void;
}

/**
 * 把固定 commit 的技能目录取到 dir：有能用的 git 就按 tag 浅克隆（原来的做法，带进度），
 * 没有 git 时从 GitHub 逐个文件下载并按 blob 摘要校验（download.ts）。返回 commit。
 */
export async function fetchSkills(
  dir: string,
  opts: FetchOptions,
  report: (p: Progress) => void,
  signal: AbortSignal | undefined,
): Promise<string> {
  const git = usableGit(opts.env);
  if (git !== '') return cloneSkills(git, dir, opts, report, signal);
  const gh = githubRepo(opts.repoURL);
  // 前缀沿用 MissingToolPrefix：cli 靠它把错误映射成退出码 127。
  if (!gh || opts.expectCommit === '-') {
    throw new Error(`${MissingToolPrefix}：git（无法获取 HyperFrames 技能：${gitHint()}）`);
  }
  report({ stage: '下载技能文件', percent: 0 });
  try {
    await downloadTree({
      ...gh,
      commit: opts.expectCommit,
      subdirs: skillsSubdirsInRepo,
      dir,
      env: opts.env,
      signal,
      progress: (done, total) =>
        report({ stage: `下载技能文件 ${done}/${total}`, percent: total === 0 ? 0 : (copyStart * done) / total }),
    });
  } catch (err) {
    throw new Error(`从 GitHub 下载 HyperFrames 技能失败（可以加 --proxy 走代理，重跑即可）：${errorText(err)}`, {
      cause: err,
    });
  }
  return opts.expectCommit;
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
async function cloneSkills(
  git: string,
  dir: string,
  opts: FetchOptions,
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
      '-c',
      'advice.detachedHead=false',
      'clone',
      verbosity,
      '--depth',
      '1',
      '--filter=blob:none',
      '--sparse',
      '--branch',
      tag,
      opts.repoURL,
      '.',
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
