import crypto from 'node:crypto';
import { withWindowsInstructions } from '../windowsruntime';
import { MissingToolError, lookPath as envLookPath } from '../envutil';
import { DefaultGrace, ExitError as ProcessExitError, abortReason, start } from '../procgroup';
import { detectModel, interactiveInvocation, type McpServer, newUsage, orchestratorInvocation, presetSessionID, usageEmpty, type OrchestratorAccess, type PermissionPrompt, type Usage, type AgentOptions } from '../tools';
import { runACP } from './acp';
import { runCodexApp } from './codexapp';
import type { AskPermission } from './interactive';
import { KindDone, KindSession, KindText, KindThinking, KindToolCall, KindToolResult, KindUsage, newParser, type Event, type PlanItem } from './parse';

/** 一次编排调用。 */
export interface Spec {
  tool: string;
  workdir?: string;
  prompt: string;
  unsafe?: boolean;
  /** sessionID 与 resume 的含义同 tools.OrchestratorOptions。 */
  sessionID?: string;
  resume?: boolean;
  access?: OrchestratorAccess;
  /** 见 tools.OrchestratorOptions.permissionPrompt。 */
  permissionPrompt?: PermissionPrompt;
  /** onset 的工具服务（客户端里给）：五家都挂上，编排工具只经它调用 onset。 */
  toolsServer?: McpServer;
  /** 模型；空用那家工具自己的默认（tools.modelArgs）。 */
  model?: string;
  /** 调用选项（推理强度、快速模式、上下文长度，tools/options.ts）；空用那家工具自己的默认。 */
  options?: AgentOptions;
  /**
   * 请用户批准一次调用（客户端里给）。给了且是安全模式时，codebuddy、opencode、codex 改用双向协议
   * （tools.interactiveInvocation），白名单外的调用经它问用户；claude、qoder 经 permissionPrompt 的审批 MCP。
   */
  ask?: AskPermission;
  /**
   * 子进程的完整环境，由调用方按安全模式白名单算好。Go 里是 KEY=VALUE 列表，
   * 这里是 map；不给时继承当前进程环境（与 Go 的 nil Env 相同）。
   */
  env?: Record<string, string>;
  /** 解析 argv[0]；找不到时抛错。为空时按 env（或当前进程）的 PATH 用 envutil.lookPath 查找。 */
  lookPath?: (name: string) => string;
  /** 续接时上一轮最后的任务清单（带编号的项），逐条改的任务工具（TaskUpdate）才接得上。 */
  plan?: PlanItem[];
  /** 若给出，原样写入每一行输出（带换行），供排查格式变化。 */
  raw?: { write(chunk: string): unknown };
}

/** 一次调用结束后的汇总。 */
export interface Result {
  sessionID: string;
  usage: Usage;
  /**
   * 输出流里报出的模型名（claude / qoder / codebuddy 的 system/init），
   * 读不到时为空，由调用方按工具配置补。
   */
  model: string;
  exitCode: number;
  /** 进程起来了。没起来（找不到工具、参数不合法）的调用不花钱，不记账。 */
  started: boolean;
  /**
   * 流里出现过正文、思考或工具事件。续接失败时 CLI 往往只打一行
   * 错误就退出，调用方据此决定要不要开新会话重试。
   */
  produced: boolean;
  /** 标准错误的末尾，失败时用来给人看原因。 */
  stderr: string;
}

/**
 * Go 的 Run 同时返回 Result 与 error：出错时 Result 仍有用（Started 决定记不记账、
 * Produced 决定要不要开新会话重试、Usage 照样入账）。所以这里不抛错，两样一起返回；
 * error 为 null 表示成功。
 */
export interface Outcome {
  result: Result;
  error: Error | null;
}

/** 编排工具以非零退出码结束。 */
export class ExitError extends Error {
  constructor(
    readonly code: number,
    readonly stderr: string,
  ) {
    super(stderr !== '' ? `编排工具退出码 ${code}：${stderr}` : `编排工具退出码 ${code}`);
    this.name = 'ExitError';
  }
}

/** 为支持预先指定会话的工具生成一个新 id（UUID v4），其余工具返回空串。 */
export function newSessionID(tool: string): string {
  if (!presetSessionID(tool)) return '';
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const stderrTail = 2000;

/** 去掉不合法的 UTF-8 序列（对应 bytes.ToValidUTF8(b, nil)）。 */
function toValidUTF8(buf: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    let n = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (c < 0x80) n = 1;
    else if (c >= 0xc2 && c <= 0xdf) n = 2;
    else if (c >= 0xe0 && c <= 0xef) {
      n = 3;
      if (c === 0xe0) lo = 0xa0;
      if (c === 0xed) hi = 0x9f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      n = 4;
      if (c === 0xf0) lo = 0x90;
      if (c === 0xf4) hi = 0x8f;
    }
    let ok = n > 0 && i + n <= buf.length;
    for (let k = 1; ok && k < n; k++) {
      const b = buf[i + k];
      const min = k === 1 ? lo : 0x80;
      const max = k === 1 ? hi : 0xbf;
      if (b < min || b > max) ok = false;
    }
    if (ok) {
      for (let k = 0; k < n; k++) out.push(buf[i + k]);
      i += n;
    } else i++;
  }
  return Buffer.from(out);
}

/** 只保留最后 n 个字节。 */
export class TailBuffer {
  private buf = Buffer.alloc(0);

  constructor(readonly n: number) {}

  write(p: Buffer | string): number {
    const chunk = typeof p === 'string' ? Buffer.from(p, 'utf8') : p;
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > this.n) this.buf = this.buf.subarray(this.buf.length - this.n);
    return chunk.length;
  }

  toString(): string {
    return toValidUTF8(this.buf).toString('utf8').trim();
  }
}

function emptyResult(): Result {
  return { sessionID: '', usage: newUsage(), model: '', exitCode: 0, started: false, produced: false, stderr: '' };
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * 启动编排工具，逐条回调事件，直到进程结束。
 *
 * 最后一定会收到一条 KindDone；用量读得到时在它之前还有一条 KindUsage。
 * signal 取消时整组终止，error 是取消原因（对应 ctx.Err()）。
 */
export async function run(spec: Spec, emit: (event: Event) => void, signal?: AbortSignal): Promise<Outcome> {
  if (process.platform === 'win32' && spec.toolsServer?.name === 'onset') spec = { ...spec, prompt: withWindowsInstructions(spec.prompt, 'orchestrator') };
  if (spec.ask) {
    const base = spec.env ?? (process.env as Record<string, string>);
    const inter = interactiveInvocation(spec.tool, { unsafe: spec.unsafe, access: spec.access, toolsServer: spec.toolsServer, model: spec.model, options: spec.options }, base);
    if (inter) {
      const env = { ...base, ...inter.env };
      return inter.protocol === 'acp' ? runACP(spec, emit, signal, inter.argv, env) : runCodexApp(spec, emit, signal, inter.argv, env);
    }
  }
  let parser;
  let argv: string[];
  let stdin: string;
  let extraEnv: Record<string, string> = {};
  try {
    parser = newParser(spec.tool);
    if (spec.resume && spec.plan) parser.seedPlan(spec.plan);
    ({ argv, stdin, env: extraEnv = {} } = orchestratorInvocation(spec.tool, {
      workdir: spec.workdir,
      prompt: spec.prompt,
      unsafe: spec.unsafe,
      sessionID: spec.sessionID,
      resume: spec.resume,
      access: spec.access,
      permissionPrompt: spec.permissionPrompt,
      toolsServer: spec.toolsServer,
      model: spec.model,
      options: spec.options,
    }, spec.env ?? (process.env as Record<string, string>)));
  } catch (err) {
    return { result: emptyResult(), error: asError(err) };
  }
  const lookPath = spec.lookPath ?? ((name: string) => envLookPath(name, (spec.env ?? process.env).PATH ?? ''));
  let binary: string;
  try {
    binary = lookPath(argv[0]);
  } catch {
    return { result: emptyResult(), error: new MissingToolError(argv[0]) };
  }
  let started;
  try {
    started = await start(
      binary,
      argv.slice(1),
      {
        cwd: spec.workdir || undefined,
        env: Object.keys(extraEnv).length > 0 ? { ...(spec.env ?? (process.env as Record<string, string>)), ...extraEnv } : spec.env,
        stdio: [stdin !== '' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        signal,
      },
      DefaultGrace,
    );
  } catch (err) {
    const cause = asError(err);
    return { result: emptyResult(), error: new Error(`启动编排工具：${cause.message}`, { cause }) };
  }
  const { child } = started;
  if (stdin !== '' && child.stdin) {
    // 进程不读 stdin 就退出时写入会 EPIPE，与 Go 一样不当作错误。
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  }
  const stderr = new TailBuffer(stderrTail);
  child.stderr!.on('data', (chunk: Buffer) => stderr.write(chunk));

  // 预先指定的 id 不等流里回报，先发出去：调用方要立刻把它落盘，进程中途崩了也能续接。
  if (spec.sessionID) {
    parser.session = spec.sessionID;
    emit({ kind: KindSession, session_id: spec.sessionID });
  }
  const result: Result = { ...emptyResult(), started: true };
  let pending = '';
  const handleLine = (line: string) => {
    // bufio.ScanLines 去掉行尾的 \r。
    if (line.endsWith('\r')) line = line.slice(0, -1);
    spec.raw?.write(line + '\n');
    if (result.model === '') result.model = detectModel(spec.tool, line);
    for (const event of parser.parse(line)) {
      if (event.kind === KindText || event.kind === KindThinking || event.kind === KindToolCall || event.kind === KindToolResult) {
        result.produced = true;
      }
      emit(event);
    }
  };
  const stdout = child.stdout!;
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    pending += chunk;
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      handleLine(line);
    }
  });
  let waitErr: unknown = null;
  try {
    await started.wait();
  } catch (err) {
    waitErr = err;
  }
  if (pending !== '') handleLine(pending);

  result.sessionID = parser.sessionID();
  result.usage = parser.usage();
  result.stderr = stderr.toString();
  if (!usageEmpty(result.usage)) emit({ kind: KindUsage, usage: { ...result.usage } });
  const finish = (error: Error | null): Outcome => {
    emit({ kind: KindDone, session_id: result.sessionID });
    return { result, error };
  };
  if (signal?.aborted) return finish(abortReason(signal));
  if (waitErr) {
    if (waitErr instanceof ProcessExitError) {
      result.exitCode = waitErr.code;
      return finish(new ExitError(result.exitCode, result.stderr));
    }
    return finish(asError(waitErr));
  }
  return finish(null);
}
