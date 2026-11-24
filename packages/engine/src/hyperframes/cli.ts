//
// CLI 是 onset 管理的 HyperFrames CLI：按固定版本装在用户级目录里，所有项目、所有镜头共用。
//
// 以前由渲染器在渲染途中 `npx --yes hyperframes@<版本>` 现下载：版本一升级，第一次渲染
// 就要先下几十 MB 的 npm 包，网络不好时渲染器空等二十多分钟、花一次模型调用，最后只
// 留下「没有产物」（实测）。现在它是前置资源：由 onset setup 装好，所有调用都走
// `onset hyperframes`，没装好在开工前就报出来，而且不再依赖 npx 自己那份缓存是否还在。
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { abortReason } from '../procgroup';
import { npmCommand, withNode } from '../toolpath';
import { type BrowserOptions, browserStatus, headlessShellRoot } from './browser';
import { CLIDirEnv, cliBinary, cliCommandFor, cliDir, cliMarker, cliReady, requireCLI } from './cli-command';
import { PinnedVersion } from './constants';
import type { Progress, Writer } from './progress';
import { errorText, goQuote, runCommand, watchSize } from './util';

export {
  BrowserEnv,
  type BrowserOptions,
  browserFor,
  browserStatus,
  cachedHeadlessShell,
  HyperFramesBrowserEnv,
  headlessShellRoot,
  requireBrowser,
} from './browser';
export {
  CLICommand,
  type CLICommandSpec,
  CLIDirEnv,
  cliBinary,
  cliCommandFor,
  cliDir,
  cliEntry,
  cliReady,
  requireCLI,
} from './cli-command';

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

/** npm install 的尝试次数：国内网络下单次安装被掐断是常态。 */
const cliAttempts = 3;

/**
 * 返回装好的 CLI 安装目录，没有时用 npm 安装。只有 onset setup 调用它，
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
  // 自带的 npm 优先（客户端随 .app 下发，用户不必装 Node），其次 PATH 里的。
  try {
    npmCommand(env, []);
  } catch (err) {
    throw new Error(
      `找不到 npm（客户端自带一份；单独用命令行时需要 Node 22+），无法安装 HyperFrames CLI：${errorText(err)}`,
      { cause: err },
    );
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
        await installCLI(dir, pkg, version, env, opts.output, signal, (bytes) =>
          report({ stage, percent: 0, indeterminate: true, bytes }),
        );
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
    throw new Error(
      `安装 HyperFrames CLI ${version} 失败（npm 用的是你的 ~/.npmrc；网络好转后重新运行即可）：${errorText(lastErr)}`,
      { cause: lastErr },
    );
  } finally {
    unlock();
  }
}

async function installCLI(
  dir: string,
  pkg: string,
  version: string,
  env: Record<string, string>,
  output: Writer | undefined,
  signal: AbortSignal | undefined,
  onBytes: (bytes: number) => void = () => {},
): Promise<void> {
  const staging = fs.mkdtempSync(path.join(path.dirname(dir), '.cli-'));
  // npm 用 --loglevel=error 一声不吭：量临时目录长了多少，界面才看得出它在下载。
  const stopWatch = watchSize([staging], onBytes);
  try {
    // 一个空的 package.json 让 npm 把依赖装进这个目录，而不是往上找到别的项目。
    fs.writeFileSync(path.join(staging, 'package.json'), '{"private":true}\n', { mode: 0o644 });
    const sink: Writer = output ?? { write: () => true };
    try {
      const npm = npmCommand(env, ['install', '--no-audit', '--no-fund', '--loglevel=error', '--save-exact', pkg]);
      // 依赖的安装脚本（esbuild 的 postinstall）写的是 `node …`：给这一个子进程的 PATH 补上 node。
      await runCommand(npm.file, npm.args, {
        cwd: staging,
        env: withNode({ ...env, ...npm.env }),
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
      const self = cliCommandFor(staging, env, ['--version']);
      out = await runCommand(self.file, self.args, { cwd: staging, env: self.env, signal });
    } catch (err) {
      throw new Error(`装好的 HyperFrames CLI 跑不起来：${errorText(err)}`, { cause: err });
    }
    const got = out.trim();
    if (!got.includes(version)) throw new Error(`装好的 HyperFrames CLI 报告版本 ${goQuote(got)}，期望 ${version}`);
    fs.writeFileSync(path.join(staging, cliMarker), version + '\n', { mode: 0o644 });
    fs.rmSync(dir, { recursive: true, force: true }); // 没有完成标记的残缺安装
    fs.renameSync(staging, dir);
  } finally {
    stopWatch();
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * 准备渲染用的浏览器：已有（客户端自带或已下载）就直接返回，否则用固定版本的 CLI 运行
 * `hyperframes browser ensure` 下载 headless-shell。只有 onset setup 调用；CLI 要先装好。
 */
export async function ensureBrowser(opts: BrowserOptions, signal?: AbortSignal): Promise<string> {
  const env = opts.env ?? {};
  const report = opts.progress ?? (() => {});
  const status = browserStatus(env);
  if (status.ok) {
    report({ stage: '浏览器已就绪', percent: 100 });
    return status.where;
  }
  const dir = requireCLI(env);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cliAttempts; attempt++) {
    const stage =
      attempt > 1 ? `下载 chrome-headless-shell（重试 ${attempt}/${cliAttempts}）` : '下载 chrome-headless-shell';
    report({ stage, percent: 0, indeterminate: true });
    // browser ensure 跑完才吐输出：量浏览器目录长了多少，界面才看得出下了多少、多快。
    const stopWatch = watchSize([headlessShellRoot(env)], (bytes) =>
      report({ stage, percent: 0, indeterminate: true, bytes }),
    );
    try {
      const spec = cliCommandFor(dir, env, ['browser', 'ensure']);
      const out = await runCommand(spec.file, spec.args, { env: spec.env, signal }).finally(stopWatch);
      opts.output?.write(out);
      const after = browserStatus(env);
      if (after.ok) {
        report({ stage: '浏览器已就绪', percent: 100 });
        return after.where;
      }
      lastErr = new Error('hyperframes browser ensure 跑完了，但没有找到下载好的浏览器');
    } catch (err) {
      lastErr = err;
    }
    if (signal?.aborted) throw abortReason(signal);
    if (opts.output && attempt < cliAttempts) {
      opts.output.write(`下载浏览器失败，重试（${attempt + 1}/${cliAttempts}）：${errorText(lastErr)}\n`);
    }
  }
  throw new Error(
    `下载 HyperFrames 渲染用的浏览器失败（可以加 --proxy 走代理，网络好转后重新运行即可）：${errorText(lastErr)}`,
    { cause: lastErr },
  );
}

/** 超过这个时长（毫秒）的锁视为上一个进程崩溃留下的；npm 安装最长也就十几分钟。lockFile 也给节拍分析环境的安装用。 */
const lockStale = 30 * 60 * 1000;

export async function lockFile(file: string, signal?: AbortSignal): Promise<() => void> {
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
