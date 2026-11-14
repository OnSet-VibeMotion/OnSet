// Windows 上启动与结束子进程的差异，集中在这里。
//
// 1. npm 装的 CLI（claude、codex、opencode……）在 Windows 上是 `.cmd` 包装。Node 出于安全原因不让直接 spawn
//    `.cmd` / `.bat`（报 EINVAL），只能经 cmd.exe；而 cmd.exe 传不了多行参数，提示词、MCP 配置正是多行或带引号的。
//    所以 npm 生成的包装（cmd-shim）读出它要跑的 JS 入口，直接用 node 跑，与包装本身做的事一样；
//    别的 .cmd / .bat 才经 cmd.exe，并按 cmd 的规则转义，遇到多行参数直接报错，不让它被悄悄截断。
// 2. Windows 没有进程组信号：`process.kill(-pid)` 不存在，结束整棵进程树要用 `taskkill /T /F`。
//    `detached: true` 在 Windows 上的意思是「给子进程一个新的控制台」，会弹出黑窗口，所以那里不用它。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MissingToolError, lookPath } from '../envutil';

export interface Command {
  file: string;
  args: string[];
  /** 要并进环境的变量。 */
  env: Record<string, string>;
  /** 参数已经按 cmd.exe 的规则拼好，spawn 时要带 windowsVerbatimArguments，不能让 Node 再加一层引号。 */
  verbatim?: boolean;
}

/** npm cmd-shim 里 JS 入口的写法：`"%dp0%\node_modules\…\cli.js"`（npm 7 起）或 `"%~dp0\…"`（更早）。 */
const shimEntry = /"%(?:~dp0|dp0%)\\([^"]+?\.(?:c|m)?js)"/i;

/** 读出 npm cmd-shim 指向的 JS 入口；不是 cmd-shim 时返回空串。 */
export function cmdShimEntry(file: string, read: (file: string) => string = (f) => fs.readFileSync(f, 'utf8')): string {
  let text = '';
  try {
    text = read(file);
  } catch {
    return '';
  }
  const match = shimEntry.exec(text);
  return match ? path.win32.join(path.win32.dirname(file), match[1]) : '';
}

/** cmd.exe 里有特殊含义、要用 ^ 转义的字符（与 cross-spawn 相同）。 */
const metaChars = /([()\][%!^"`<>&|;, *?])/g;

/** 按 Windows 的命令行规则加引号，再按 cmd.exe 的规则转义（cross-spawn 的 escapeArgument）。 */
export function cmdArgument(arg: string): string {
  let out = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1');
  out = `"${out}"`;
  return out.replace(metaChars, '^$1');
}

/**
 * Windows 上怎么启动 file：不是 .cmd / .bat 时原样；npm 的包装改成用 node 跑它的入口；其余经 cmd.exe。
 * env 是子进程的环境，用来找 node 与 ComSpec。
 */
export function windowsCommand(file: string, args: string[], env: Record<string, string | undefined>): Command {
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args, env: {} };
  const entry = cmdShimEntry(file);
  if (entry !== '') {
    // 包装自己先找同目录的 node.exe，再找 PATH 里的 node；都没有时用 onset 自己的运行时。
    const local = path.win32.join(path.win32.dirname(file), 'node.exe');
    if (fs.existsSync(local)) return { file: local, args: [entry, ...args], env: {} };
    try {
      return { file: lookPath('node', env.PATH ?? '', 'win32', env.PATHEXT ?? ''), args: [entry, ...args], env: {} };
    } catch (err) {
      if (!(err instanceof MissingToolError)) throw err;
    }
    return { file: process.execPath, args: [entry, ...args], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
  }
  for (const arg of args) {
    if (/[\r\n]/.test(arg)) throw new Error(`${path.win32.basename(file)} 是批处理文件，Windows 上经它启动的程序收不到多行参数；请改装这个工具的 .exe 版本`);
  }
  const line = [cmdArgument(file), ...args.map(cmdArgument)].join(' ');
  const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || 'cmd.exe';
  // /d 不跑 AutoRun，/s 与外层引号让 cmd 原样保留里面的引号。
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], env: {}, verbatim: true };
}

/** 结束 pid 这一整棵进程树。Windows 上没有温和的结束方式，taskkill /T /F 直接结束。 */
export function killWindowsTree(pid: number): boolean {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}
