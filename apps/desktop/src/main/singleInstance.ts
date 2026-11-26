/**
 * 单实例锁的构建身份比对与陈旧进程检测（纯逻辑，不依赖 Electron，单测在 singleInstance.test.ts）。
 *
 * macOS/Windows 上多份 .app / exe 或原地覆盖更新后的客户端共用同一个 userData 单实例锁。
 * 若旧进程常驻内存，磁盘上的 app.asar 与 assets/ 已被新版替换，再打开新版客户端时，
 * 仅把旧窗口提到前台会让用户继续停在旧 JS 进程里——旧进程读到新 assets/ 里的新占位符（如 {{MOTION_MENU}}）
 * 就会在开工时报错。这里在 second-instance 与开工出错时识别构建差异，空闲直接切到新版，忙碌先请用户确认。
 */
import fs from 'node:fs';
import path from 'node:path';
import { busyLines } from './updatestate';

export interface InstanceIdentity {
  execPath: string;
  appPath: string;
  /** 打包态指向 app.asar，开发态指向 out/main.js，用来识别磁盘上的代码包是否已换新。 */
  bundlePath: string;
  version: string;
  packaged: boolean;
  /** `${ino}:${size}:${mtimeMs}`；读取失败为空串。 */
  bundleSignature: string;
  /** relaunch 时传给新实例的参数：打包态为空数组，开发态保留应用目录。 */
  relaunchArgs: string[];
}

export type SecondInstanceDecision =
  | { kind: 'focus' }
  | { kind: 'switch'; target: { execPath: string; args: string[] }; reason: string }
  | { kind: 'confirm_switch'; target: { execPath: string; args: string[] }; reason: string; busy: string[] };

/** 主进程启动后按当前构建位置自动写入的环境变量；跨构建 relaunch 前需清掉非外部显式传入的项。 */
export const RelaunchAutoEnvKeys = [
  'ONSET_ASSETS_DIR',
  'ONSET_SELF',
  'ONSET_NPM_CLI',
  'ONSET_BROWSER',
  'ONSET_BROWSER_APP_ARG',
] as const;

/** 记录进程启动时由外部显式传入的环境变量键名（须在 main.ts 自动补写之前调用）。 */
export function captureExplicitRelaunchEnv(env: Record<string, string | undefined>): ReadonlySet<string> {
  const explicit = new Set<string>();
  for (const key of RelaunchAutoEnvKeys) {
    if (typeof env[key] === 'string' && env[key] !== '') explicit.add(key);
  }
  return explicit;
}

/** 跨构建 relaunch 前清理当前构建自动写入的路径变量，让新进程按自身目录重新计算，同时保留外部显式覆盖。 */
export function sanitizeRelaunchEnv(env: Record<string, string | undefined>, explicitKeys: ReadonlySet<string>): void {
  for (const key of RelaunchAutoEnvKeys) {
    if (!explicitKeys.has(key)) delete env[key];
  }
}

function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * 读取磁盘上真实文件（如 app.asar）的签名，临时打开 process.noAsar 绕过 Electron 的 ASAR 虚拟文件系统，
 * 确保拿到的是归档文件本身的 inode / size / mtime，而不是虚拟目录元数据。
 */
export function readBundleSignature(targetPath: string): string {
  if (!targetPath) return '';
  const proc = process as NodeJS.Process & { noAsar?: boolean };
  const prev = proc.noAsar;
  try {
    proc.noAsar = true;
    const stat = fs.statSync(targetPath);
    return `${stat.ino}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return '';
  } finally {
    proc.noAsar = prev;
  }
}

export function currentInstanceIdentity(opts: {
  execPath: string;
  appPath: string;
  version: string;
  packaged: boolean;
  mainFile: string;
  readSignature?: (targetPath: string) => string;
}): InstanceIdentity {
  const execPath = canonicalPath(opts.execPath);
  const appPath = canonicalPath(opts.appPath);
  const bundlePath = opts.packaged ? appPath : canonicalPath(opts.mainFile);
  const read = opts.readSignature ?? readBundleSignature;
  return {
    execPath,
    appPath,
    bundlePath,
    version: opts.version,
    packaged: opts.packaged,
    bundleSignature: read(bundlePath),
    relaunchArgs: opts.packaged ? [] : [appPath],
  };
}

export function parseIncomingIdentity(raw: unknown): InstanceIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.execPath !== 'string' ||
    typeof obj.appPath !== 'string' ||
    typeof obj.bundlePath !== 'string' ||
    typeof obj.version !== 'string' ||
    typeof obj.packaged !== 'boolean' ||
    typeof obj.bundleSignature !== 'string' ||
    !Array.isArray(obj.relaunchArgs) ||
    !obj.relaunchArgs.every((arg) => typeof arg === 'string')
  ) {
    return null;
  }
  return {
    execPath: obj.execPath,
    appPath: obj.appPath,
    bundlePath: obj.bundlePath,
    version: obj.version,
    packaged: obj.packaged,
    bundleSignature: obj.bundleSignature,
    relaunchArgs: [...obj.relaunchArgs],
  };
}

export function isSameInstanceBuild(self: InstanceIdentity, incoming: InstanceIdentity): boolean {
  if (self.execPath !== incoming.execPath || self.appPath !== incoming.appPath || self.packaged !== incoming.packaged) {
    return false;
  }
  if (self.bundleSignature !== '' && incoming.bundleSignature !== '') {
    return self.bundleSignature === incoming.bundleSignature;
  }
  return self.version === incoming.version;
}

export function isBundleStaleOnDisk(
  self: InstanceIdentity,
  readSignature: (targetPath: string) => string = readBundleSignature,
): boolean {
  if (self.bundleSignature === '') return false;
  const onDisk = readSignature(self.bundlePath);
  return onDisk !== '' && onDisk !== self.bundleSignature;
}

export function decideSecondInstance(opts: {
  self: InstanceIdentity;
  incoming: InstanceIdentity | null;
  onDiskSignature: string;
  activeWork: { project: string; holder: string }[];
  background: boolean;
}): SecondInstanceDecision {
  if (opts.background) return { kind: 'focus' };
  const { self, incoming, onDiskSignature, activeWork } = opts;
  const selfStale = self.bundleSignature !== '' && onDiskSignature !== '' && onDiskSignature !== self.bundleSignature;

  let target: { execPath: string; args: string[] } | null = null;
  let reason = '';
  if (incoming && !isSameInstanceBuild(self, incoming)) {
    target = { execPath: incoming.execPath, args: incoming.relaunchArgs };
    reason =
      incoming.execPath !== self.execPath ? '你刚打开了另一路径的片场客户端' : '磁盘上的片场客户端已更新或重新构建';
  } else if (selfStale) {
    target = { execPath: self.execPath, args: self.relaunchArgs };
    reason = '磁盘上的片场客户端文件已被替换，当前窗口仍停留在更新前的旧进程';
  }
  if (!target) return { kind: 'focus' };

  const busy = busyLines(activeWork);
  if (busy.length > 0) return { kind: 'confirm_switch', target, reason, busy };
  return { kind: 'switch', target, reason };
}

/** 当前进程磁盘包已被替换且开工接口返回错误时，在错误消息前补上可执行的重启提示。 */
export function decorateStaleStartError(rawBody: string, stale: boolean): string {
  if (!stale) return rawBody;
  const hint = '当前片场窗口运行的是更新前的旧进程（磁盘上的应用文件已变化），请完全退出片场后重新打开再试。';
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
      return JSON.stringify({ ...parsed, message: `${hint}（原始错误：${parsed.message}）` });
    }
  } catch {
    // 非 JSON 响应保持原样。
  }
  return rawBody;
}
