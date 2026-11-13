// 移植自 internal/hyperframes/cli.go。
//
// CLI 是 am 管理的 HyperFrames CLI：按固定版本装在用户级目录里，所有项目、所有镜头共用。
//
// 以前由渲染器在渲染途中 `npx --yes hyperframes@<版本>` 现下载：版本一升级，第一次渲染
// 就要先下几十 MB 的 npm 包，网络不好时渲染器空等二十多分钟、花一次模型调用，最后只
// 留下「没有产物」（实测）。现在它是前置资源：由 am setup 装好，所有调用都走
// `am hyperframes`，没装好在开工前就报出来，而且不再依赖 npx 自己那份缓存是否还在。
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { lookPath } from '../envutil';
import { abortReason } from '../procgroup';
import { missing } from '../prereq';
import { PinnedVersion } from './constants';
import { defaultCacheDir } from './hyperframes';
import type { Progress, Writer } from './progress';
import { errorText, goQuote, runCommand } from './util';

/**
 * 渲染器与编排工具调用 CLI 的写法。提示词、锁定文件与安全模式的放行列表
 * 都用它，版本号只在 am 里出现一次。
 */
export const CLICommand = 'am hyperframes';

/** 覆盖 CLI 的安装目录（测试与特殊部署用）。 */
export const CLIDirEnv = 'AM_HYPERFRAMES_CLI_DIR';

/** 写在安装目录里，内容是版本号：只有完整装好、自检通过的目录才有它。 */
const cliMarker = '.am-cli';

/** 一次 CLI 安装。 */
export interface CLIOptions {
  /** 当前进程环境：PATH 找 npm，HOME 让 npm 读到用户的 .npmrc（镜像、代理、鉴权）。 */
  env?: Record<string, string>;
  /** 留空取 PinnedVersion。 */
  version?: string;
  /** 接收 npm 的输出。 */
  output?: Writer;
  /** 非空时汇报进度（npm 不报可量的进度，只有阶段）。 */
  progress?: (p: Progress) => void;
  /** 要安装的 npm 包规格，留空取 hyperframes@<version>。测试用它指向本地包。 */
  package?: string;
}

/** 某个版本 CLI 的安装目录；env 里既没有 CLIDirEnv 也没有 HOME / XDG_DATA_HOME 时为空。 */
export function cliDir(env: Record<string, string | undefined>, version: string): string {
  const dir = env[CLIDirEnv];
  if (dir) return dir;
  const root = defaultCacheDir(env);
  if (root === '') return '';
  return path.join(root, 'cli-' + version);
}

/** 安装目录里 CLI 的可执行文件。 */
export function cliBinary(dir: string): string {
  return path.join(dir, 'node_modules', '.bin', 'hyperframes');
}

/** dir 里是完整安装好的 version。 */
export function cliReady(dir: string, version: string): boolean {
  if (dir === '') return false;
  try {
    if (fs.readFileSync(path.join(dir, cliMarker), 'utf8').trim() !== version) return false;
    return !fs.statSync(cliBinary(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 返回已装好的 CLI 目录，没装好抛 prereq.MissingError，不联网。
 * 除 am setup 以外的地方都用它：CLI 是前置资源。
 */
export function requireCLI(env: Record<string, string | undefined>): string {
  const dir = cliDir(env, PinnedVersion);
  if (cliReady(dir, PinnedVersion)) return dir;
  if (dir === '') throw missing('HyperFrames CLI ' + PinnedVersion, '环境里没有 HOME，也没有 ' + CLIDirEnv);
  throw missing('HyperFrames CLI ' + PinnedVersion, '没有装在 ' + dir);
}

/** npm install 的尝试次数：国内网络下单次安装被掐断是常态。 */
const cliAttempts = 3;

/**
 * 返回装好的 CLI 安装目录，没有时用 npm 安装。只有 am setup 调用它，
 * 其余地方用 requireCLI：CLI 是前置资源，不在建项目、渲染途中现装。
 *
 * npm install 在同级临时目录里进行，装好、跑过 `--version` 自检后整体改名进位，
 * 中途失败不会留下一份看起来能用的残缺安装；同一时间只有一个进程在装（锁文件）。
 * npm 用用户自己的配置（~/.npmrc 里的镜像、代理与鉴权），装出的版本由包规格钉死。
 */
export async function ensureCLI(opts: CLIOptions, signal?: AbortSignal): Promise<string> {
  const version = opts.version || PinnedVersion;
  const env = opts.env ?? {};
  const dir = cliDir(env, version);
  if (dir === '') throw new Error(`无法确定 HyperFrames CLI 的安装目录：环境里没有 HOME，可用 ${CLIDirEnv} 指定`);
  if (cliReady(dir, version)) return dir;
  const report = opts.progress ?? (() => {});
  let npm: string;
  try {
    npm = lookPath('npm', env.PATH ?? '');
  } catch (err) {
    throw new Error(`找不到 npm（需要 Node 20+），无法安装 HyperFrames CLI：${errorText(err)}`, { cause: err });
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const unlock = await lockFile(dir + '.lock', signal);
  try {
    if (cliReady(dir, version)) return dir; // 等锁期间另一个进程装好了
    const pkg = opts.package || 'hyperframes@' + version;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= cliAttempts; attempt++) {
      let stage = '安装 HyperFrames CLI ' + version;
      if (attempt > 1) stage = `安装 HyperFrames CLI ${version}（重试 ${attempt}/${cliAttempts}）`;
      report({ stage, percent: 0, indeterminate: true });
      try {
        await installCLI(npm, dir, pkg, version, env, opts.output, signal);
        report({ stage: 'HyperFrames CLI 已就绪', percent: 100 });
        return dir;
      } catch (err) {
        lastErr = err;
      }
      if (signal?.aborted) throw abortReason(signal);
      if (opts.output && attempt < cliAttempts) {
        opts.output.write(`安装 HyperFrames CLI 失败，重试（${attempt + 1}/${cliAttempts}）：${errorText(lastErr)}\n`);
      }
    }
    throw new Error(`安装 HyperFrames CLI ${version} 失败（npm 用的是你的 ~/.npmrc；网络好转后重新运行即可）：${errorText(lastErr)}`, {
      cause: lastErr,
    });
  } finally {
    unlock();
  }
}

async function installCLI(
  npm: string,
  dir: string,
  pkg: string,
  version: string,
  env: Record<string, string>,
  output: Writer | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const staging = fs.mkdtempSync(path.join(path.dirname(dir), '.cli-'));
  try {
    // 一个空的 package.json 让 npm 把依赖装进这个目录，而不是往上找到别的项目。
    fs.writeFileSync(path.join(staging, 'package.json'), '{"private":true}\n', { mode: 0o644 });
    const sink: Writer = output ?? { write: () => true };
    try {
      await runCommand(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error', '--save-exact', pkg], {
        cwd: staging,
        env,
        stdout: sink,
        stderr: sink,
        signal,
      });
    } catch (err) {
      throw new Error(`npm install ${pkg}：${errorText(err)}`, { cause: err });
    }
    const binary = cliBinary(staging);
    if (!fs.existsSync(binary)) throw new Error(`npm 装完了但没有 ${path.basename(binary)}：包结构已变`);
    // 自检：能跑起来、报出的版本对得上，才算装好。
    let out: string;
    try {
      out = await runCommand(binary, ['--version'], { cwd: staging, env, signal });
    } catch (err) {
      throw new Error(`装好的 HyperFrames CLI 跑不起来：${errorText(err)}`, { cause: err });
    }
    const got = out.trim();
    if (!got.includes(version)) throw new Error(`装好的 HyperFrames CLI 报告版本 ${goQuote(got)}，期望 ${version}`);
    fs.writeFileSync(path.join(staging, cliMarker), version + '\n', { mode: 0o644 });
    fs.rmSync(dir, { recursive: true, force: true }); // 没有完成标记的残缺安装
    fs.renameSync(staging, dir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 运行缓存里 CLI 的命令（对应 Go 返回的 *exec.Cmd）：交给 spawn 执行，args 原样传给 CLI。 */
export interface CLICommandSpec {
  file: string;
  args: string[];
  /** 子进程的完整环境。 */
  env: Record<string, string>;
}

/** 构造运行缓存里 CLI 的命令；args 原样传给它。 */
export function cliCommandFor(dir: string, env: Record<string, string>, args: string[]): CLICommandSpec {
  return { file: cliBinary(dir), args: [...args], env: { ...env } };
}

/** 超过这个时长（毫秒）的锁视为上一个进程崩溃留下的；npm 安装最长也就十几分钟。 */
const lockStale = 30 * 60 * 1000;

async function lockFile(file: string, signal?: AbortSignal): Promise<() => void> {
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o644);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`创建锁 ${file}：${errorText(err)}`, { cause: err });
      }
    }
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > lockStale) {
        fs.rmSync(file, { force: true });
        continue;
      }
    } catch {
      // 锁刚被释放，下一轮再抢。
    }
    if (signal?.aborted) throw abortReason(signal);
    try {
      await sleep(500, undefined, { signal });
    } catch {
      throw abortReason(signal!);
    }
  }
}
