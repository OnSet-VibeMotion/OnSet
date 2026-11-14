/**
 * 渲染器的系统沙箱（macOS 的 sandbox-exec，Seatbelt）：边界是目录，不是命令白名单。
 *
 * 命令白名单管不住脚本：放行 python3 就等于放行它读写任何文件。渲染器又确实需要跑自己写的小脚本
 * （裁图、量像素、看上一次的末帧），白名单下这些全被拒、白白耗掉几轮（2026-11 实测 qoder 一个镜头 41 次调用里 6 次被拒）。
 * 所以在进程外面套一层系统沙箱，它对渲染器和它起的每一个子进程都生效：
 *
 * - 写：只有镜头目录、临时目录与渲染工具自己的状态目录（会话、日志）。
 * - 读：家目录里只有本项目、渲染工具自己的目录、onset 的数据目录、~/Library（系统框架与字体要读）
 *   与工具所在的目录；别的项目、~/.ssh、~/.aws 这些都读不到。任何 `.env` 与导演的凭据目录一律不能读。
 * - 网络不限：模型服务、字体与 CDN 都要连。
 *
 * 规则按真实路径匹配，所以镜头目录里指向技能的符号链接（stageRendererSkills）只能读、改不了真文件。
 * 2026-11 实测在这层沙箱里 `hyperframes render`（借客户端 Chromium）照常出片。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../envutil';

/** 系统自带的 sandbox-exec；只有 macOS 有。 */
export const SandboxExec = '/usr/bin/sandbox-exec';

export function sandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && fs.existsSync(SandboxExec);
}

export interface SandboxPaths {
  /** 镜头目录：唯一能写的项目目录。 */
  sceneDir: string;
  /** 项目根：技能、整片风格、字幕都在这里，整个能读。 */
  projectRoot: string;
  env: Record<string, string | undefined>;
  /** 渲染工具自己的状态目录（会话、日志、缓存），要能读写，例如 ~/.qoder-cn。 */
  toolStateDirs: string[];
  /** 另外要能读的目录：渲染工具、onset 运行时、浏览器所在的地方。 */
  readDirs: string[];
}

/** 真实路径：/var 是 /private/var 的链接，Seatbelt 按真实路径匹配。不存在的照原样。 */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function quote(p: string): string {
  return '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function unique(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => p !== '' && p !== '/').map(real))].sort();
}

/** 家目录里的 PATH 项（asdf、~/.local/bin……）：渲染器跑的命令从这里来，读不到就起不来。 */
function homePathEntries(env: SandboxPaths['env'], home: string): string[] {
  const out: string[] = [];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const resolved = real(dir);
    if (resolved.startsWith(home + path.sep)) out.push(resolved);
  }
  return out;
}

/** 生成 sandbox-exec 的规则文本（SBPL）。后写的规则优先，所以先整体禁止，再逐项放开，最后再收回凭据。 */
export function sandboxProfile(p: SandboxPaths): string {
  const home = real(p.env.HOME ?? '');
  const data = dataDir(p.env);
  const tmp = unique([p.env.TMPDIR ?? '', '/private/tmp', '/private/var/folders']);
  // HyperFrames 渲染要读写自己的缓存（~/.cache/hyperframes），读不到就直接 EPERM 退出（实测）。
  const caches = home ? [path.join(home, '.cache', 'hyperframes')] : [];
  const writable = unique([p.sceneDir, ...tmp, ...p.toolStateDirs, ...caches]);
  const readable = unique([
    p.projectRoot,
    ...p.toolStateDirs,
    ...caches,
    data,
    home ? path.join(home, 'Library') : '',
    ...p.readDirs,
    ...(home ? homePathEntries(p.env, home) : []),
  ]);
  const secrets = unique([data ? path.join(data, 'agent') : '', p.env.ONSET_AGENT_DIR ?? '']);
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...writable.map((d) => `  (subpath ${quote(d)})`),
    '  (regex #"^/dev/"))',
  ];
  if (home) {
    lines.push(`(deny file-read-data (subpath ${quote(home)}))`, '(allow file-read-data', ...readable.map((d) => `  (subpath ${quote(d)})`), ')');
  }
  // 凭据最后收回。读要写成 file-read-data：Seatbelt 里同一路径上更具体的操作压过 file-read*，
  // 写成 file-read* 的话前面放开项目目录的 allow file-read-data 照样让 .env 读得到（实测）。
  lines.push('(deny file-read-data file-write*', '  (regex #"/\\.env$")', '  (regex #"/\\.env\\.[^/]*$")', ...secrets.map((d) => `  (subpath ${quote(d)})`), ')');
  return lines.join('\n') + '\n';
}

/** 把渲染器的命令行套进沙箱。argv[0] 要已经是绝对路径（lookPath 之后）。 */
export function sandboxed(argv: string[], profile: string): string[] {
  return [SandboxExec, '-p', profile, ...argv];
}
