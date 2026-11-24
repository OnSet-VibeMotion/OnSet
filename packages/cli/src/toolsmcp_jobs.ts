/**
 * onset 工具服务的执行进程管理、等待策略与输出精简（供 toolsmcp.ts 与制作人共用）。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as director from '@onset/engine/director';
import { parseWorkerOutput, visibleText, workerArgs } from '@onset/engine/opworker';
import { groupSpawnOptions, killTree } from '@onset/engine/procgroup';
import { nodeCommand } from '@onset/engine/toolpath';
import { compactHyperFrames, hyperFramesProgress } from './hfoutput';
import type { ParamValues } from './ops/op';
import { toolOutputArchiveDir } from './output_archive';

/** 一次调用最多等多久（秒）：codex 的 MCP 调用默认 60 秒超时，留出余量。 */
export const DefaultWaitSeconds = 50;

/**
 * 一次调用最多真等多久（秒）。缺省 600；起服务的一方确认客户端能等更久时经 ONSET_TOOLS_MAX_WAIT 放宽
 * （claude、codex 是 50 分钟，见 tools.LongToolWaitSeconds），编排等整批渲染时就不用每 10 分钟醒来轮询一次。
 */
export function maxWaitSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const wait = Number(env.ONSET_TOOLS_MAX_WAIT ?? '');
  return Number.isFinite(wait) && wait >= 60 ? Math.min(wait, 3600) : 600;
}

/** 批量派发先回任务号，让编排能做并行工作。接着等或单次直跑类长任务用已确认的客户端等待能力，减少无谓 job_wait 轮询。 */
export function defaultWaitSeconds(name: string, env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.ONSET_TOOLS_MAX_WAIT ?? '');
  if (!Number.isFinite(configured) || configured < 60) return DefaultWaitSeconds;
  return name === 'job_wait' ||
    name === 'align_run' ||
    name === 'audio_mix' ||
    name === 'voice_synthesize' ||
    name === 'concat' ||
    name === 'scene_preview_check'
    ? maxWaitSeconds(env)
    : DefaultWaitSeconds;
}

/** 返回给 agent 的输出上限：过长时落盘保存完整输出并保留结尾（错误与结论通常在最后）。 */
const maxOutputChars = 8_000;
/** 结构化结果附在文字后面的上限；更大的只给 structuredContent。 */
const maxInlineDataChars = 4_000;

/** 起一个执行进程跑一条操作；由调用方注入，测试换成假的。 */
export type Spawner = (name: string, params: ParamValues) => ChildProcess;

/** 执行进程的命令行与环境（spawnOp 用；单独拿出来是为了测「客户端里要带 ELECTRON_RUN_AS_NODE」）。 */
export function opCommand(name: string, params: ParamValues): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const command = nodeCommand(process.argv[1] ?? '', workerArgs(name, params));
  return { file: command.file, args: command.args, env: { ...process.env, ...command.env } };
}

/**
 * 用 onset 自己的运行时、自己的入口文件执行：客户端里是 Electron 当 Node，不经 PATH 找 onset。
 *
 * 必须经 nodeCommand 补回 ELECTRON_RUN_AS_NODE=1：main.ts 一启动就把它从 process.env 里删掉了（不能漏给 agent），
 * 直接用 process.env 起的执行进程会是一个完整的 Electron 应用——操作照样跑完、结果照样打印，但进程永远不退出，
 * 工具服务一直等不到 close，每次调用都报「还在运行」直到超时（2026-11 实测，只在客户端里出现，终端的 Node 下没事）。
 */
export const spawnOp: Spawner = (name, params) => {
  const command = opCommand(name, params);
  return spawn(command.file, command.args, {
    cwd: process.cwd(),
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 各成进程组，取消时整组结束（Windows 上按进程树，见 procgroup）。
    ...groupSpawnOptions(),
  });
};

/**
 * 制作人（onset studio agent）用的执行进程：会再起制作人的操作（director.KeyOps，整理经验）经 stdin 拿到制作人在用的
 * 模型服务（含 key），其余与 spawnOp 相同。执行进程解不开客户端加密的服务文件，只能由手里有它的进程往下交。
 */
export function spawnOpWithService(service: director.ResolvedService | null): Spawner {
  return (name, params) => {
    if (!director.KeyOps.has(name) || !service) return spawnOp(name, params);
    const command = opCommand(name, params);
    const child = spawn(command.file, command.args, {
      cwd: process.cwd(),
      env: { ...command.env, [director.ServiceStdinEnv]: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...groupSpawnOptions(),
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(JSON.stringify(service) + '\n');
    return child;
  };
}

export interface Job {
  id: string;
  /** 操作名：hyperframes 的输出要精简（hfoutput.ts）。 */
  name: string;
  report: string;
  child: ChildProcess;
  output: string;
  /** 已经交给 agent 的文字长度：job_wait 只给新的部分。 */
  delivered: number;
  code: number | null;
  done: Promise<void>;
}

export interface Reply {
  text: string;
  isError: boolean;
  data?: unknown;
}

/** 报告落盘或目录型输出时，工具回复只带结论、异常和验收入口，避免重复塞入大 JSON。 */
function resultForAgent(name: string, report: string, raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const data = raw as Record<string, unknown>;
  if (name === 'film_style_list' && Array.isArray(data.styles)) {
    return {
      count: data.styles.length,
      ...(data.default ? { default: data.default } : {}),
      ...(Array.isArray(data.extras) && data.extras.length ? { extras: data.extras } : {}),
    };
  }
  if (report === '') return raw;
  if (name === 'audio_check') {
    const { speech: _speech, cues: _cues, ...summary } = data;
    return { ...summary, report };
  }
  if (name === 'review') {
    const { cuts: _cuts, sheets, seams, ...summary } = data;
    const images = (items: unknown) =>
      Array.isArray(items) ? items.map((item) => ({ image: item.image })) : undefined;
    return { ...summary, sheets: images(sheets), seams: images(seams), report };
  }
  if (name === 'scene_run_all' && Array.isArray(data.scenes)) {
    const actionable = data.scenes.filter((item) => item.status === 'stale' || item.status === 'failed');
    return { ...data, scenes: actionable, report };
  }
  if (name === 'scene_frames_batch' && Array.isArray(data.scenes)) {
    const flagged = data.scenes.filter((item: { ok?: boolean }) => item.ok === false);
    return { ...data, scenes: flagged, report };
  }
  return raw;
}

const runningHint = (id: string) =>
  `[还在运行：任务 ${id}。用 job_wait 接着等，或 job_cancel 停掉。结束本轮对话会终止仍在运行的任务；不要用定时任务接管，必须在本轮持续 job_wait 直到完成或明确失败]`;

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private next = 1;

  constructor(
    private readonly spawner: Spawner,
    private readonly archiveDir: string | (() => string) = toolOutputArchiveDir,
  ) {}

  start(name: string, params: ParamValues): Job {
    const child = this.spawner(name, params);
    const report = String(
      params.report_json || (name === 'review' && params.out ? path.join(String(params.out), 'review.json') : ''),
    );
    const job: Job = {
      id: `job-${this.next++}`,
      name,
      report,
      child,
      output: '',
      delivered: 0,
      code: null,
      done: Promise.resolve(),
    };
    const take = (chunk: Buffer | string) => {
      job.output += chunk.toString();
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    job.done = new Promise((resolve) => {
      child.on('error', (err) => {
        job.output += `\n${err.message}\n`;
        job.code = 127;
        resolve();
      });
      child.on('close', (code, signal) => {
        job.code = code ?? (signal ? 130 : 1);
        resolve();
      });
    });
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  activeCount(name?: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.code === null && (!name || job.name === name)) count++;
    }
    return count;
  }

  /** 外部 MCP 有调用超时；内置制作人直接等到完成或取消。 */
  async wait(job: Job, seconds: number | undefined, signal?: AbortSignal): Promise<Reply> {
    let timer: NodeJS.Timeout | undefined;
    const waiting = [job.done];
    if (seconds !== undefined) {
      const ms = Math.min(Math.max(seconds, 0), maxWaitSeconds()) * 1000;
      waiting.push(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      );
    }
    let abort: (() => void) | undefined;
    if (signal && !signal.aborted) {
      waiting.push(
        new Promise<void>((resolve) => {
          abort = resolve;
          signal.addEventListener('abort', abort, { once: true });
        }),
      );
    }
    try {
      if (!signal?.aborted) await Promise.race(waiting);
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
    const compact = job.name === 'hyperframes';
    if (compact && job.code === null) {
      // 半截日志不交出去：跑完再一次给精简后的结果，这里只说进度。
      const progress = hyperFramesProgress(visibleText(job.output));
      return { text: `${progress ? progress + '\n' : ''}${runningHint(job.id)}`, isError: false };
    }
    const visible = compact ? compactedOutput(visibleText(job.output)) : visibleText(job.output);
    const fresh = visible.slice(job.delivered);
    job.delivered = visible.length;
    const body = clip(fresh, typeof this.archiveDir === 'function' ? this.archiveDir() : this.archiveDir);
    const sep = body.endsWith('\n') || body === '' ? '' : '\n';
    if (job.code === null) return { text: `${body}${sep}${runningHint(job.id)}`, isError: false };
    this.jobs.delete(job.id);
    const { result } = parseWorkerOutput(job.output);
    if (!result) return { text: `${body}${sep}[执行进程意外退出，退出码 ${job.code}]`, isError: true };
    if (!result.ok) return { text: `${body}${sep}[失败] ${result.error ?? ''}`.trimEnd(), isError: true };
    let text = `${body}${sep}[完成]`;
    const data = resultForAgent(job.name, job.report, result.data);
    if (data !== undefined) {
      const json = JSON.stringify(data);
      // 正文可解析为 JSON 且与结构化结果相同时（例如 --json 模式），不再追加重复的「结果：…」行；
      // 普通方括号日志（如 [scene-002] …）和截短提示（[前面 …]）照常追加。
      const bodyTrim = body.trim();
      let alreadyJSON = false;
      if (bodyTrim.startsWith('{') || bodyTrim.startsWith('[')) {
        try {
          alreadyJSON = JSON.stringify(JSON.parse(bodyTrim)) === json;
        } catch {
          alreadyJSON = false;
        }
      }
      if (json.length <= maxInlineDataChars && !alreadyJSON) text += `\n结果：${json}`;
    }
    return { text, isError: false, data };
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.code !== null) return false;
    killGroup(job.child);
    return true;
  }

  /** MCP 进程退出前停掉全部还在跑的任务：子进程各成进程组，不显式结束会留在后台。 */
  stopAll(): void {
    for (const job of this.jobs.values()) if (job.code === null) killGroup(job.child);
  }
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (!killTree(child.pid, 'SIGTERM')) child.kill('SIGTERM');
}

/** 精简 hyperframes 的输出；删了东西时把原样输出写进临时文件，末尾给路径，要细看时去读。 */
function compactedOutput(full: string): string {
  const { text, trimmed } = compactHyperFrames(full);
  if (!trimmed) return text;
  try {
    const dir = path.join(os.tmpdir(), 'onset-hyperframes');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const file = path.join(dir, `${stamp}.log`);
    fs.writeFileSync(file, full);
    return `${text}\n（已略去进度与调试日志；完整输出：${file}）\n`;
  } catch {
    return `${text}\n（已略去进度与调试日志）\n`;
  }
}

function clip(text: string, archiveDir = toolOutputArchiveDir()): string {
  if (text.length <= maxOutputChars) return text;
  let saved = '';
  try {
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const file = path.join(archiveDir, `${stamp}.log`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    saved = `；完整输出：${file}`;
  } catch {
    // 写临时文件失败时照常截短。
  }
  return `[前面 ${text.length - maxOutputChars} 个字符略去${saved}]\n` + text.slice(-maxOutputChars);
}
