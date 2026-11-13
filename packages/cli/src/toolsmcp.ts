/**
 * am 的工具服务（MCP，stdio）：客户端里的编排工具与渲染器只经它调用 am 的能力，不在 Bash 里跑 am。
 *
 * 以前 am 在它们的 PATH 里，缺信息时它们会 `which am`、`strings "$(which am)"` 反推格式（实测两次），
 * 每次都撞白名单、弹审批卡片打断用户。现在命令行不再对外，am 程序只留在 .app 里给客户端自己用；
 * 这里把命令树里的每条命令自动做成一个工具，参数与说明都来自命令本身，以后加命令自动有工具，不会漏。
 *
 * 每次调用起一个 am 子进程执行（同一个运行时、同一个 am.cjs）：并发调用、环境变量互不影响。
 * MCP 客户端多有调用超时（codex 默认 60 秒），而渲染、拼接动辄几分钟到几小时，所以每次最多等
 * wait_seconds；没跑完就返回任务号与已有输出，由 job_wait 接着等、job_cancel 停掉。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { newRoot } from './cli';
import type { Command } from './cobra';

/** 档位：编排工具拿全部工具，渲染器只拿 hyperframes。 */
export type Profile = 'orchestrator' | 'renderer';

/** MCP 配置里给这个服务起的名字；claude 系的工具全名是 mcp__am__<工具名>。 */
export const ToolsServerName = 'am';

/** 不做成工具的命令（命令路径）。前置资源只在客户端的安装页装；run / init 是终端与客户端自己的入口。 */
const excludedCommands = new Set(['setup', 'run', 'init', 'studio permission-mcp', 'studio tools-mcp', 'hyperframes', 'help', 'completion']);

/** hyperframes 工具放行的子命令：本机渲染与只读检查。远端渲染、改动已装技能、交互与遥测命令一律不给。 */
export const HyperFramesSubcommands = ['lint', 'check', 'validate', 'inspect', 'snapshot', 'keyframes', 'render', 'timeline', 'compositions', 'info', 'docs'] as const;

/** 一次调用最多等多久（秒）：codex 的 MCP 调用默认 60 秒超时，留出余量。 */
export const DefaultWaitSeconds = 50;
const maxWaitSeconds = 600;

/** 返回给 agent 的输出上限：过长时截掉开头、留结尾（错误与结论通常在最后）。 */
const maxOutputChars = 24_000;

interface JSONSchema {
  type: string;
  description?: string;
  items?: JSONSchema;
  enum?: string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 一个工具：名字、说明、入参，以及怎么还原成命令行。 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  /** 命令路径，例如 ['scene', 'run-all']；hyperframes 与任务工具为空。 */
  path: string[];
  /** 参数名 → flag 名与类型，还原命令行用。 */
  flags: Record<string, { flag: string; type: string }>;
  /** tool_help 返回的完整说明。 */
  help: string;
}

/** 命令路径 → 工具名：空格与连字符换成下划线。 */
export function toolName(path: string[]): string {
  return path.join('_').replace(/-/g, '_');
}

/** 参数说明只留第一句：完整的在 tool_help 里，列表要短。 */
function firstSentence(text: string): string {
  const m = /^[^。；;\n]*/.exec(text);
  const head = (m ? m[0] : text).trim();
  return head.length > 80 ? head.slice(0, 80) + '…' : head;
}

function flagSchema(type: string, usage: string, def: string): JSONSchema {
  const description = firstSentence(usage) + (def !== '' && def !== '[]' && def !== 'false' && def !== '0' ? `（缺省 ${def}）` : '');
  switch (type) {
    case 'bool':
      return { type: 'boolean', description };
    case 'int':
      return { type: 'integer', description };
    case 'float64':
      return { type: 'number', description };
    case 'stringArray':
    case 'stringSlice':
      return { type: 'array', items: { type: 'string' }, description };
    default:
      // duration 也按字符串传（例如 "90s"），与命令行写法相同。
      return { type: 'string', description };
  }
}

/** 位置参数的说明取命令的 use 行（例如 `run <镜头目录>`）。 */
function argsSchema(cmd: Command): JSONSchema {
  const use = cmd.use.split(' ').slice(1).join(' ');
  return { type: 'array', items: { type: 'string' }, description: use === '' ? '位置参数' : `位置参数，依次对应：${use}` };
}

/**
 * 列表里只放一句话说明：74 个工具的完整帮助有 7.5 万字，每次请求都塞进 agent 的上下文太浪费。
 * 完整说明（长帮助与例子）由 tool_help 按需取。
 */
function describe(cmd: Command): string {
  return `${cmd.short || cmd.name()}（完整说明与例子用 tool_help 查）`;
}

/** tool_help 给的完整说明（命令行写法在 describeTools 里统一换成工具调用）。 */
function fullHelp(cmd: Command): string {
  const parts = [cmd.short, cmd.long, cmd.example ? '例子：\n' + cmd.example : ''].filter((s) => s && s.trim() !== '');
  return parts.join('\n\n');
}

/** flag 名 → 参数名：连字符换成下划线，各家对属性名的写法要求不一，下划线最稳。 */
export function paramName(flag: string): string {
  return flag.replace(/-/g, '_');
}

function waitSchema(): JSONSchema {
  // 72 个工具都带这一项，说明要短；没跑完怎么办写在服务说明与 job_wait 里。
  return { type: 'number', description: `最多等几秒（缺省 ${DefaultWaitSeconds}）` };
}

/** 遍历命令树，生成这一档位的全部工具。 */
export function describeTools(profile: Profile): ToolDef[] {
  const { root } = newRoot({ write: () => true }, { write: () => true });
  const out: ToolDef[] = [];
  if (profile === 'orchestrator') {
    const walk = (cmd: Command, path: string[]): void => {
      for (const child of cmd.commands()) {
        if (child.hidden) continue;
        const childPath = [...path, child.name()];
        if (excludedCommands.has(childPath.join(' '))) continue;
        if (child.commands().length > 0) walk(child, childPath);
        if (!child.runnable()) continue;
        const properties: Record<string, JSONSchema> = { args: argsSchema(child) };
        const flags: ToolDef['flags'] = {};
        for (const flag of [...child.flags().sorted(), ...inheritedFlags(child)]) {
          const param = paramName(flag.name);
          if (flag.hidden || flag.name === 'help' || flag.name === 'unsafe' || flags[param]) continue;
          flags[param] = { flag: flag.name, type: flag.type };
          properties[param] = flagSchema(flag.type, flag.usage, flag.defValue);
        }
        properties.wait_seconds = waitSchema();
        out.push({
          name: toolName(childPath),
          description: describe(child),
          inputSchema: { type: 'object', properties, additionalProperties: false },
          path: childPath,
          flags,
          help: fullHelp(child),
        });
      }
    };
    walk(root, []);
    // 帮助是给命令行写的：里面的「am scene run …」统一换成工具调用，agent 照着就能调。
    for (const tool of out) tool.help = toolNotation(tool.help, out);
  }
  out.push({
    name: 'hyperframes',
    description:
      '运行固定版本的 HyperFrames CLI（本机渲染与检查）。只放行这些子命令：' +
      HyperFramesSubcommands.join('、') +
      '。snapshot 会自动加 --describe false（不把画面发给外部视觉服务）；timeline 只放行只读的 --json。参数照 HyperFrames 的命令行写法放进 args。',
    inputSchema: {
      type: 'object',
      properties: {
        subcommand: { type: 'string', enum: [...HyperFramesSubcommands], description: 'HyperFrames 子命令' },
        args: { type: 'array', items: { type: 'string' }, description: '子命令之后的参数，例如 ["--json"]、["--at", "1.5"]' },
        wait_seconds: waitSchema(),
      },
      required: ['subcommand'],
      additionalProperties: false,
    },
    path: [],
    flags: {},
    help: '子命令自己的用法用 hyperframes 工具查：subcommand 填子命令，args 填 ["--help"]。',
  });
  out.push({
    name: 'job_wait',
    description: '接着等一个还没跑完的任务（上一次调用返回的任务号），返回它的新输出；跑完时给出退出码。',
    inputSchema: { type: 'object', properties: { job: { type: 'string', description: '任务号' }, wait_seconds: waitSchema() }, required: ['job'], additionalProperties: false },
    path: [],
    flags: {},
    help: '',
  });
  out.push({
    name: 'job_cancel',
    description: '停掉一个还没跑完的任务。',
    inputSchema: { type: 'object', properties: { job: { type: 'string', description: '任务号' } }, required: ['job'], additionalProperties: false },
    path: [],
    flags: {},
    help: '',
  });
  out.push({
    name: 'tool_help',
    description: '查一个工具的完整说明与例子（参数怎么填、产出什么、和其他步骤的关系）。',
    inputSchema: { type: 'object', properties: { tool: { type: 'string', description: '工具名' } }, required: ['tool'], additionalProperties: false },
    path: [],
    flags: {},
    help: '',
  });
  return out;
}

/** 命令行里的一个词：引号串、<占位>、${…} 插值，或不含空白与中文、至少带一个字母或数字的一串（单独的「/」不算）。 */
const wordChars = String.raw`[A-Za-z0-9_./=:,*{}\[\]$@~+-]`;
const wordPattern = String.raw`(?:"[^"\n]*"|'[^'\n]*'|<[^>\n]*>|${wordChars}*[A-Za-z0-9]${wordChars}*)`;
/** 行内的「am 命令 …」：am 前面不能是词的一部分或路径（~/.local/bin/am 不算），词之间只隔一个空格。 */
const amMention = new RegExp(String.raw`(?<![\w/.\-\x60])am((?: ${wordPattern})+)`, 'g');
/** 独占一行的命令（例子里的写法）：到两个以上空格（对齐的说明）或 # 注释为止都是命令，参数可以是中文。 */
const amLine = /^(\s*)am ((?:(?! {2}| #).)+)(.*)$/;

function shellWords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.trim().matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * 一条 am 命令行 → 工具调用写法，例如 `scene run scenes/x --force` → `scene_run({"args": ["scenes/x"], "force": true})`。
 * 认不出命令时返回 null；认出了命令、后面的参数认不出时只换命令名，参数照原样留在后面。
 */
export function commandToCall(words: string[], tools: ToolDef[]): { call: string; used: number } | null {
  if (words[0] === 'hyperframes') {
    if (words.length < 2 || !(HyperFramesSubcommands as readonly string[]).includes(words[1]!)) return { call: 'hyperframes', used: 1 };
    const params: Record<string, unknown> = { subcommand: words[1] };
    if (words.length > 2) params.args = words.slice(2);
    return { call: `hyperframes(${callJSON(params)})`, used: words.length };
  }
  let tool: ToolDef | undefined;
  for (const t of tools) {
    if (t.path.length === 0 || t.path.length > words.length) continue;
    if (t.path.every((p, i) => words[i] === p) && (!tool || t.path.length > tool.path.length)) tool = t;
  }
  if (!tool) return null;
  const rest = words.slice(tool.path.length);
  const params: Record<string, unknown> = {};
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    if (w.startsWith('--') && w.length > 2) {
      const eq = w.indexOf('=');
      const name = paramName(eq >= 0 ? w.slice(2, eq) : w.slice(2));
      const spec = tool.flags[name];
      if (!spec) return { call: tool.name, used: tool.path.length };
      if (spec.type === 'bool') {
        params[name] = eq >= 0 ? w.slice(eq + 1) !== 'false' : true;
        continue;
      }
      let value = eq >= 0 ? w.slice(eq + 1) : rest[++i];
      if (value === undefined) return { call: tool.name, used: tool.path.length };
      if (spec.type === 'stringArray' || spec.type === 'stringSlice') {
        ((params[name] ??= []) as string[]).push(value);
      } else if ((spec.type === 'int' || spec.type === 'float64') && /^-?\d+(\.\d+)?$/.test(value)) {
        params[name] = Number(value);
      } else {
        params[name] = value;
      }
    } else if (w.startsWith('-') && w.length > 1) {
      return { call: tool.name, used: tool.path.length };
    } else {
      args.push(w);
    }
  }
  const all = args.length > 0 ? { args, ...params } : params;
  return { call: `${tool.name}(${Object.keys(all).length > 0 ? callJSON(all) : ''})`, used: words.length };
}

/** 参数写成与提示词相同的样子：`{"args": ["scenes/"], "force": true}`。 */
function callJSON(params: Record<string, unknown>): string {
  const value = (v: unknown): string => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  return `{${Object.entries(params)
    .map(([k, v]) => `${JSON.stringify(k)}: ${value(v)}`)
    .join(', ')}}`;
}

/**
 * 把文字里写成「am <命令> …」的地方换成工具调用写法。am 的帮助与输出是给命令行写的，
 * 经工具服务交给 agent 之前在这里统一换：agent 拿到什么就能照着调什么，不会去终端里找 am。
 */
export function toolNotation(text: string, tools: ToolDef[]): string {
  const convert = (whole: string, tail: string): string => {
    const words = shellWords(tail);
    const hit = commandToCall(words, tools);
    if (!hit) return whole;
    if (hit.used >= words.length) return hit.call;
    // 只认出了命令名：把命令路径换掉，其余原样。
    return whole.replace(`am ${words.slice(0, hit.used).join(' ')}`, hit.call);
  };
  // 反斜杠续行先接起来：例子里长命令常拆成几行。
  const joined = text.replace(/ \\\n\s*/g, ' ');
  return joined
    .split('\n')
    .map((line) => {
      const m = amLine.exec(line);
      if (m) {
        const converted = convert(`am ${m[2]!}`, ' ' + m[2]!);
        if (converted !== `am ${m[2]!}`) return m[1]! + converted + m[3]!.replace(amMention, convert);
      }
      return line.replace(amMention, convert);
    })
    .join('\n');
}

/** 父命令上的持久 flag（例如 validate 的 --project-root）对子命令同样有效。 */
function inheritedFlags(cmd: Command): ReturnType<ReturnType<Command['flags']>['sorted']> {
  const out: ReturnType<ReturnType<Command['flags']>['sorted']> = [];
  for (let p = cmd.parent; p; p = p.parent) out.push(...p.persistentFlags().sorted());
  return out;
}

/** 把一次调用的参数还原成 am 的命令行（不含 am 本身）。参数不对时抛错，错误交给 agent。 */
export function toArgv(tool: ToolDef, input: Record<string, unknown>): string[] {
  if (tool.name === 'hyperframes') {
    const sub = String(input.subcommand ?? '');
    if (!(HyperFramesSubcommands as readonly string[]).includes(sub)) throw new Error(`hyperframes 不放行子命令 ${sub || '（空）'}；只能用：${HyperFramesSubcommands.join('、')}`);
    const args = stringList(input.args, 'args');
    if (sub === 'timeline' && (!args.includes('--json') || args.some((a) => !a.startsWith('-')))) {
      throw new Error('timeline 只放行只读的 --json（不能用 move、trim、split 等改写子命令）');
    }
    if (sub === 'snapshot' && !args.includes('--describe')) args.push('--describe', 'false');
    return ['hyperframes', sub, ...args];
  }
  const argv = [...tool.path];
  for (const [key, value] of Object.entries(input)) {
    if (key === 'args' || key === 'wait_seconds' || value === undefined || value === null) continue;
    const spec = tool.flags[key];
    if (!spec) throw new Error(`${tool.name} 没有参数 ${key}（用 tool_help 查参数）`);
    const { flag, type } = spec;
    if (type === 'bool') {
      if (typeof value !== 'boolean') throw new Error(`${key} 要是 true 或 false`);
      argv.push(`--${flag}=${value}`);
    } else if (type === 'stringArray' || type === 'stringSlice') {
      for (const item of stringList(value, key)) argv.push(`--${flag}`, item);
    } else {
      if (typeof value === 'object') throw new Error(`${key} 要是单个值`);
      argv.push(`--${flag}`, String(value));
    }
  }
  // 位置参数放在最后，并用 -- 隔开：以 - 开头的位置参数（例如负数）不会被当成 flag。
  const args = stringList(input.args, 'args');
  if (args.length > 0) argv.push('--', ...args);
  return argv;
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} 要是字符串数组`);
  return value.map((v) => String(v));
}

// ---------------------------------------------------------------- 执行与任务

/** 起一个 am 子进程执行 argv；由调用方注入，测试换成假的。 */
export type Spawner = (argv: string[]) => ChildProcess;

/** 用 am 自己的运行时、自己的入口文件执行：客户端里是 Electron 当 Node，不经 PATH 找 am。 */
export const spawnAm: Spawner = (argv) => {
  const entry = process.argv[1] ?? '';
  return spawn(process.execPath, [entry, ...argv], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
};

interface Job {
  id: string;
  child: ChildProcess;
  output: string;
  /** 已经交给 agent 的输出长度：job_wait 只给新的部分。 */
  delivered: number;
  code: number | null;
  done: Promise<void>;
}

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private next = 1;

  constructor(
    private readonly spawner: Spawner,
    /** 交给 agent 之前对输出做的改写（toolNotation）。 */
    private readonly rewrite: (text: string) => string = (t) => t,
  ) {}

  start(argv: string[]): Job {
    const child = this.spawner(argv);
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

  /** 等到任务结束或超时，返回给 agent 的一段文字。 */
  async wait(job: Job, seconds: number, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const ms = Math.min(Math.max(seconds, 0), maxWaitSeconds) * 1000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    const aborted = new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    await Promise.race([job.done, timeout, aborted]);
    clearTimeout(timer);
    const fresh = job.output.slice(job.delivered);
    job.delivered = job.output.length;
    const body = this.rewrite(clip(fresh));
    if (job.code === null) {
      return { text: `${body}${body.endsWith('\n') || body === '' ? '' : '\n'}[还在运行：任务 ${job.id}。用 job_wait 接着等，或 job_cancel 停掉]`, isError: false };
    }
    this.jobs.delete(job.id);
    const status = job.code === 0 ? '[完成，退出码 0]' : `[失败，退出码 ${job.code}]`;
    return { text: `${body}${body.endsWith('\n') || body === '' ? '' : '\n'}${status}`, isError: job.code !== 0 };
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
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
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
  spawner: Spawner = spawnAm,
  signal?: AbortSignal,
): Promise<void> {
  const send = (msg: Record<string, unknown>): void => write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const tools = describeTools(profile);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const jobs = new Jobs(spawner, (text) => toolNotation(text, tools));
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
                'am 不在终端里，不要去找它。',
            },
          });
          break;
        case 'tools/list':
          send({ id, result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } });
          break;
        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          const input = (msg.params?.arguments ?? {}) as Record<string, unknown>;
          const reply = (text: string, isError: boolean) => send({ id, result: { content: [{ type: 'text', text }], isError } });
          const handle = async (): Promise<void> => {
            const seconds = typeof input.wait_seconds === 'number' ? input.wait_seconds : DefaultWaitSeconds;
            if (name === 'job_wait' || name === 'job_cancel') {
              const job = jobs.get(String(input.job ?? ''));
              if (!job) return reply(`没有这个任务：${String(input.job ?? '')}（可能已经结束并交过结果）`, true);
              if (name === 'job_cancel') return reply(jobs.cancel(job.id) ? `已停掉 ${job.id}` : `${job.id} 已经结束`, false);
              const out = await jobs.wait(job, seconds, signal);
              return reply(out.text, out.isError);
            }
            if (name === 'tool_help') {
              const target = byName.get(String(input.tool ?? ''));
              if (!target) return reply(`没有这个工具：${String(input.tool ?? '')}`, true);
              return reply(target.help || target.description, false);
            }
            const tool = byName.get(name);
            if (!tool || ['job_wait', 'job_cancel', 'tool_help'].includes(tool.name)) return reply(`没有这个工具：${name}`, true);
            let argv: string[];
            try {
              argv = toArgv(tool, input);
            } catch (err) {
              return reply((err as Error).message, true);
            }
            const out = await jobs.wait(jobs.start(argv), seconds, signal);
            reply(out.text, out.isError);
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
