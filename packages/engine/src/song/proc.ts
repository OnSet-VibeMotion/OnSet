// 外部命令（mmx、python）的最小封装，对应 exec.CommandContext + Run / Output。只供本包内部使用。
import { spawn } from 'node:child_process';
import { start, ExitError } from '../procgroup';

export interface ProcResult {
  /** Go 的 err.Error()：「exit status 1」「signal: killed」；成功为 null。 */
  error: string | null;
  /** 对应 *exec.ExitError：进程跑起来了但非零退出或被信号杀掉。 */
  exited: boolean;
  /** ExitError.ExitCode()：被信号杀掉时为 -1。 */
  exitCode: number;
}

export interface ProcSinks {
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
}

/** 运行命令直到结束；signal 触发时按 Go 的 CommandContext 直接杀掉（SIGKILL）。 */
export function runProcess(command: string, args: string[], env: Record<string, string>, sinks: ProcSinks = {}, signal?: AbortSignal): Promise<ProcResult> {
  if (process.platform === 'win32') return runWindowsProcess(command, args, env, sinks, signal);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ error: 'context canceled', exited: false, exitCode: -1 });
      return;
    }
    const child = spawn(command, args, {
      env,
      signal,
      killSignal: 'SIGKILL',
      stdio: ['ignore', sinks.stdout ? 'pipe' : 'ignore', sinks.stderr ? 'pipe' : 'ignore'],
    });
    if (sinks.stdout) child.stdout?.on('data', sinks.stdout);
    if (sinks.stderr) child.stderr?.on('data', sinks.stderr);
    let settled = false;
    const settle = (r: ProcResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    child.on('error', (e) => {
      if (child.pid === undefined && (e as NodeJS.ErrnoException).code !== 'ABORT_ERR') {
        settle({ error: `fork/exec ${command}: ${e.message}`, exited: false, exitCode: -1 });
      }
    });
    child.on('close', (status, sig) => {
      if (sig) settle({ error: `signal: ${sig === 'SIGKILL' ? 'killed' : sig}`, exited: true, exitCode: -1 });
      else if (status !== 0) settle({ error: `exit status ${status}`, exited: true, exitCode: status ?? -1 });
      else settle({ error: null, exited: false, exitCode: 0 });
    });
  });
}

async function runWindowsProcess(command: string, args: string[], env: Record<string, string>, sinks: ProcSinks, signal?: AbortSignal): Promise<ProcResult> {
  if (signal?.aborted) return {error:'context canceled',exited:false,exitCode:-1};
  try {
    const running=await start(command,args,{env,signal,stdio:['ignore',sinks.stdout?'pipe':'ignore',sinks.stderr?'pipe':'ignore']});
    if(sinks.stdout)running.child.stdout?.on('data',sinks.stdout);
    if(sinks.stderr)running.child.stderr?.on('data',sinks.stderr);
    try {await running.wait();return {error:null,exited:false,exitCode:0};}
    catch(error){
      if(signal?.aborted)return {error:'context canceled',exited:true,exitCode:-1};
      if(error instanceof ExitError)return {error:error.message,exited:true,exitCode:error.exitCode()};
      throw error;
    }
  }catch(error){return {error:`fork/exec ${command}: ${error instanceof Error?error.message:String(error)}`,exited:false,exitCode:-1};}
}

/** cmd.Output()：成功时返回 stdout，失败抛 Error（文案由调用方覆盖）。 */
export async function output(command: string, args: string[], env: Record<string, string>, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const r = await runProcess(command, args, env, { stdout: (c) => chunks.push(c) }, signal);
  if (r.error) throw new Error(r.error);
  return Buffer.concat(chunks);
}
