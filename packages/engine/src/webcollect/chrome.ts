/**
 * 本机 Chrome / Chromium / Edge / Playwright 浏览器探测与无头截图进程执行器。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lookPath, MissingToolError } from '../envutil';
import { removeTree } from '../fsutil';
import type { ScreenshotRunRequest } from './types';

const ChromeEnvKeys = [
  'ONSET_CHROME_PATH',
  'CHROME_PATH',
  'PUPPETEER_EXECUTABLE_PATH',
  'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
];

function existingFile(candidate: string | undefined): string | null {
  if (!candidate) return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function findPlaywrightChromium(env: Record<string, string>): string | null {
  const home = env.HOME || os.homedir();
  const cacheDirs = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : undefined,
    path.join(home, '.cache', 'ms-playwright'),
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'ms-playwright') : undefined,
  ].filter((d): d is string => Boolean(d));

  for (const base of cacheDirs) {
    if (!fs.existsSync(base)) continue;
    let entries: string[];
    try {
      entries = fs
        .readdirSync(base)
        .filter((name) => name.startsWith('chromium-') || name.startsWith('chromium_headless_shell-'))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const dir of entries) {
      const root = path.join(base, dir);
      const candidates =
        process.platform === 'darwin'
          ? [
              path.join(
                root,
                'chrome-mac-arm64',
                'Google Chrome for Testing.app',
                'Contents',
                'MacOS',
                'Google Chrome for Testing',
              ),
              path.join(root, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
              path.join(root, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
              path.join(root, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
            ]
          : process.platform === 'win32'
            ? [path.join(root, 'chrome-win', 'chrome.exe'), path.join(root, 'chrome-win64', 'chrome.exe')]
            : [
                path.join(root, 'chrome-linux', 'chrome'),
                path.join(root, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
              ];
      for (const bin of candidates) {
        if (existingFile(bin)) return bin;
      }
    }
  }
  return null;
}

/** 探测本机可用的 Chrome / Chromium / Edge / Playwright 浏览器可执行文件路径。 */
export function findChromeExecutable(
  explicitPath?: string,
  env: Record<string, string> = process.env as Record<string, string>,
): string | null {
  if (explicitPath) {
    const found = existingFile(explicitPath);
    if (found) return found;
  }
  for (const key of ChromeEnvKeys) {
    const found = existingFile(env[key]);
    if (found) return found;
  }

  const staticPaths: string[] =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : process.platform === 'win32'
        ? [
            path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(
              env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
              'Google',
              'Chrome',
              'Application',
              'chrome.exe',
            ),
            path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

  for (const p of staticPaths) {
    if (existingFile(p)) return p;
  }

  const pathEnv = env.PATH ?? process.env.PATH ?? '';
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const resolved = lookPath(cmd, pathEnv);
      if (resolved) return resolved;
    } catch (err) {
      if (err instanceof MissingToolError) continue;
      throw err;
    }
  }
  return findPlaywrightChromium(env);
}

function fallbackKillSingle(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // 进程已退出
  }
}

function resolveTaskkill(): string | null {
  try {
    return lookPath('taskkill', process.env.PATH ?? '');
  } catch {
    const sysRoot = process.env.SystemRoot || process.env.WINDIR;
    return sysRoot ? existingFile(path.join(sysRoot, 'System32', 'taskkill.exe')) : null;
  }
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const taskkillBin = resolveTaskkill();
    if (!taskkillBin) {
      fallbackKillSingle(pid, signal);
      return;
    }
    const taskkillArgs = signal === 'SIGKILL' ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
    try {
      const killer = spawn(taskkillBin, taskkillArgs, { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => fallbackKillSingle(pid, signal));
      killer.on('close', (code) => {
        if (code !== 0) fallbackKillSingle(pid, signal);
      });
    } catch {
      fallbackKillSingle(pid, signal);
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    fallbackKillSingle(pid, signal);
  }
}

/** 默认的无头 Chrome 截图执行器（禁用非代理 UDP/WebRTC 与 QUIC，强制全部网络流量走受控代理）。 */
export async function runChromeScreenshot(req: ScreenshotRunRequest): Promise<void> {
  if (req.signal?.aborted) throw new Error('截图任务已取消');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-chrome-profile-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--disable-quic',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--force-webrtc-ip-handling-policy',
    '--hide-scrollbars',
    `--user-data-dir=${profileDir}`,
    `--window-size=${req.width},${req.height}`,
    `--force-device-scale-factor=${req.scale}`,
    `--screenshot=${req.outputPath}`,
  ];
  if (req.proxyServer) {
    args.push(`--proxy-server=${req.proxyServer}`);
    if (req.proxyBypassList) args.push(`--proxy-bypass-list=${req.proxyBypassList}`);
  }
  if (req.hostResolverRules) {
    args.push(`--host-resolver-rules=${req.hostResolverRules}`);
  }
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
    args.push('--no-sandbox');
  }
  args.push(req.targetUrl);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(req.chromePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8');
      });

      let settled = false;
      let cancelErr: Error | null = null;
      let killEscalation: ReturnType<typeof setTimeout> | null = null;
      let hardWaitTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killEscalation) clearTimeout(killEscalation);
        if (hardWaitTimer) clearTimeout(hardWaitTimer);
        req.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };

      const terminateAndWait = (err: Error) => {
        if (cancelErr || settled) return;
        cancelErr = err;
        clearTimeout(timer);
        killProcessTree(child.pid, 'SIGTERM');
        killEscalation = setTimeout(() => {
          killProcessTree(child.pid, 'SIGKILL');
        }, 1500);
        // 有限宽限期后强制结算，确保不会无限挂起；正常情况下在 close 时即刻结算。
        hardWaitTimer = setTimeout(() => finish(cancelErr ?? err), 3500);
      };

      const onAbort = () => terminateAndWait(new Error('截图任务已取消'));
      const timer = setTimeout(
        () => terminateAndWait(new Error(`无头浏览器截图超时（${req.timeoutMs}ms）`)),
        req.timeoutMs,
      );

      // 先注册子进程事件监听器，再检查 abort，避免遗漏异步 spawn error。
      child.on('error', (err) => finish(cancelErr ?? new Error(`启动无头浏览器失败：${err.message}`)));
      child.on('close', (code) => {
        if (cancelErr) {
          finish(cancelErr);
          return;
        }
        if (code !== 0) {
          finish(new Error(`无头浏览器退出异常（code=${code}）：${stderr.trim().slice(0, 240)}`));
          return;
        }
        if (!fs.existsSync(req.outputPath) || fs.statSync(req.outputPath).size === 0) {
          finish(new Error('无头浏览器未生成有效截图文件'));
          return;
        }
        finish();
      });

      if (req.signal?.aborted) {
        onAbort();
        return;
      }
      req.signal?.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    try {
      removeTree(profileDir);
    } catch {
      // 临时目录清理失败不掩盖主结果
    }
  }
}
