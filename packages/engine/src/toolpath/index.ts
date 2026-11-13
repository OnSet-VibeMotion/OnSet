// 外部工具与运行时的唯一入口：am 自带的优先，其次才是用户 PATH 里的。
//
// 客户端随 .app 下发运行时（Electron 以 Node 模式运行，即 ELECTRON_RUN_AS_NODE=1）、npm、ffmpeg / ffprobe 与 uv，
// 用户不必自己装 Node、Python、Homebrew。客户端的 am shim 经环境变量告诉 am 它们在哪（见
// apps/desktop/src/main/clishim.ts）；单独用命令行（开发、终端里的 am）时这些变量不存在，退回 PATH。
//
// 不往用户的 PATH 前面塞 node：编排工具在这一轮里跑的 npx、用户自己的脚本都会被换成 Electron，出了问题极难排查。
// 要用 Node 的地方（HyperFrames CLI、npm）由 am 显式用自己的运行时启动；只有 npm install 跑依赖的安装脚本
// （esbuild 的 postinstall 写的是 `node install.js`）时，才在那一个子进程的 PATH 前面加一个临时的 node。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BinDirEnv, binDir, dataDir, lookPath } from '../envutil';

export { BinDirEnv, binDir, dataDir };

/** 随客户端下发的可执行文件目录（.app/Contents/Resources/bin），放 ffmpeg、ffprobe、uv。 */
export const BundledBinEnv = 'AM_BUNDLED_BIN';

/** 随客户端下发的 npm 入口（.app/Contents/Resources/npm/bin/npm-cli.js）。 */
export const NpmCliEnv = 'AM_NPM_CLI';


/** 这些变量要显式传给子进程（config.childEnvironment）：编排工具与渲染器调用的 am 要找到同一套自带工具。 */
export const childEnvKeys = [BundledBinEnv, NpmCliEnv, BinDirEnv];


/** 用 am 自己的运行时执行一个 JS 入口的命令。 */
export interface NodeCommand {
  file: string;
  args: string[];
  /** 要并进子进程环境的变量。 */
  env: Record<string, string>;
}

/** 正跑在 Electron 里（客户端自带的运行时）。 */
export function onElectron(): boolean {
  return Boolean(process.versions.electron);
}

/**
 * 用 am 自己的运行时执行 script：客户端里是 Electron（要带 ELECTRON_RUN_AS_NODE=1），终端里是运行 am 的那个 Node。
 * am 自己能跑，说明这个运行时满足 HyperFrames 与 npm 的版本要求（Node 22+）。
 */
export function nodeCommand(script: string, args: string[]): NodeCommand {
  return {
    file: process.execPath,
    args: [script, ...args],
    env: onElectron() ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  };
}

/** npm 的调用方式：自带的 npm 用 am 的运行时跑，否则用 PATH 里的 npm。找不到时抛 MissingToolError。 */
export function npmCommand(env: Record<string, string | undefined>, args: string[]): NodeCommand {
  const bundled = env[NpmCliEnv];
  if (bundled && isFile(bundled)) return nodeCommand(bundled, args);
  return { file: lookPath('npm', env.PATH ?? ''), args: [...args], env: {} };
}

/**
 * 一个装着 `node` 的目录，给 npm install 跑依赖的安装脚本用。终端里是运行 am 的 Node 所在目录；
 * 客户端里写一个转到 Electron 的小脚本（放在临时目录，按运行时路径区分，内容不变就不重写）。
 */
export function nodeDir(): string {
  if (!onElectron()) return path.dirname(process.execPath);
  const digest = crypto.createHash('sha256').update(process.execPath).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), `am-node-${digest}`);
  const windows = process.platform === 'win32';
  const file = path.join(dir, windows ? 'node.cmd' : 'node');
  const body = windows ? windowsNodeScript(process.execPath) : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath.replace(/'/g, `'\\''`)}' "$@"\n`;
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  if (existing !== body) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    fs.renameSync(tmp, file);
  }
  return dir;
}

/**
 * Windows 上的 node.cmd。批处理按系统代码页解析（中文 Windows 是 GBK），运行时路径里有中文（用户名是中文时
 * 很常见）就会读错，所以先切到 UTF-8：cmd 逐行读批处理，chcp 之后的行按 UTF-8 解析。
 */
export function windowsNodeScript(execPath: string): string {
  return ['@echo off', 'chcp 65001 >nul', 'set ELECTRON_RUN_AS_NODE=1', `"${execPath}" %*`, ''].join('\r\n');
}

/** env 的副本，PATH 前面加上 nodeDir()：只给 npm install 这类要跑安装脚本的子进程用。 */
export function withNode(env: Record<string, string>): Record<string, string> {
  const dir = nodeDir();
  const current = env.PATH ?? '';
  return { ...env, PATH: current === '' ? dir : `${dir}${path.delimiter}${current}` };
}

/** 随客户端下发的、或 am setup 下载的 name；都没有时为空。 */
export function bundled(name: string, env: Record<string, string | undefined>): string {
  // Windows 上可执行文件带扩展名（ffmpeg.exe、uv.exe，npm 类工具是 .cmd）。
  const names = process.platform === 'win32' && path.extname(name) === '' ? [name + '.exe', name + '.cmd'] : [name];
  for (const dir of [env[BundledBinEnv] ?? '', binDir(env)]) {
    if (dir === '') continue;
    for (const n of names) {
      const file = path.join(dir, n);
      if (isExecutable(file)) return file;
    }
  }
  return '';
}

/** 找外部工具：自带或 am 下载的优先，其次 PATH。找不到时抛 MissingToolError（cli 把它映射成退出码 127）。 */
export function find(name: string, env: Record<string, string | undefined>): string {
  return bundled(name, env) || lookPath(name, env.PATH ?? '');
}

/** 同 find，找不到时返回空串。 */
export function findOptional(name: string, env: Record<string, string | undefined>): string {
  try {
    return find(name, env);
  } catch {
    return '';
  }
}

/**
 * 能用的 git；没有时为空。macOS 没装 Xcode 命令行工具时 /usr/bin/git 只是占位程序，一运行就弹窗要求安装，
 * 所以那种情况下先用 `xcode-select -p`（不弹窗）确认命令行工具在不在。
 * AM_NO_GIT=1 当作没有 git（测试不用 git 的下载路径用）。
 */
export function usableGit(env: Record<string, string | undefined>): string {
  if (env.AM_NO_GIT === '1') return '';
  let git: string;
  try {
    git = lookPath('git', env.PATH ?? '');
  } catch {
    return '';
  }
  if (process.platform === 'darwin' && git === '/usr/bin/git') {
    const probe = spawnSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' });
    if (probe.status !== 0) return '';
  }
  return git;
}

/** 缺 git 时给用户的说明：只有 macOS 才有一键装的命令行工具。 */
export function gitHint(): string {
  return process.platform === 'darwin' ? '在终端运行 xcode-select --install 安装 Xcode 命令行工具（含 git）后重试' : '先安装 git 后重试';
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
