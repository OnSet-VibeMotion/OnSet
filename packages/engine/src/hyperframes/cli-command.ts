// HyperFrames CLI 的缓存定位、就绪检查与命令构造。
import fs from 'node:fs';
import path from 'node:path';
import { missing } from '../prereq';
import { bundled, nodeCommand } from '../toolpath';
import { BrowserEnv, browserFor, HyperFramesBrowserEnv } from './browser';
import { BrowserAppArgEnv, BrowserHookEnv, writeBootScript } from './browserhook';
import { defaultCacheDir } from './cache';
import { PinnedVersion } from './constants';

/**
 * 渲染器与编排工具调用 CLI 的写法。提示词、锁定文件与安全模式的放行列表
 * 都用它，版本号只在 onset 里出现一次。
 */
export const CLICommand = 'onset hyperframes';

/** 覆盖 CLI 的安装目录（测试与特殊部署用）。 */
export const CLIDirEnv = 'ONSET_HYPERFRAMES_CLI_DIR';

/** 写在安装目录里，内容是版本号：只有完整装好、自检通过的目录才有它。 */
export const cliMarker = '.onset-cli';

/** 运行缓存里 CLI 的命令（对应 Go 返回的 *exec.Cmd）：交给 spawn 执行，args 原样传给 CLI。 */
export interface CLICommandSpec {
  file: string;
  args: string[];
  /** 子进程的完整环境。 */
  env: Record<string, string>;
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

/**
 * CLI 的 JS 入口（包的 package.json 里 bin 指向的文件）。读不到时为空：测试里的假 CLI 只有一个 shell 脚本。
 */
export function cliEntry(dir: string): string {
  const pkgDir = path.join(dir, 'node_modules', 'hyperframes');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
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
  // Windows 的 experimental drawElement 路径会校准后回退；沿用客户端已经选择的稳定截图路径。
  if (process.platform === 'win32') out.PRODUCER_EXPERIMENTAL_FAST_CAPTURE ??= 'false';
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
