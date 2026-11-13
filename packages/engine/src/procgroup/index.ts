// 移植自 internal/procgroup（Go 版只在 darwin / linux 上编译）。
//
// 以独立进程组启动外部 AI CLI，并在取消时整组终止。
//
// AI CLI 会再拉起 node、npx、ffmpeg 这类子进程。只杀直接子进程的话，孙进程会被
// 托管给 init 继续跑，渲染器在后台接着写文件、占 CPU，下一次尝试和它抢同一个目录。
// 所以统一开新进程组（Node 的 detached: true 在 Unix 上是 setsid，进程组号即 pid），
// 取消时对 -pid 发信号。
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** SIGTERM 之后等进程自行退出的时间（毫秒），超时改发 SIGKILL。 */
export const DefaultGrace = 500;

/**
 * 进程以非零退出码或被信号终止时 wait 抛出的错误，对应 Go 的 *exec.ExitError。
 * code 与 ExitCode() 一致：被信号杀掉时为 -1。
 */
export class ExitError extends Error {
  constructor(
    readonly code: number,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(signal ? `signal: ${signal}` : `exit status ${code}`);
    this.name = 'ExitError';
  }

  exitCode(): number {
    return this.code;
  }
}

export interface StartOptions extends Omit<SpawnOptions, 'detached' | 'signal'> {
  /** 取消信号，对应 Go 的 ctx。 */
  signal?: AbortSignal;
}

export interface Started {
  child: ChildProcess;
  /**
   * 等进程结束且输出管道关闭（对应 exec.Cmd.Wait）。非零退出抛 ExitError。
   * 只调用一次；调用方要在挂好输出读取之后再等。
   */
  wait(): Promise<void>;
}

/** signal 的取消原因，统一成 Error（对应 ctx.Err()）。 */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason === undefined ? 'context canceled' : String(reason));
  err.name = 'AbortError';
  return err;
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // 进程组已经不在了。
  }
}

/**
 * 以独立进程组启动 file。signal 取消时先对整组发 SIGTERM，grace 毫秒内没退出再发 SIGKILL。
 * 启动失败（找不到可执行文件等）时抛错。
 */
export function start(file: string, args: string[], options: StartOptions = {}, grace = DefaultGrace): Promise<Started> {
  const { signal, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, { ...spawnOptions, detached: true });
    } catch (err) {
      reject(err);
      return;
    }
    let finished = false;
    const closed = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((done) => {
      child.on('close', (code, sig) => {
        finished = true;
        done({ code, sig });
      });
    });
    child.once('error', (err) => {
      if (child.pid === undefined) reject(err);
    });
    child.once('spawn', () => {
      const pid = child.pid!;
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        killGroup(pid, 'SIGTERM');
        timer = setTimeout(() => {
          if (!finished) killGroup(pid, 'SIGKILL');
        }, grace);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      let waited = false;
      resolve({
        child,
        wait: async () => {
          if (waited) throw new Error('procgroup: wait 只能调用一次');
          waited = true;
          const { code, sig } = await closed;
          signal?.removeEventListener('abort', onAbort);
          if (timer) clearTimeout(timer);
          if (sig) throw new ExitError(-1, sig);
          if (code !== 0) throw new ExitError(code ?? -1, null);
        },
      });
    });
  });
}

/** 启动 file 并等它结束。signal 取消时抛取消原因，而不是进程被信号杀掉的错误。 */
export async function run(file: string, args: string[], options: StartOptions = {}, grace = DefaultGrace): Promise<void> {
  const started = await start(file, args, options, grace);
  let err: unknown;
  try {
    await started.wait();
  } catch (e) {
    err = e;
  }
  if (options.signal?.aborted) throw abortReason(options.signal);
  if (err) throw err;
}
