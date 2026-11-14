/**
 * 双向协议的编排工具（ACP、codex app-server）共用的进程外壳：起进程、按行喂给 RPCPeer、收标准错误、
 * 进程退出时让还在等的请求失败。协议本身（建会话、发一轮、译事件、答审批）在 acp.ts / codexapp.ts。
 *
 * 只在客户端里、安全模式下用：那里有人能回答审批。onset run（终端）与 --unsafe 仍走一次性的
 * exec / stream-json，见 run.ts。
 */
import { MissingToolError, lookPath as envLookPath } from '../envutil';
import { DefaultGrace, ExitError as ProcessExitError, abortReason, killTree, start } from '../procgroup';
import { newUsage, usageEmpty } from '../tools';
import { KindDone, KindSession, KindText, KindThinking, KindToolCall, KindToolResult, KindUsage, type Event } from './parse';
import { RPCPeer } from './rpc';
import type { Outcome, Result, Spec } from './run';
import { ExitError, TailBuffer } from './run';

/** 用户对一次审批的回答（与 studioview.PermissionResponse 同义，agentrun 不依赖 studioview）。 */
export interface PermissionAnswer {
  decision: 'allow' | 'always' | 'deny' | 'expired';
  message?: string;
}

/** 请用户批准一次调用。toolName 为 Bash 时 input.command 是命令行，界面据此显示与记前缀。 */
export type AskPermission = (toolName: string, input: unknown) => Promise<PermissionAnswer>;

/** 协议驱动要用到的东西。 */
export interface DriveContext {
  peer: RPCPeer;
  spec: Spec;
  emit: (event: Event) => void;
  result: Result;
  signal?: AbortSignal;
  /** 白名单里的命令直接放行，其余交给 spec.ask；不在客户端里（没有 ask）时一律拒绝。 */
  decide: (toolName: string, input: unknown) => Promise<PermissionAnswer>;
  /** 进程退出时 reject，用来与「等这一轮结束」赛跑。 */
  exited: Promise<never>;
}

const stderrTail = 2000;

/**
 * 去掉 shell 包装（bash -lc '…'、/bin/zsh -lc "…"），拿到真正要跑的命令：codex 报给审批的命令常带这层壳，
 * 不去掉的话白名单前缀一个都对不上。
 */
export function unwrapShell(command: string): string {
  const m = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim());
  return m ? m[2] : command.trim();
}

/** 命令是否落在白名单前缀下（与 claude 的 Bash(<前缀>:*) 同义），带 shell 控制符的整条命令不算。 */
export function commandAllowed(command: string, prefixes: readonly string[]): boolean {
  const c = unwrapShell(command);
  if (/[;&|`$<>()\\\n]/.test(c)) return false;
  return prefixes.some((p) => c === p || c.startsWith(p + ' '));
}

/** 起进程、挂好 RPC，交给 drive 跑完一轮；结束后照 run() 的约定发 usage 与 done。 */
export async function runInteractive(
  spec: Spec,
  emit: (event: Event) => void,
  signal: AbortSignal | undefined,
  argv: string[],
  env: Record<string, string> | undefined,
  drive: (ctx: DriveContext) => Promise<void>,
): Promise<Outcome> {
  const empty: Result = { sessionID: '', usage: newUsage(), model: '', exitCode: 0, started: false, produced: false, stderr: '' };
  const lookPath = spec.lookPath ?? ((name: string) => envLookPath(name, (env ?? process.env).PATH ?? ''));
  let binary: string;
  try {
    binary = lookPath(argv[0]);
  } catch {
    return { result: empty, error: new MissingToolError(argv[0]) };
  }
  let started;
  try {
    started = await start(binary, argv.slice(1), { cwd: spec.workdir || undefined, env, stdio: ['pipe', 'pipe', 'pipe'], signal }, DefaultGrace);
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    return { result: empty, error: new Error(`启动编排工具：${cause.message}`, { cause }) };
  }
  const { child } = started;
  const result: Result = { ...empty, started: true };
  const stderr = new TailBuffer(stderrTail);
  child.stderr!.on('data', (chunk: Buffer) => stderr.write(chunk));
  const peer = new RPCPeer(child.stdin!, spec.raw ? (dir, line) => spec.raw!.write((dir === 'out' ? '> ' : '') + line + '\n') : undefined);
  let pending = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    pending += chunk;
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      peer.handleLine(line);
    }
  });
  let waitErr: unknown = null;
  const waited = started.wait().then(
    () => undefined,
    (err) => {
      waitErr = err;
    },
  );
  const exited = waited.then(() => {
    const err = new Error(stderr.toString() || '编排工具提前退出');
    peer.close(err);
    throw err;
  }) as Promise<never>;
  exited.catch(() => {});

  const wrappedEmit = (event: Event) => {
    if (event.kind === KindSession) result.sessionID = event.session_id ?? result.sessionID;
    if (event.kind === KindText || event.kind === KindThinking || event.kind === KindToolCall || event.kind === KindToolResult) result.produced = true;
    emit(event);
  };
  const decide = async (toolName: string, input: unknown): Promise<PermissionAnswer> => {
    const command = toolName === 'Bash' && input && typeof input === 'object' ? String((input as { command?: unknown }).command ?? '') : '';
    if (command !== '' && commandAllowed(command, spec.access?.commands ?? [])) return { decision: 'allow' };
    if (!spec.ask) return { decision: 'deny', message: '安全模式下不能运行这条命令，也没有人能批准它。' };
    return spec.ask(toolName, input);
  };

  let driveErr: Error | null = null;
  try {
    await drive({ peer, spec, emit: wrappedEmit, result, signal, decide, exited });
  } catch (err) {
    driveErr = err instanceof Error ? err : new Error(String(err));
  }
  // 一轮结束：这类工具是常驻服务，不会自己退出。
  child.stdin?.end();
  if (!child.killed && child.exitCode === null) {
    if (child.pid === undefined || !killTree(child.pid, 'SIGTERM')) child.kill('SIGTERM');
  }
  await waited;
  if (pending !== '') peer.handleLine(pending);
  result.stderr = stderr.toString();
  if (!usageEmpty(result.usage)) emit({ kind: KindUsage, usage: { ...result.usage } });
  emit({ kind: KindDone, session_id: result.sessionID });
  if (signal?.aborted) return { result, error: abortReason(signal) };
  if (driveErr) {
    if (waitErr instanceof ProcessExitError && waitErr.code > 0) {
      result.exitCode = waitErr.code;
      return { result, error: new ExitError(result.exitCode, result.stderr || driveErr.message) };
    }
    return { result, error: driveErr };
  }
  return { result, error: null };
}
