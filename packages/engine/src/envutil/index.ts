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
}
