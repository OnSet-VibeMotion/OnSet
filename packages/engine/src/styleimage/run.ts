// 子进程的小工具：对应 Go 的 cmd.CombinedOutput() 与 *exec.ExitError 的文案。只供本包内部使用。
import { spawnSync } from 'node:child_process';

export interface RunResult {
  /** stdout 与 stderr 拼在一起（Go 的 CombinedOutput）。 */
  output: string;
  /** 失败时与 Go 的 err.Error() 相同的文案（「exit status 3」）；成功为 null。 */
  error: string | null;
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

export function combinedOutput(command: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(command, args, { env, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString('utf8');
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const text = code === 'ENOENT' ? 'no such file or directory' : code === 'EACCES' ? 'permission denied' : result.error.message;
    return { output, error: `fork/exec ${command}: ${text}` };
  }
  if (result.signal) return { output, error: `signal: ${signalText[result.signal] ?? result.signal}` };
  if (result.status !== 0) return { output, error: `exit status ${result.status}` };
  return { output, error: null };
}

const errnoText: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EISDIR: 'is a directory',
  ENOTDIR: 'not a directory',
  ELOOP: 'too many levels of symbolic links',
  EEXIST: 'file exists',
};

/** 把 Node 的文件系统错误写成 Go *PathError 的样子：「open /x: no such file or directory」。 */
export function pathError(op: string, file: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  // Go 里读目录是 open 成功、read 失败。
  if (code === 'EISDIR' && op === 'open') op = 'read';
  const text = (code && errnoText[code]) || (err instanceof Error ? err.message : String(err));
  return `${op} ${file}: ${text}`;
}
