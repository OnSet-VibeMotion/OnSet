// 包内共用的小工具：错误文案、Go 的 %q / %v 写法、跑外部命令。
import { spawn } from 'node:child_process';
import { ExitError, abortReason } from '../procgroup';
import type { Writer } from './progress';

/** 错误的文字（对应 %v / %w 的展开）。 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Go 的 %q：带引号、转义的字符串。可打印的非 ASCII 字符原样保留，与 strconv.Quote 一致。 */
export function goQuote(s: string): string {
  return JSON.stringify(s);
}

/** Go 对 []string 的 %v：[a b c]。 */
export function goList(values: string[]): string {
  return '[' + values.join(' ') + ']';
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** 标准输出接到这里；不给时收集起来作为返回值（对应 cmd.Output()）。 */
  stdout?: Writer;
  /** 标准错误接到这里；不给时丢弃。 */
  stderr?: Writer;
  signal?: AbortSignal;
}

/**
 * 跑一个外部命令并等它结束，对应 exec.CommandContext(...).Output() / Run()。
 * 返回收集到的标准输出（去掉首尾空白之前的原文）；非零退出抛 procgroup.ExitError
 * （文案与 Go 的 *exec.ExitError 相同：exit status N）；signal 取消时杀掉进程（SIGKILL，
 * 与 CommandContext 相同）并抛取消原因。
 */
export function runCommand(file: string, args: string[], options: CommandOptions = {}): Promise<string> {
  const { signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', options.stderr ? 'pipe' : 'ignore'],
    });
    let out = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (options.stdout) options.stdout.write(chunk);
      else out += chunk;
    });
    if (options.stderr) {
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => options.stderr!.write(chunk));
    }
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    let failed = false;
    child.once('error', (err) => {
      failed = true;
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (failed) return;
      if (signal?.aborted) reject(abortReason(signal));
      else if (sig) reject(new ExitError(-1, sig));
      else if (code !== 0) reject(new ExitError(code ?? -1, null));
      else resolve(out);
    });
  });
}
