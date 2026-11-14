// 环境变量相关的共享工具。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 「外部命令不存在」这类错误的固定前缀。cli 靠这个子串把错误映射成退出码 127，
 * 所以它是跨包的契约而不是文案：解析外部命令失败的地方都必须用 lookPath 或复用这个前缀。
 */
export const MissingToolPrefix = '缺少必需工具';

export class MissingToolError extends Error {
  constructor(readonly tool: string) {
    super(`${MissingToolPrefix}：${tool}`);
  }
}

/**
 * 在给定的 PATH 值里查找可执行文件，不读进程自身的 PATH：安全模式下子进程的 PATH 是受控白名单，
 * 按父进程的 PATH 找到的程序子进程未必能执行。名字里已经带路径分隔符时原样返回。
 *
 * Windows 上没有执行权限位（stat 的 mode 永远不带 0o111），可执行与否看扩展名：名字没带扩展名时按
 * PATHEXT（缺省 .COM;.EXE;.BAT;.CMD）逐个试，`claude` 找到的是 `claude.exe` 或 npm 装的 `claude.cmd`。
 */
export function lookPath(name: string, pathValue: string, platform: NodeJS.Platform = process.platform, pathext: string = process.env.PATHEXT ?? ''): string {
  const windows = platform === 'win32';
  if (name.includes('/') || (windows && name.includes('\\'))) return name;
  const exts = windows ? windowsExtensions(name, pathext) : [''];
  for (const dir of pathValue.split(windows ? ';' : ':')) {
    for (const ext of exts) {
      const candidate = path.join(dir || '.', name + ext);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (windows || (stat.mode & 0o111) !== 0)) return candidate;
      } catch {
        // 不存在，看下一个。
      }
    }
  }
  throw new MissingToolError(name);
}

/** Windows 上要试的扩展名：名字已经带了 PATHEXT 里的扩展名就只试它本身。 */
function windowsExtensions(name: string, pathext: string): string[] {
  const exts = (pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const own = path.win32.extname(name).toLowerCase();
  if (own !== '' && exts.includes(own)) return [''];
  return exts;
}

/** process.env 的副本，去掉值为 undefined 的项。 */
export function envMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  return normalizeWindowsEnv(out);
}

/**
 * Windows 的环境变量名不分大小写，PATH 在那里通常叫 `Path`。process.env 自己能按 `PATH` 取到，可一旦拷进普通对象，
 * `env.PATH` 就是 undefined——引擎里到处按 `env.PATH` 读写。所以拷贝时把 PATH 的名字统一成大写（只留一份）。
 */
export function normalizeWindowsEnv(env: Record<string, string>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== 'win32') return env;
  for (const key of Object.keys(env)) {
    if (key !== 'PATH' && key.toUpperCase() === 'PATH') {
      if (env.PATH === undefined) env.PATH = env[key];
      delete env[key];
    }
  }
  return env;
}

/** 把 map 转成 "KEY=VALUE" 列表。 */
export function envList(values: Record<string, string>): string[] {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`);
}

/** 解析 ONSET_PASSTHROUGH_ENV 的逗号/空格分隔值。 */
export function parsePassthrough(value: string): string[] {
  return value.split(/[, ]/).filter(Boolean);
}

/** 综合判断是否处于 unsafe 模式。 */
export function isUnsafe(flag: boolean): boolean {
  return flag || process.env.ONSET_UNSAFE === '1';
}

/**
 * 当前 onset 可执行文件的绝对路径（解析符号链接）。TS 版 onset 是一个由应用自带 Node 运行的脚本，
 * 「可执行文件」指命令行入口的 shim：由启动方经 ONSET_SELF 告知；没有时退回 process.argv[1]。
 */
export function onsetExecutable(): string {
  const self = process.env.ONSET_SELF || process.argv[1] || process.execPath;
  let executable = path.resolve(self);
  try {
    executable = fs.realpathSync(executable);
  } catch {
    // 解析不了就用原值。
  }
  return executable;
}

/**
 * Windows 程序离不开的系统变量。不是凭据，但缺了 SystemRoot 时 Node、Python 的网络与加密直接失败，
 * 缺了 USERPROFILE / APPDATA / LOCALAPPDATA 各家 CLI 找不到登录态与数据目录，缺了 PATHEXT 按名字找不到 .exe / .cmd。
 * 安全模式的白名单（config.childEnvironment）与 onset 工具服务的环境（tools.onsetToolsServer）都带上它们；
 * macOS / Linux 上没有这些变量，不影响。
 */
export const WindowsBaseEnvKeys = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
];

/** 启动 onset 的命令：文件、前置参数与要并进环境的变量。 */
export interface AmCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** onset 的入口是一个 JS 脚本（onset.cjs），而不是 shim。 */
function isScript(file: string): boolean {
  return /\.(c|m)?js$/i.test(file);
}

/**
 * 怎么启动 onset。macOS / Linux 上 executable 是客户端写的 shim（或开发时的 onset 脚本），直接运行；
 * Windows 上客户端不写 shim（.cmd 不能直接 spawn，经 cmd.exe 又要转义提示词），executable 就是 onset.cjs，
 * 用当前运行时跑它：客户端里是 Electron（带 ELECTRON_RUN_AS_NODE=1），终端里是运行 onset 的 Node。
 * shim 里写死的几个变量（资产目录、自带 npm）这时要显式带上，MCP 服务的环境不一定从父进程继承。
 */
export function onsetCommand(executable: string = onsetExecutable()): AmCommand {
  if (!isScript(executable)) return { command: executable, args: [], env: {} };
  const env: Record<string, string> = {};
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  for (const key of ['ONSET_ASSETS_DIR', 'ONSET_NPM_CLI', 'ONSET_BUNDLED_BIN']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.ONSET_SELF = executable;
  return { command: process.execPath, args: [executable], env };
}

/**
 * 把当前 onset 所在目录放到 env 的 PATH 首位，并注入 ONSET_EXECUTABLE：编排工具在提示词里调用的 onset
 * 就是启动它的这一个，用户项目里不需要也不应该有 onset。onset run 与客户端共用。
 */
export function addExecutableLocation(env: Record<string, string>, executable = onsetExecutable()): void {
  env.ONSET_EXECUTABLE = executable;
  const directory = path.dirname(executable);
  env.PATH = env.PATH ? directory + path.delimiter + env.PATH : directory;
  appendToolsDir(env);
}

/** 把 onset setup 下载的工具目录加在 PATH 末尾：按名字调用 mmx、edge-tts 时能找到，又不盖过用户自己装的同名工具。 */
function appendToolsDir(env: Record<string, string>): void {
  const kept = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '');
  const tools = binDir(env);
  if (tools !== '' && !kept.includes(tools)) kept.push(tools);
  env.PATH = kept.join(path.delimiter);
}

/**
 * 客户端里的编排工具与渲染器用的 PATH：onset setup 的工具目录加在末尾，最前面放一个只有 `onset` 的目录（agentBinDir），
 * 遮住 PATH 里别处的 onset（例如以前装在 ~/.local/bin 的启动脚本）。agent 只能经工具服务调用 onset，在终端里跑 onset
 * 只会得到一句说明。
 *
 * 不能把有 onset 的目录整个拿掉：~/.local/bin 这类目录里还有 claude 等编排工具本身，拿掉后报「缺少必需工具：claude」（实测）。
 */
export function addToolsLocation(env: Record<string, string>): void {
  appendToolsDir(env);
  const blocker = agentBinDir(env);
  if (blocker === '') return;
  const kept = env.PATH.split(path.delimiter).filter((dir) => dir !== '' && dir !== blocker);
  env.PATH = [blocker, ...kept].join(path.delimiter);
}

/** 客户端写出的 onset 启动脚本里都有这句话（apps/desktop/src/main/clishim.ts 的 shimScript）。 */
export const ClientShimMarker = '由片场客户端写出';

/** agent 的 PATH 里那个 onset 的内容：说明 onset 不在终端里，退出码 127（与「找不到命令」相同）。 */
export const AgentAmStub = `#!/bin/sh
# 由片场写出：编排工具与渲染器的 PATH 最前面的 onset，遮住别处的 onset。
echo "onset 不在终端里使用：制作步骤请调用 onset 工具服务（MCP）里的同名工具，参数怎么填用 tool_help 查。" >&2
exit 127
`;

/**
 * Windows 上的那个 onset（onset.cmd）：意思相同，退出码同样是 127。批处理按系统代码页（中文 Windows 是 GBK）解析，
 * 写 UTF-8 的中文会乱码，所以只用 ASCII。
 */
export const AgentAmStubWindows = [
  '@echo off',
  'rem Written by OnSet: shadows any other onset on the PATH of the orchestrator and renderer.',
  'echo onset is not a terminal command here: call the tool with the same name in the onset MCP tool service; use tool_help for its parameters. 1>&2',
  'exit /b 127',
  '',
].join('\r\n');

/** 覆盖 agentBinDir 的位置。测试的 vitest setup 指到临时目录：子进程环境按白名单构造，所以也看本进程的环境。 */
export const AgentBinDirEnv = 'ONSET_AGENT_BIN_DIR';

/** 放那个 onset 的目录（<数据目录>/onset/agent-bin），按需写好；写不了时返回空串，PATH 照旧。 */
export function agentBinDir(env: Record<string, string | undefined>): string {
  const override = env[AgentBinDirEnv] || process.env[AgentBinDirEnv] || '';
  const data = dataDir(env);
  if (override === '' && data === '') return '';
  const dir = override !== '' ? override : path.join(data, 'agent-bin');
  const windows = process.platform === 'win32';
  const file = path.join(dir, windows ? 'onset.cmd' : 'onset');
  const body = windows ? AgentAmStubWindows : AgentAmStub;
  try {
    let current = '';
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch {
      // 还没写过。
    }
    if (current !== body) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + '.tmp', body, { mode: 0o755 });
      fs.renameSync(file + '.tmp', file);
    }
    return dir;
  } catch {
    return '';
  }
}

/** onset setup 下载的工具放在哪里，覆盖默认的 <数据目录>/onset/bin。 */
export const BinDirEnv = 'ONSET_BIN_DIR';

/**
 * onset 的用户级数据目录：XDG_DATA_HOME 或 HOME 下的 .local/share/onset；Windows 上是 %LOCALAPPDATA%\onset
 * （那里通常没有 HOME）。环境里什么都没有时为空。子进程要算出同一个目录，所以这几个变量都在
 * config.childEnvironment 的白名单里。
 */
export function dataDir(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string {
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'onset');
  if (platform === 'win32' && env.LOCALAPPDATA) return path.win32.join(env.LOCALAPPDATA, 'onset');
  if (env.HOME) return path.join(env.HOME, '.local', 'share', 'onset');
  return '';
}

/** onset setup 下载的工具目录（默认 <数据目录>/onset/bin，BinDirEnv 覆盖）。 */
export function binDir(env: Record<string, string | undefined>): string {
  if (env[BinDirEnv]) return env[BinDirEnv]!;
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'bin');
}
