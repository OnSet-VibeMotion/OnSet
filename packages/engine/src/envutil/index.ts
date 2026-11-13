// 环境变量相关的共享工具。移植自 internal/envutil。
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
 */
export function lookPath(name: string, pathValue: string): string {
  if (name.includes(path.sep)) return name;
  for (const dir of pathValue.split(path.delimiter)) {
    const candidate = path.join(dir || '.', name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // 不存在，看下一个目录。
    }
  }
  throw new MissingToolError(name);
}

/** process.env 的副本，去掉值为 undefined 的项。 */
export function envMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  return out;
}

/** 把 map 转成 "KEY=VALUE" 列表。 */
export function envList(values: Record<string, string>): string[] {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`);
}

/** 解析 AM_PASSTHROUGH_ENV 的逗号/空格分隔值。 */
export function parsePassthrough(value: string): string[] {
  return value.split(/[, ]/).filter(Boolean);
}

/** 综合判断是否处于 unsafe 模式。 */
export function isUnsafe(flag: boolean): boolean {
  return flag || process.env.AM_UNSAFE === '1';
}

/**
 * 当前 am 可执行文件的绝对路径（解析符号链接）。TS 版 am 是一个由应用自带 Node 运行的脚本，
 * 「可执行文件」指命令行入口的 shim：由启动方经 AM_SELF 告知；没有时退回 process.argv[1]。
 */
export function amExecutable(): string {
  const self = process.env.AM_SELF || process.argv[1] || process.execPath;
  let executable = path.resolve(self);
  try {
    executable = fs.realpathSync(executable);
  } catch {
    // 解析不了就用原值。
  }
  return executable;
}

/**
 * 把当前 am 所在目录放到 env 的 PATH 首位，并注入 AM_EXECUTABLE：编排工具在提示词里调用的 am
 * 就是启动它的这一个，用户项目里不需要也不应该有 am。am run 与客户端共用。
 */
export function addExecutableLocation(env: Record<string, string>, executable = amExecutable()): void {
  env.AM_EXECUTABLE = executable;
  const directory = path.dirname(executable);
  env.PATH = env.PATH ? directory + path.delimiter + env.PATH : directory;
  appendToolsDir(env);
}

/** 把 am setup 下载的工具目录加在 PATH 末尾：按名字调用 mmx、edge-tts 时能找到，又不盖过用户自己装的同名工具。 */
function appendToolsDir(env: Record<string, string>): void {
  const kept = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '');
  const tools = binDir(env);
  if (tools !== '' && !kept.includes(tools)) kept.push(tools);
  env.PATH = kept.join(path.delimiter);
}

/**
 * 客户端里的编排工具与渲染器用的 PATH：am setup 的工具目录加在末尾，最前面放一个只有 `am` 的目录（agentBinDir），
 * 遮住 PATH 里别处的 am（例如以前装在 ~/.local/bin 的启动脚本）。agent 只能经工具服务调用 am，在终端里跑 am
 * 只会得到一句说明。
 *
 * 不能把有 am 的目录整个拿掉：~/.local/bin 这类目录里还有 claude 等编排工具本身，拿掉后报「缺少必需工具：claude」（实测）。
 */
export function addToolsLocation(env: Record<string, string>): void {
  appendToolsDir(env);
  const blocker = agentBinDir(env);
  if (blocker === '') return;
  const kept = env.PATH.split(path.delimiter).filter((dir) => dir !== '' && dir !== blocker);
  env.PATH = [blocker, ...kept].join(path.delimiter);
}

/** 客户端写出的 am 启动脚本里都有这句话（apps/desktop/src/main/clishim.ts 的 shimScript）。 */
export const ClientShimMarker = '由 ArticleToMotion 客户端写出';

/** agent 的 PATH 里那个 am 的内容：说明 am 不在终端里，退出码 127（与「找不到命令」相同）。 */
export const AgentAmStub = `#!/bin/sh
# 由 ArticleToMotion 写出：编排工具与渲染器的 PATH 最前面的 am，遮住别处的 am。
echo "am 不在终端里使用：制作步骤请调用 am 工具服务（MCP）里的同名工具，参数怎么填用 tool_help 查。" >&2
exit 127
`;

/** 覆盖 agentBinDir 的位置。测试的 vitest setup 指到临时目录：子进程环境按白名单构造，所以也看本进程的环境。 */
export const AgentBinDirEnv = 'AM_AGENT_BIN_DIR';

/** 放那个 am 的目录（<数据目录>/am/agent-bin），按需写好；写不了时返回空串，PATH 照旧。 */
export function agentBinDir(env: Record<string, string | undefined>): string {
  const override = env[AgentBinDirEnv] || process.env[AgentBinDirEnv] || '';
  const data = dataDir(env);
  if (override === '' && data === '') return '';
  const dir = override !== '' ? override : path.join(data, 'agent-bin');
  const file = path.join(dir, 'am');
  try {
    let current = '';
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch {
      // 还没写过。
    }
    if (current !== AgentAmStub) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + '.tmp', AgentAmStub, { mode: 0o755 });
      fs.renameSync(file + '.tmp', file);
    }
    return dir;
  } catch {
    return '';
  }
}

/** am setup 下载的工具放在哪里，覆盖默认的 <数据目录>/am/bin。 */
export const BinDirEnv = 'AM_BIN_DIR';

/** am 的用户级数据目录：XDG_DATA_HOME 或 HOME 下的 .local/share/am。环境里什么都没有时为空。 */
export function dataDir(env: Record<string, string | undefined>): string {
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'am');
  if (env.HOME) return path.join(env.HOME, '.local', 'share', 'am');
  return '';
}

/** am setup 下载的工具目录（默认 <数据目录>/am/bin，BinDirEnv 覆盖）。 */
export function binDir(env: Record<string, string | undefined>): string {
  if (env[BinDirEnv]) return env[BinDirEnv]!;
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'bin');
}
