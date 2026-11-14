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
import { missing } from '../prereq';
import { bundled, nodeCommand, npmCommand, withNode } from '../toolpath';
import { PinnedVersion } from './constants';
import { defaultCacheDir } from './hyperframes';
import type { Progress, Writer } from './progress';
import { BrowserAppArgEnv, BrowserHookEnv, writeBootScript } from './browserhook';
import { errorText, goQuote, runCommand, watchSize } from './util';

/**
 * 渲染器与编排工具调用 CLI 的写法。提示词、锁定文件与安全模式的放行列表
 * 都用它，版本号只在 onset 里出现一次。
 */
export const CLICommand = 'onset hyperframes';

/** 覆盖 CLI 的安装目录（测试与特殊部署用）。 */
export const CLIDirEnv = 'ONSET_HYPERFRAMES_CLI_DIR';

/** 写在安装目录里，内容是版本号：只有完整装好、自检通过的目录才有它。 */
const cliMarker = '.onset-cli';

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
 * 除 onset setup 以外的地方都用它：CLI 是前置资源。
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
    throw new Error(`找不到 npm（客户端自带一份；单独用命令行时需要 Node 22+），无法安装 HyperFrames CLI：${errorText(err)}`, { cause: err });
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
        await installCLI(dir, pkg, version, env, opts.output, signal, (bytes) => report({ stage, percent: 0, indeterminate: true, bytes }));
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

/** 运行缓存里 CLI 的命令（对应 Go 返回的 *exec.Cmd）：交给 spawn 执行，args 原样传给 CLI。 */
export interface CLICommandSpec {
  file: string;
  args: string[];
  /** 子进程的完整环境。 */
  env: Record<string, string>;
}

/**
 * 客户端自带的浏览器（客户端写出的包装脚本，见 apps/desktop/src/main/browser.ts）。客户端的 onset shim 设它，
 * onset 据此把 HyperFrames 指到客户端里的 Chromium，用户不必再下载 chrome-headless-shell。
 */
export const BrowserEnv = 'ONSET_BROWSER';

/** HyperFrames 自己认的浏览器位置。用户显式设了它就尊重用户的。 */
export const HyperFramesBrowserEnv = 'HYPERFRAMES_BROWSER_PATH';

/** 本次调用 HyperFrames 该用的浏览器：用户显式指定的优先，其次是客户端自带的；都没有时为空，由 HyperFrames 自己找。 */
export function browserFor(env: Record<string, string | undefined>): string {
  const explicit = env[HyperFramesBrowserEnv];
  if (explicit) return explicit;
  const bundled = env[BrowserEnv];
  if (bundled && isExecutable(bundled)) return bundled;
  return '';
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * HyperFrames 自己下载的 chrome-headless-shell（`hyperframes browser ensure`）放在哪里。路径是上游写死的
 * `~/.cache/hyperframes/chrome/chrome-headless-shell/<版本>/<平台目录>/chrome-headless-shell`，上游用 os.homedir()，
 * 所以跟着 HOME 走。只在没有客户端自带浏览器时（单独使用命令行）才需要它。
 */
export function headlessShellRoot(env: Record<string, string | undefined>): string {
  const home = env.HOME ?? '';
  if (home === '') return '';
  return path.join(home, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell');
}

const headlessShellDirs: Record<string, string> = {
  'darwin/arm64': 'chrome-headless-shell-mac-arm64',
  'darwin/x64': 'chrome-headless-shell-mac-x64',
  'linux/x64': 'chrome-headless-shell-linux64',
};

/** 已下载的任一版本 headless-shell；没有时为空。 */
export function cachedHeadlessShell(env: Record<string, string | undefined>): string {
  const root = headlessShellRoot(env);
  const platformDir = headlessShellDirs[`${process.platform}/${process.arch}`];
  if (root === '' || platformDir === undefined) return '';
  let versions: string[];
  try {
    versions = fs.readdirSync(root).sort().reverse();
  } catch {
    return '';
  }
  for (const version of versions) {
    const binary = path.join(root, version, platformDir, 'chrome-headless-shell');
    try {
      if (fs.statSync(binary).size > 0) return binary;
    } catch {
      // 这个版本没下完
    }
  }
  return '';
}

/**
 * 渲染要用的浏览器在哪：显式指定的、客户端自带的、或已下载的 headless-shell；都没有时 ok 为假。
 * 不联网，给前置资源清单与渲染前检查用。
 */
export function browserStatus(env: Record<string, string | undefined>): { ok: boolean; where: string } {
  const chosen = browserFor(env);
  if (chosen !== '') return { ok: true, where: chosen };
  const cached = cachedHeadlessShell(env);
  if (cached !== '') return { ok: true, where: cached };
  return { ok: false, where: headlessShellRoot(env) };
}

/**
 * 没有可用的浏览器就抛 prereq.MissingError。渲染前调用：不检查的话 HyperFrames 会在第一次渲染时自己去下载
 * 约 390 MB 的 chrome-headless-shell，网络一差渲染器就空等。
 */
export function requireBrowser(env: Record<string, string | undefined>): string {
  const status = browserStatus(env);
  if (status.ok) return status.where;
  throw missing('HyperFrames 渲染用的浏览器', status.where === '' ? '环境里没有 HOME' : '没有下载到 ' + status.where);
}

/** 一次浏览器准备。 */
export interface BrowserOptions {
  env?: Record<string, string>;
  output?: Writer;
  progress?: (p: Progress) => void;
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
    const stage = attempt > 1 ? `下载 chrome-headless-shell（重试 ${attempt}/${cliAttempts}）` : '下载 chrome-headless-shell';
    report({ stage, percent: 0, indeterminate: true });
    // browser ensure 跑完才吐输出：量浏览器目录长了多少，界面才看得出下了多少、多快。
    const stopWatch = watchSize([headlessShellRoot(env)], (bytes) => report({ stage, percent: 0, indeterminate: true, bytes }));
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
    if (opts.output && attempt < cliAttempts) opts.output.write(`下载浏览器失败，重试（${attempt + 1}/${cliAttempts}）：${errorText(lastErr)}\n`);
  }
  throw new Error(`下载 HyperFrames 渲染用的浏览器失败（可以加 --proxy 走代理，网络好转后重新运行即可）：${errorText(lastErr)}`, { cause: lastErr });
}

/**
 * CLI 的 JS 入口（包的 package.json 里 bin 指向的文件）。读不到时为空：测试里的假 CLI 只有一个 shell 脚本。
 */
export function cliEntry(dir: string): string {
  const pkgDir = path.join(dir, 'node_modules', 'hyperframes');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.hyperframes;
    if (!bin) return '';
    const entry = path.join(pkgDir, bin);
    return fs.existsSync(entry) ? entry : '';
  } catch {
    return '';
  }
}

/**
 * 构造运行缓存里 CLI 的命令；args 原样传给它。
 *
 * CLI 用 onset 自己的运行时启动（toolpath.nodeCommand），不经它的 `#!/usr/bin/env node`：客户端用户的机器上
 * 未必有 Node，有的话版本也未必够。浏览器、ffmpeg、ffprobe 也在这里指给它：客户端自带的优先。
 */
export function cliCommandFor(dir: string, env: Record<string, string>, args: string[]): CLICommandSpec {
  const out = { ...env };
  const browser = browserFor(env);
  if (browser !== '') out[HyperFramesBrowserEnv] = browser;
  for (const [tool, key] of [
    ['ffmpeg', 'HYPERFRAMES_FFMPEG_PATH'],
    ['ffprobe', 'HYPERFRAMES_FFPROBE_PATH'],
  ] as const) {
    const file = bundled(tool, env);
    if (file !== '' && !out[key]) out[key] = file;
  }
  const entry = cliEntry(dir);
  if (entry === '') return { file: cliBinary(dir), args: [...args], env: out };
  // 借用客户端浏览器而不能用包装脚本时（Windows）：经引导脚本启动，由它接管启动浏览器的那一下（见 browserhook.ts）。
  // 用户自己指定了 HYPERFRAMES_BROWSER_PATH 时不接管。
  if (env[BrowserHookEnv] === '1' && browser !== '' && browser === env[BrowserEnv]) {
    const { boot, standIn } = writeBootScript(dir);
    const command = nodeCommand(boot, [entry, ...args]);
    return {
      file: command.file,
      args: command.args,
      env: {
        ...out,
        ...command.env,
        // HyperFrames 看到的浏览器是替身；引导脚本把它换成真正的客户端（browser，即 ONSET_BROWSER）。
        [HyperFramesBrowserEnv]: standIn,
        ONSET_BOOT_BROWSER: standIn,
        ONSET_BOOT_APP_EXE: browser,
        ONSET_BOOT_APP_ARG: env[BrowserAppArgEnv] ?? '',
      },
    };
  }
  const command = nodeCommand(entry, args);
  return { file: command.file, args: command.args, env: { ...out, ...command.env } };
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
