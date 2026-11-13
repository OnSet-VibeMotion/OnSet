/**
 * am 的工具服务（MCP，stdio）：客户端里的编排工具与渲染器只经它调用 am 的能力，不在 Bash 里跑 am。
 *
 * 以前 am 在它们的 PATH 里，缺信息时它们会 `which am`、`strings "$(which am)"` 反推格式（实测两次），
 * 每次都撞白名单、弹审批卡片打断用户。现在 am 没有对外的命令行：工具直接来自操作表（ops/op.ts），
 * 工具名、具名参数、说明与例子都是操作自己定义的，结果是操作写下的文字加结构化的 data。
 *
 * 每次调用起一个执行进程（`am.cjs __op <名字> <参数>`，同一个运行时、同一个 am.cjs）：并发调用、
 * 环境变量互不影响，取消时整组结束。MCP 客户端多有调用超时（codex 默认 60 秒），而渲染、拼接动辄
 * 几分钟到几小时，所以每次最多等 wait_seconds；没跑完就返回任务号与已有输出，由 job_wait 接着等、
 * job_cancel 停掉。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as flow from '@am/engine/flow';
import { parseWorkerOutput, visibleText, workerArgs } from '@am/engine/opworker';
import { groupSpawnOptions, killTree } from '@am/engine/procgroup';
import { nodeCommand } from '@am/engine/toolpath';
import './cli';
import { allOps, normalizeParams, type Op, opScopes, type ParamSpec, type ParamValues } from './ops/op';

/** 档位：编排工具拿全部工具，渲染器只拿 hyperframes。 */
export type Profile = 'orchestrator' | 'renderer';

/** MCP 配置里给这个服务起的名字；claude 系的工具全名是 mcp__am__<工具名>。 */
export const ToolsServerName = 'am';

/** hyperframes 工具放行的子命令：本机渲染与只读检查。远端渲染、改动已装技能、交互与遥测命令一律不给。 */
export const HyperFramesSubcommands = ['lint', 'check', 'validate', 'inspect', 'snapshot', 'keyframes', 'render', 'timeline', 'compositions', 'info', 'docs'] as const;

/** 一次调用最多等多久（秒）：codex 的 MCP 调用默认 60 秒超时，留出余量。 */
export const DefaultWaitSeconds = 50;
const maxWaitSeconds = 600;

/** 返回给 agent 的输出上限：过长时截掉开头、留结尾（错误与结论通常在最后）。 */
const maxOutputChars = 24_000;
/** 结构化结果附在文字后面的上限；更大的只给 structuredContent。 */
const maxInlineDataChars = 12_000;

interface JSONSchema {
  type: string;
  description?: string;
  items?: JSONSchema;
  enum?: readonly string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 一个工具：来自一条操作，或是服务自己的 job_wait / job_cancel / tool_help。 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  /** 对应的操作；任务工具为空。 */
  op?: Op;
  /** tool_help 返回的完整说明。 */
  help: string;
  /** 第三方站的操作：执行时落到 station_run。 */
  external?: { station: string; op: string };
}

/** 参数说明只留第一句：完整的在 tool_help 里，列表要短。 */
function firstSentence(text: string): string {
  const m = /^[^。；;\n]*/.exec(text);
  const head = (m ? m[0] : text).trim();
  return head.length > 80 ? head.slice(0, 80) + '…' : head;
}

function defaultNote(spec: ParamSpec): string {
  const d = spec.default;
  if (d === undefined || d === '' || d === false || d === 0 || (Array.isArray(d) && d.length === 0)) return '';
  return `（缺省 ${Array.isArray(d) ? d.join(',') : String(d)}）`;
}

function paramSchema(op: Op, key: string, spec: ParamSpec): JSONSchema {
  const description = firstSentence(spec.description) + defaultNote(spec);
  if (op.name === 'hyperframes' && key === 'subcommand') return { type: 'string', enum: HyperFramesSubcommands, description: 'HyperFrames 子命令' };
  switch (spec.type) {
    case 'boolean':
      return { type: 'boolean', description };
    case 'integer':
      return { type: 'integer', description };
    case 'number':
      return { type: 'number', description };
    case 'strings':
      return { type: 'array', items: { type: 'string' }, description };
    default:
      // duration 也按字符串传（例如 "90s"）。
      return { type: 'string', description };
  }
}

function waitSchema(): JSONSchema {
  // 每个工具都带这一项，说明要短；没跑完怎么办写在服务说明与 job_wait 里。
  return { type: 'number', description: `最多等几秒（缺省 ${DefaultWaitSeconds}）` };
}

const visibleParams = (op: Op) => Object.entries(op.params).filter(([, s]) => !s.cliOnly);

const typeNames: Record<string, string> = { string: '字符串', boolean: 'true / false', integer: '整数', number: '数字', strings: '字符串数组', duration: '时长，例如 "30m"' };

/** tool_help 的内容：完整说明、每个参数、例子。 */
function helpText(op: Op): string {
  const parts = [op.summary];
  if (op.description) parts.push(op.description);
  const params = visibleParams(op);
  if (params.length > 0) {
    parts.push('参数：\n' + params.map(([k, s]) => `  ${k}（${typeNames[s.type]}${s.required ? '，必填' : ''}）：${s.description}${defaultNote(s)}`).join('\n'));
  }
  if (op.examples && op.examples.length > 0) parts.push('例子：\n' + op.examples.map((e) => '  ' + e).join('\n'));
  return parts.join('\n\n');
}

/**
 * 已装的第三方插件里编排工具能调的操作，做成不进操作表的 Op（参数校验、说明与内置工具同一套）。插件对所有项目生效。
 * 只能由用户触发的操作（trigger: user）不在这里：它们只有界面上的按钮。
 */
export function externalOps(): { op: Op; external: { station: string; op: string } }[] {
  const out: { op: Op; external: { station: string; op: string } }[] = [];
  for (const s of flow.loadStations().stations) {
    for (const m of s.manifest.ops) {
      if (m.trigger !== 'agent') continue;
      const params: Record<string, ParamSpec> = {};
      for (const [key, spec] of Object.entries(m.params)) {
        params[key] = { type: spec.type, description: spec.description, ...(spec.required ? { required: true } : {}), ...(spec.default !== undefined ? { default: spec.default as ParamSpec['default'] } : {}) };
      }
      const name = flow.toolName(s.manifest.id, m.name);
      out.push({
        op: {
          name,
          cli: [],
          summary: `${m.summary}（第三方站「${s.manifest.name}」）`,
          description: (m.description ? m.description + '\n\n' : '') + `由用户装的第三方插件「${s.manifest.name}」（${s.manifest.id} ${s.manifest.version}）提供，不是 am 自带的工具。`,
          ...(m.examples ? { examples: m.examples } : {}),
          params,
          scopes: ['orchestrator'],
          run: () => {
            throw new Error(`${name} 要经 station_run 执行`);
          },
        },
        external: { station: s.manifest.id, op: m.name },
      });
    }
  }
  return out;
}

/** 一次调用实际起哪条操作：第三方工具落到 station_run。 */
export function callTarget(tool: ToolDef, params: ParamValues): { name: string; params: ParamValues } {
  if (!tool.external) return { name: tool.op!.name, params };
  return { name: 'station_run', params: { station: tool.external.station, op: tool.external.op, params: JSON.stringify(params), project_root: '.' } };
}

/** 这一档位的全部工具。root 给了时（编排档位），再加上项目里第三方站的工具。 */
export function describeTools(profile: Profile, root = ''): ToolDef[] {
  const out: ToolDef[] = [];
  const extras = profile === 'orchestrator' && root !== '' ? externalOps() : [];
  for (const { op, external } of [...allOps().map((op) => ({ op, external: undefined as ToolDef['external'] })), ...extras]) {
    if (!external && !opScopes(op).includes(profile)) continue;
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    for (const [key, spec] of visibleParams(op)) {
      properties[key] = paramSchema(op, key, spec);
      if (spec.required) required.push(key);
    }
    properties.wait_seconds = waitSchema();
    out.push({
      name: op.name,
      // 列表里只放一句话：全部工具的完整说明有好几万字，每次请求都塞进 agent 的上下文太浪费。
      description: `${op.summary}（完整说明与例子用 tool_help 查）`,
      inputSchema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false },
      op,
      help: helpText(op),
      ...(external ? { external } : {}),
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.push({
    name: 'job_wait',
    description: '接着等一个还没跑完的任务（上一次调用返回的任务号），返回它的新输出；跑完时给出结果。',
    inputSchema: { type: 'object', properties: { job: { type: 'string', description: '任务号' }, wait_seconds: waitSchema() }, required: ['job'], additionalProperties: false },
    help: '',
  });
  out.push({
    name: 'job_cancel',
    description: '停掉一个还没跑完的任务。',
    inputSchema: { type: 'object', properties: { job: { type: 'string', description: '任务号' } }, required: ['job'], additionalProperties: false },
    help: '',
  });
  out.push({
    name: 'tool_help',
    description: '查一个工具的完整说明、参数与例子（参数怎么填、产出什么、和其他步骤的关系）。',
    inputSchema: { type: 'object', properties: { tool: { type: 'string', description: '工具名' } }, required: ['tool'], additionalProperties: false },
    help: '',
  });
  return out;
}

/**
 * 校验一次调用的参数，返回交给执行进程的参数。hyperframes 另守子命令白名单：
 * 与渲染提示词的禁令同一份——远端渲染、改动已装技能、交互与遥测命令一律不给。
 */
export function prepareCall(tool: ToolDef, input: ParamValues): ParamValues {
  const op = tool.op!;
  const { wait_seconds: _wait, ...rest } = input;
  for (const [key, spec] of Object.entries(op.params)) if (spec.cliOnly) delete rest[key];
  const params = normalizeParams(op, rest);
  if (op.name === 'hyperframes') {
    const sub = String(params.subcommand ?? '');
    if (!(HyperFramesSubcommands as readonly string[]).includes(sub)) throw new Error(`hyperframes 不放行子命令 ${sub || '（空）'}；只能用：${HyperFramesSubcommands.join('、')}`);
    const args = (params.args as string[]).slice();
    if (sub === 'timeline' && (!args.includes('--json') || args.some((a) => !a.startsWith('-')))) {
      throw new Error('timeline 只放行只读的 --json（不能用 move、trim、split 等改写子命令）');
    }
    // 不把画面发给外部视觉服务。
    if (sub === 'snapshot' && !args.includes('--describe')) args.push('--describe', 'false');
    params.args = args;
  }
  return params;
}

// ---------------------------------------------------------------- 执行与任务

/** 起一个执行进程跑一条操作；由调用方注入，测试换成假的。 */
export type Spawner = (name: string, params: ParamValues) => ChildProcess;

/** 执行进程的命令行与环境（spawnOp 用；单独拿出来是为了测「客户端里要带 ELECTRON_RUN_AS_NODE」）。 */
export function opCommand(name: string, params: ParamValues): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const command = nodeCommand(process.argv[1] ?? '', workerArgs(name, params));
  return { file: command.file, args: command.args, env: { ...process.env, ...command.env } };
}

/**
 * 用 am 自己的运行时、自己的入口文件执行：客户端里是 Electron 当 Node，不经 PATH 找 am。
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

interface Job {
  id: string;
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

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private next = 1;

  constructor(private readonly spawner: Spawner) {}

  start(name: string, params: ParamValues): Job {
    const child = this.spawner(name, params);
    const job: Job = { id: `job-${this.next++}`, child, output: '', delivered: 0, code: null, done: Promise.resolve() };
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

  /** 等到任务结束或超时，返回给 agent 的回复。 */
  async wait(job: Job, seconds: number, signal?: AbortSignal): Promise<Reply> {
    const ms = Math.min(Math.max(seconds, 0), maxWaitSeconds) * 1000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    const aborted = new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    await Promise.race([job.done, timeout, aborted]);
    clearTimeout(timer);
    const visible = visibleText(job.output);
    const fresh = visible.slice(job.delivered);
    job.delivered = visible.length;
    const body = clip(fresh);
    const sep = body.endsWith('\n') || body === '' ? '' : '\n';
    if (job.code === null) return { text: `${body}${sep}[还在运行：任务 ${job.id}。用 job_wait 接着等，或 job_cancel 停掉]`, isError: false };
    this.jobs.delete(job.id);
    const { result } = parseWorkerOutput(job.output);
    if (!result) return { text: `${body}${sep}[执行进程意外退出，退出码 ${job.code}]`, isError: true };
    if (!result.ok) return { text: `${body}${sep}[失败] ${result.error ?? ''}`.trimEnd(), isError: true };
    let text = `${body}${sep}[完成]`;
    if (result.data !== undefined) {
      const json = JSON.stringify(result.data);
      if (json.length <= maxInlineDataChars) text += `\n结果：${json}`;
    }
    return { text, isError: false, data: result.data };
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

function clip(text: string): string {
  if (text.length <= maxOutputChars) return text;
  return `[前面 ${text.length - maxOutputChars} 个字符略去]\n` + text.slice(-maxOutputChars);
}

// ---------------------------------------------------------------- MCP

/**
 * am studio tools-mcp 的服务循环：stdio 上按行收发 JSON-RPC（与 permission-mcp 同一套写法）。
 * tools/call 不阻塞读下一行：agent 可能并行发几条调用。
 */
export async function serveToolsMCP(
  lines: AsyncIterable<string>,
  write: (line: string) => void,
  profile: Profile,
  spawner: Spawner = spawnOp,
  signal?: AbortSignal,
): Promise<void> {
  const send = (msg: Record<string, unknown>): void => write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  // 工作目录就是项目根（编排档位）：项目加的第三方站各自的工具一起登记。
  const tools = describeTools(profile, process.cwd());
  const byName = new Map(tools.map((t) => [t.name, t]));
  const jobs = new Jobs(spawner);
  const pending: Promise<void>[] = [];
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      const id = msg.id;
      if (id === undefined) continue;
      switch (msg.method) {
        case 'initialize':
          send({
            id,
            result: {
              protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: ToolsServerName, version: '1' },
              instructions:
                'ArticleToMotion 的制作工具，每个工具对应一条制作步骤。参数怎么填、产出什么用 tool_help 查。' +
                `每次调用最多等 wait_seconds 秒（缺省 ${DefaultWaitSeconds}）；没跑完会返回任务号，用 job_wait 接着等，job_cancel 停掉。` +
                '结果里「结果：」那一行是结构化的 JSON。am 不在终端里，不要去找它。',
            },
          });
          break;
        case 'tools/list':
          send({ id, result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } });
          break;
        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          const input = (msg.params?.arguments ?? {}) as ParamValues;
          const reply = (r: Reply) =>
            send({
              id,
              result: {
                content: [{ type: 'text', text: r.text }],
                ...(r.data !== undefined && typeof r.data === 'object' && r.data !== null && !Array.isArray(r.data) ? { structuredContent: r.data } : {}),
                isError: r.isError,
              },
            });
          const handle = async (): Promise<void> => {
            const seconds = typeof input.wait_seconds === 'number' ? input.wait_seconds : DefaultWaitSeconds;
            if (name === 'job_wait' || name === 'job_cancel') {
              const job = jobs.get(String(input.job ?? ''));
              if (!job) return reply({ text: `没有这个任务：${String(input.job ?? '')}（可能已经结束并交过结果）`, isError: true });
              if (name === 'job_cancel') return reply({ text: jobs.cancel(job.id) ? `已停掉 ${job.id}` : `${job.id} 已经结束`, isError: false });
              return reply(await jobs.wait(job, seconds, signal));
            }
            if (name === 'tool_help') {
              const target = byName.get(String(input.tool ?? ''));
              if (!target) return reply({ text: `没有这个工具：${String(input.tool ?? '')}`, isError: true });
              return reply({ text: target.help || target.description, isError: false });
            }
            const tool = byName.get(name);
            if (!tool?.op) return reply({ text: `没有这个工具：${name}`, isError: true });
            let params: ParamValues;
            try {
              params = prepareCall(tool, input);
            } catch (err) {
              return reply({ text: (err as Error).message, isError: true });
            }
            const target = callTarget(tool, params);
            reply(await jobs.wait(jobs.start(target.name, target.params), seconds, signal));
          };
          pending.push(handle());
          break;
        }
        case 'ping':
          send({ id, result: {} });
          break;
        default:
          send({ id, error: { code: -32601, message: 'method not found: ' + String(msg.method) } });
      }
    }
    await Promise.allSettled(pending);
  } finally {
    jobs.stopAll();
  }
}
