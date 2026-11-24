// HyperFrames 渲染用浏览器的路径解析、缓存检查与前置校验。
import fs from 'node:fs';
import path from 'node:path';
import { missing } from '../prereq';
import type { Progress, Writer } from './progress';

/**
 * 客户端自带的浏览器（客户端写出的包装脚本，见 apps/desktop/src/main/browser.ts）。客户端的 onset shim 设它，
 * onset 据此把 HyperFrames 指到客户端里的 Chromium，用户不必再下载 chrome-headless-shell。
 */
export const BrowserEnv = 'ONSET_BROWSER';

/** HyperFrames 自己认的浏览器位置。用户显式设了它就尊重用户的。 */
export const HyperFramesBrowserEnv = 'HYPERFRAMES_BROWSER_PATH';

/** 一次浏览器准备。 */
export interface BrowserOptions {
  env?: Record<string, string>;
  output?: Writer;
  progress?: (p: Progress) => void;
}

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
