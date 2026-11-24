import fs from 'node:fs';
import path from 'node:path';
import { KindError, KindSession, KindText, KindToolCall, newParser } from '../agentrun';
import * as director from '../director';
import { lookPath } from '../envutil';
import * as hyperframes from '../hyperframes';
import { ExitError, type Started, start } from '../procgroup';
import {
  accumulateUsage,
  detectModel,
  extractUserMessages,
  type Invocation,
  newUsage,
  type Usage,
  usageAdd,
  usageEmpty,
} from '../tools';
import type { Attempt } from './attempt';
import { RenderHandoffMessage } from './resume';
import { sandboxReadDirs, TerminateGrace } from './run_encode';
import { rendererHome, sandboxed, sandboxProfile } from './sandbox';
import type { Scene } from './scene';

/** bufio.Scanner 的最大单行长度：超过时 Go 报「token too long」。 */
const maxLineBytes = 4 * 1024 * 1024;

export class RendererFailure extends Error {}
export class RenderLogError extends Error {}

export interface ConfineParams {
  s: Scene;
  renderer: string;
  projectRoot: string;
  osSandbox: boolean;
  baseEnv: Record<string, string>;
  childEnv: Record<string, string>;
  cliEnv: Record<string, string>;
  resolvedSkills: Record<string, string>;
}

export function buildConfine(params: ConfineParams): (command: Invocation) => Invocation {
  const { s, renderer, projectRoot, osSandbox, baseEnv, childEnv, cliEnv, resolvedSkills } = params;
  return (command: Invocation): Invocation => {
    const argv = command.argv;
    argv[0] = lookPath(argv[0], baseEnv.PATH ?? '');
    if (!osSandbox) return { ...command, argv };
    const home = childEnv.HOME ?? baseEnv.HOME ?? '';
    const own = rendererHome(renderer, home);
    const profile = sandboxProfile({
      sceneDir: s.directory,
      projectRoot,
      env: { ...baseEnv, ...childEnv },
      toolStateDirs: [
        ...(home ? own.state : []),
        ...(renderer === director.Tool
          ? [director.rendererDir(director.defaultDir({ ...process.env, ...baseEnv }))]
          : []),
      ],
      toolStateFiles: home ? own.files : [],
      hiddenDirs: home ? own.hidden : [],
      ...(s.audition
        ? {
            isolatedProject: {
              readDirs: [
                ...Object.values(resolvedSkills).filter(Boolean),
                path.join(projectRoot, '.onset/resources'),
                ...(s.exemplars?.dirs ?? []),
              ],
              readFiles: [path.join(projectRoot, 'onset.conf'), path.join(projectRoot, 'onset.flow.json')],
            },
          }
        : {}),
      readDirs: sandboxReadDirs(argv[0], childEnv, cliEnv, s.exemplars?.dirs ?? []),
    });
    return { ...command, argv: sandboxed(argv, profile) };
  };
}

export interface CompositionContext {
  s: Scene;
  cliEnv: Record<string, string>;
  childEnv: Record<string, string>;
  confine: (command: Invocation) => Invocation;
  signal?: AbortSignal;
}

/** 第一层：onset 自己用固定版本的 HyperFrames CLI 渲染镜头目录里的合成，不用模型。 */
export async function renderComposition(
  ctx: CompositionContext,
  stderrFile: number,
  output = ctx.s.output,
  normalHandoff = false,
): Promise<void> {
  const { s, cliEnv, childEnv, confine, signal } = ctx;
  const args = ['render', '--output', output, ...(s.renderWorkers > 0 ? ['--workers', String(s.renderWorkers)] : [])];
  const cli = hyperframes.requireCLI(cliEnv);
  const renderEnv = normalHandoff
    ? { ...childEnv, [hyperframes.BrowserEnv]: hyperframes.requireBrowser(cliEnv) }
    : cliEnv;
  const spec = hyperframes.cliCommandFor(cli, renderEnv, args);
  // 直接渲染也是选手代码的执行，不能绕开试镜隔离去读取其他选手的文件。
  const invocation: Invocation = { argv: [spec.file, ...spec.args], env: spec.env, stdin: '' };
  const command = s.audition || normalHandoff ? confine(invocation) : invocation;
  const logging = new AbortController();
  const renderSignal = signal ? AbortSignal.any([signal, logging.signal]) : logging.signal;
  const started = await start(
    command.argv[0],
    command.argv.slice(1),
    { cwd: s.directory, env: command.env, stdio: ['ignore', stderrFile, 'pipe'], signal: renderSignal },
    TerminateGrace,
  );
  let tail = '';
  started.child.stderr!.setEncoding('utf8');
  started.child.stderr!.on('data', (chunk: string) => {
    if (logging.signal.aborted) return;
    try {
      fs.writeSync(stderrFile, chunk);
    } catch (err) {
      logging.abort(new RenderLogError(`写入 HyperFrames 渲染日志失败：${(err as Error).message}`, { cause: err }));
      return;
    }
    tail = (tail + chunk).slice(-4000);
  });
  try {
    await started.wait();
  } catch (e) {
    logging.signal.throwIfAborted();
    if (signal?.aborted) throw new Error('已中断：渲染进程组已终止');
    const reason = e instanceof ExitError ? `HyperFrames 渲染退出码 ${e.code}` : (e as Error).message;
    throw new Error(tail.trim() ? `${reason}\n${tail.trim()}` : reason, { cause: e });
  }
  logging.signal.throwIfAborted();
}

export interface SpawnRendererContext {
  s: Scene;
  renderer: string;
  childEnv: Record<string, string>;
  attempt: Attempt;
  usage: Usage;
  signal?: AbortSignal;
  show: (message: string, userFile: number) => void;
  state: { handoff: boolean };
}

/** 跑一次渲染器；返回它说了几句话、调了几次工具（0 表示根本没开始）。失败时抛出的错误也带着这个数（events）。 */
export async function spawnRenderer(
  ctx: SpawnRendererContext,
  command: Invocation,
  rawFile: number,
  stderrFile: number,
  userFile: number,
): Promise<number> {
  const { s, renderer, childEnv, attempt, usage, signal, show, state } = ctx;
  state.handoff = false;
  const callUsage = newUsage();
  callUsage.baseline = usage.baseline;
  let events = 0;
  let failure = '';
  const parser = newParser(renderer);
  const fail = (e: Error): Error => Object.assign(e, { events });
  let started: Started;
  try {
    started = await start(
      command.argv[0],
      command.argv.slice(1),
      {
        cwd: s.directory,
        env: { ...childEnv, ...command.env },
        stdio: [command.stdin ? 'pipe' : 'ignore', 'pipe', stderrFile],
        signal,
      },
      TerminateGrace,
    );
    if (command.stdin && started.child.stdin) {
      started.child.stdin.on('error', () => {});
      started.child.stdin.end(command.stdin);
    }
  } catch (e) {
    throw new Error(`启动渲染器：${(e as Error).message}`, { cause: e });
  }
  let pending: Buffer = Buffer.alloc(0);
  let scanError: Error | null = null;
  const handleLine = (raw: Buffer) => {
    if (scanError) return;
    // bufio.ScanLines 去掉行尾的 \r。
    let line = raw.toString('utf8');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    fs.writeSync(rawFile, line + '\n');
    accumulateUsage(renderer, line, callUsage);
    const model = detectModel(renderer, line);
    if (model !== '') attempt.model = model;
    for (const message of extractUserMessages(renderer, line)) {
      if (message.trim() === RenderHandoffMessage) state.handoff = true;
      show(message, userFile);
    }
    for (const e of parser.parse(line)) {
      if (e.kind === KindError && e.text) failure = e.text.slice(0, 8000);
      if (e.kind === KindSession && e.session_id) attempt.session_id = e.session_id;
      if (e.kind === KindText || e.kind === KindToolCall) events++;
    }
    // 有的工具先报告一次可恢复的请求错误，随后明确完成本轮；不要把它误当最终失败。
    if (failure) {
      try {
        const result = JSON.parse(line);
        if (
          result.type === 'turn.completed' ||
          (result.type === 'result' && result.is_error === false) ||
          (result.event === 'result' && result.result?.status === 'SUCCESS')
        )
          failure = '';
      } catch {
        /* 普通文本不改变服务错误。 */
      }
    }
  };
  started.child.stdout!.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let index: number;
    while ((index = pending.indexOf(0x0a)) >= 0) {
      handleLine(pending.subarray(0, index));
      pending = pending.subarray(index + 1);
    }
    if (pending.length > maxLineBytes && !scanError) scanError = new Error('bufio.Scanner: token too long');
    if (scanError) pending = Buffer.alloc(0);
  });
  let waitErr: unknown = null;
  try {
    await started.wait();
  } catch (e) {
    waitErr = e;
  }
  if (pending.length > 0) handleLine(pending);
  if (events > 0 || !usageEmpty(callUsage)) usageAdd(usage, callUsage);
  if (callUsage.session_total) usage.session_total = callUsage.session_total;
  if (signal?.aborted) throw fail(new Error('已中断：渲染器进程组已终止'));
  if (scanError) throw fail(new Error(`读取渲染器输出：${(scanError as Error).message}`));
  if (waitErr !== null) {
    if (waitErr instanceof ExitError) {
      attempt.exit_code = waitErr.code;
      throw fail(new RendererFailure(failure || `渲染器退出码 ${waitErr.code}`));
    }
    throw fail(waitErr as Error);
  }
  attempt.exit_code = 0;
  if (failure !== '') throw fail(new RendererFailure(failure));
  return events;
}
