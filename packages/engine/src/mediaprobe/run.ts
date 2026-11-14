// 子进程的小工具：把 Go 的 cmd.Output() / CombinedOutput() / Run() 与 *exec.ExitError 的文案搬过来。只供本包内部使用。
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { windowsCommand } from '../procgroup/windows';

export interface Ran {
  stdout: Buffer;
  stderr: Buffer;
  /** 与 Go 的 err.Error() 相同的文案（「exit status 1」「signal: killed」）；成功为 null。 */
  error: string | null;
  /** 进程跑起来了但非零退出或被信号杀掉（Go 的 *exec.ExitError）。 */
  exited: boolean;
}

const signalText: Record<string, string> = {
  SIGKILL: 'killed',
  SIGTERM: 'terminated',
  SIGINT: 'interrupt',
  SIGSEGV: 'segmentation fault',
  SIGABRT: 'abort trap',
  SIGPIPE: 'broken pipe',
  SIGHUP: 'hangup',
};

function spawnErrorText(command: string, err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  const text = code === 'ENOENT' ? 'no such file or directory' : code === 'EACCES' ? 'permission denied' : err.message;
  return `fork/exec ${command}: ${text}`;
}

function exitText(status: number | null, signal: NodeJS.Signals | null): string | null {
  if (signal) return `signal: ${signalText[signal] ?? signal}`;
  if (status !== 0) return `exit status ${status}`;
  return null;
}

function fromSync(command: string, result: SpawnSyncReturns<Buffer>): Ran {
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  if (result.error) return { stdout, stderr, error: spawnErrorText(command, result.error), exited: false };
  const error = exitText(result.status, result.signal);
  return { stdout, stderr, error, exited: error !== null };
}

/** 同步运行并收集 stdout 与 stderr。 */
export function run(command: string, args: string[], env: Record<string, string>): Ran {
  if (process.platform === 'win32') {
    const launch = windowsCommand(command, args, env);
    return fromSync(command, spawnSync(launch.file, launch.args, { env: { ...env, ...launch.env }, windowsVerbatimArguments: launch.verbatim, windowsHide: true, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }));
  }
  return fromSync(command, spawnSync(command, args, { env, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }));
}

/** CombinedOutput：stdout 与 stderr 拼在一起。 */
export function combined(ran: Ran): string {
  return Buffer.concat([ran.stdout, ran.stderr]).toString('utf8');
}

/**
 * Go 的 commandError：cmd.Output() 失败时 ExitError 带着 stderr，取它的第一行；
 * 没有 stderr（或进程根本没起来）时用 err.Error()。
 */
export function commandError(ran: Ran, stderrCaptured = true): string {
  if (stderrCaptured && ran.exited && ran.stderr.length > 0) return firstLine(ran.stderr.toString('utf8'));
  return ran.error ?? '';
}

/** 第一行，去掉首尾空白，最多 200 字节；空串写成「无输出」。 */
export function firstLine(value: string): string {
  let trimmed = value.trim();
  const index = trimmed.indexOf('\n');
  if (index >= 0) trimmed = trimmed.slice(0, index);
  const bytes = Buffer.from(trimmed, 'utf8');
  if (bytes.length > 200) trimmed = bytes.subarray(0, 200).toString('utf8');
  return trimmed === '' ? '无输出' : trimmed;
}

/**
 * 异步运行（Go 的 exec.CommandContext）。signal 触发时按 Go 的做法直接杀掉进程（SIGKILL）。
 * captureStdout / captureStderr 为 false 时对应 Go 里没接管的输出（丢进空设备）。
 */
export function runAsync(
  command: string,
  args: string[],
  env: Record<string, string>,
  options: { signal?: AbortSignal; captureStdout?: boolean; captureStderr?: boolean } = {},
): Promise<Ran> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: 'context canceled', exited: false });
      return;
    }
    const launch = process.platform === 'win32' ? windowsCommand(command, args, env) : { file: command, args, env: {} };
    const child = spawn(launch.file, launch.args, {
      env: process.platform === 'win32' ? { ...env, ...launch.env } : env,
      windowsVerbatimArguments: 'verbatim' in launch ? launch.verbatim : undefined,
      windowsHide: process.platform === 'win32' ? true : undefined,
      signal: options.signal,
      killSignal: 'SIGKILL',
      stdio: ['ignore', options.captureStdout ? 'pipe' : 'ignore', options.captureStderr ? 'pipe' : 'ignore'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    let settled = false;
    const settle = (ran: Ran) => {
      if (!settled) {
        settled = true;
        resolve(ran);
      }
    };
    child.on('error', (e) => {
      // 取消时 Node 先报 AbortError，进程随后以 SIGKILL 结束，以 close 事件为准。
      // 进程根本没起来（没有 pid）时不一定还有 close 事件，就地结束。
      if (child.pid === undefined && (e as NodeJS.ErrnoException).code !== 'ABORT_ERR') {
        settle({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: spawnErrorText(command, e), exited: false });
      }
    });
    child.on('close', (status, signal) => {
      const error = exitText(status, signal);
      settle({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), error, exited: error !== null });
    });
  });
}
