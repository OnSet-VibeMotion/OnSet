/**
 * onset 的工具服务（MCP，stdio）：客户端里的编排工具与渲染器只经它调用 onset 的能力，不在 Bash 里跑 onset。
 *
 * 以前 onset 在它们的 PATH 里，缺信息时它们会 `which onset`、`strings "$(which onset)"` 反推格式（实测两次），
 * 每次都撞白名单、弹审批卡片打断用户。现在 onset 没有对外的命令行：工具直接来自操作表（ops/op.ts），
 * 工具名、具名参数、说明与例子都是操作自己定义的，结果是操作写下的文字加结构化的 data。
 *
 * 每次调用起一个执行进程（`onset.cjs __op <名字> <参数>`，同一个运行时、同一个 onset.cjs）：并发调用、
 * 环境变量互不影响，取消时整组结束。MCP 客户端多有调用超时（codex 默认 60 秒），而渲染、拼接动辄
 * 几分钟到几小时，所以每次最多等 wait_seconds；没跑完就返回任务号与已有输出，由 job_wait 接着等、
 * job_cancel 停掉。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as director from '@onset/engine/director';
import * as flow from '@onset/engine/flow';
import { parseWorkerOutput, visibleText, workerArgs } from '@onset/engine/opworker';
import { groupSpawnOptions, killTree } from '@onset/engine/procgroup';
import { nodeCommand } from '@onset/engine/toolpath';
import './cli';
import { compactHyperFrames, hyperFramesProgress } from './hfoutput';
import { allOps, normalizeToolParams, type Op, opScopes, type ParamSpec, type ParamValues } from './ops/op';
import { toolOutputArchiveDir } from './output_archive';

export { toolOutputArchiveDir };

/** 档位：编排工具使用制作工具，渲染器只拿镜头内的工具。 */
export type Profile = 'orchestrator' | 'renderer';

/** MCP 配置里给这个服务起的名字；claude 系的工具全名是 mcp__onset__<工具名>。 */
export const ToolsServerName = 'onset';

/** hyperframes 工具放行的子命令：本机渲染与只读检查。远端渲染、改动已装技能、交互与遥测命令一律不给。 */
export const HyperFramesSubcommands = ['lint', 'check', 'validate', 'inspect', 'snapshot', 'keyframes', 'render', 'timeline', 'compositions', 'info', 'docs'] as const;
const orchestratorHyperFramesSubcommands = HyperFramesSubcommands.filter((sub) => sub !== 'render');
const sceneDispatchNote = '镜头实现与 MP4 渲染交给渲染工具。单镜头用 scene_run({"scene": "<镜头目录>"})，整批用 scene_run_all({"scenes": "scenes/"})；本工具在制作端只用于检查。';

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
  return name === 'job_wait'
    || name === 'align_run'
    || name === 'audio_mix'
    || name === 'voice_synthesize'
    || name === 'concat'
    || name === 'scene_preview_check'
    ? maxWaitSeconds(env)
    : DefaultWaitSeconds;
}

/** 返回给 agent 的输出上限：过长时落盘保存完整输出并保留结尾（错误与结论通常在最后）。 */
const maxOutputChars = 8_000;
/** 结构化结果附在文字后面的上限；更大的只给 structuredContent。 */
const maxInlineDataChars = 4_000;

/** 编排端按项目流程（onset.flow.json）过滤掉本项目完全用不到的工具，减少每轮请求携带的 schema token。 */
function allowedForProjectFlow(opName: string, root: string): boolean {
  if (root === '') return true;
  const rec = flow.flowRecord(root);
  if (!rec) return true;
  const id = rec.id;
  if (id === 'speech') {
    // 保留 song_init（已有项目转歌曲讲解入口）与 cast_*/dialogue_*（同一会话里 cast_new 后可立即使用）。
    if (opName.startsWith('beat_') || (opName.startsWith('song_') && opName !== 'song_init') || opName === 'validate_beat' || opName === 'validate_song') return false;
    return true;
  }
  if (id === 'beat') {
    if (
      opName.startsWith('voice_') ||
      opName.startsWith('align_') ||
      opName.startsWith('song_') ||
      opName.startsWith('cast_') ||
      opName.startsWith('dialogue_') ||
      opName === 'validate_song' ||
      opName === 'validate_cast' ||
      opName === 'phrase_frames' ||
      opName === 'timing_report'
    ) return false;
    return true;
  }
  if (id === 'song') {
    if (
      opName.startsWith('beat_') ||
      opName.startsWith('voice_') ||
      opName.startsWith('align_') ||
      opName.startsWith('cast_') ||
      opName.startsWith('dialogue_') ||
      opName === 'validate_beat' ||
      opName === 'validate_cast' ||
      opName === 'phrase_frames' ||
      opName === 'timing_report'
    ) return false;
    return true;
  }
  return true;
}

/** 毫秒级纯查询/轻写操作不暴露 wait_seconds 参数，减少工具 schema 重复文字；调用时若传入仍由 prepareCall 兼容剥离。 */
const instantOps: ReadonlySet<string> = new Set([
  'config_get', 'flow_guide', 'usage', 'scene_usage', 'scene_lint',
  'film_style_list', 'film_style_show', 'film_style_use', 'film_style_add', 'film_style_remove',
  'studio_show', 'studio_step', 'studio_confirm',
  'voice_catalog', 'voice_list', 'voice_get', 'voice_default', 'voice_save',
  'memory_remember', 'memory_feedback',
  'inputs_manifest', 'shared_component_promote', 'timing_report',
]);

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
  /** 生成工具时的角色，用于执行时再次校验，不能只依赖 schema 限制。 */
  profile?: Profile;
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

function paramSchema(op: Op, key: string, spec: ParamSpec, profile: Profile): JSONSchema {
  const description = firstSentence(spec.description) + defaultNote(spec);
  if (op.name === 'hyperframes' && key === 'subcommand') {
    return { type: 'string', enum: profile === 'orchestrator' ? orchestratorHyperFramesSubcommands : HyperFramesSubcommands, description: 'HyperFrames 子命令' };
  }
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

function waitSchema(name: string): JSONSchema {
  // 每个工具都带这一项，说明要短；没跑完怎么办写在服务说明与 job_wait 里。
  return { type: 'number', description: `等待秒数（缺省 ${defaultWaitSeconds(name)}）` };
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
          description: (m.description ? m.description + '\n\n' : '') + `由用户装的第三方插件「${s.manifest.name}」（${s.manifest.id} ${s.manifest.version}）提供，不是 onset 自带的工具。`,
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
    if (!external && profile === 'orchestrator' && !allowedForProjectFlow(op.name, root)) continue;
    // 制作端仍需 inspect / snapshot 验收，但不能把 scene_run 降成单纯的出片工具。
    const inspecting = op.name === 'hyperframes' && profile === 'orchestrator';
    const rendererHF = op.name === 'hyperframes' && profile === 'renderer';
    const shownOp = inspecting ? {
      ...op,
      summary: '检查镜头合成与预览帧；渲染请派发镜头任务',
      description: sceneDispatchNote,
      params: { ...op.params, subcommand: { ...op.params.subcommand, description: 'HyperFrames 检查子命令，例如 lint、check、snapshot' } },
      examples: (op.examples ?? []).filter((e) => !e.includes('"render"')),
    } : rendererHF ? {
      ...op,
      summary: '运行本机 HyperFrames 文档与检查命令（画面检查与单帧细节优先用 scene_preview_check）',
    } : op;
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    for (const [key, spec] of visibleParams(op)) {
      properties[key] = paramSchema(op, key, spec, profile);
      if (spec.required) required.push(key);
    }
    if (external || !instantOps.has(op.name)) properties.wait_seconds = waitSchema(op.name);
    out.push({
      name: op.name,
      profile,
      // 列表里只放一句话：全部工具的完整说明有好几万字，每次请求都塞进 agent 的上下文太浪费。
      description: shownOp.summary,
      inputSchema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false },
      op,
      help: helpText(shownOp),
      ...(external ? { external } : {}),
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.push({
    name: 'job_wait',
    description: '接着等一个还没跑完的任务（上一次调用返回的任务号），返回它的新输出；跑完时给出结果。等渲染等长任务时直接省略 wait_seconds（一次等满上限），不要每隔几十秒短轮询，也不要在等待期间反复读 render-*.user.log。',
    inputSchema: { type: 'object', properties: { job: { type: 'string', description: '任务号' }, wait_seconds: waitSchema('job_wait') }, required: ['job'], additionalProperties: false },
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
  const params = normalizeToolParams(op, rest);
  if (op.name === 'hyperframes') {
    const sub = String(params.subcommand ?? '');
    if (tool.profile === 'orchestrator' && sub === 'render') throw new Error(sceneDispatchNote);
    const allowed: readonly string[] = tool.profile === 'orchestrator' ? orchestratorHyperFramesSubcommands : HyperFramesSubcommands;
    if (!allowed.includes(sub)) throw new Error(`hyperframes 不放行子命令 ${sub || '（空）'}；只能用：${allowed.join('、')}`);
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

interface Job {
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
    return { count: data.styles.length, ...(data.default ? { default: data.default } : {}), ...(Array.isArray(data.extras) && data.extras.length ? { extras: data.extras } : {}) };
  }
  if (report === '') return raw;
  if (name === 'audio_check') {
    const { speech: _speech, cues: _cues, ...summary } = data;
    return { ...summary, report };
  }
  if (name === 'review') {
    const { cuts: _cuts, sheets, seams, ...summary } = data;
    const images = (items: unknown) => Array.isArray(items) ? items.map(item => ({ image: item.image })) : undefined;
    return { ...summary, sheets: images(sheets), seams: images(seams), report };
  }
  if (name === 'scene_run_all' && Array.isArray(data.scenes)) {
    const actionable = data.scenes.filter(item => item.status === 'stale' || item.status === 'failed');
    return { ...data, scenes: actionable, report };
  }
  if (name === 'scene_frames_batch' && Array.isArray(data.scenes)) {
    const flagged = data.scenes.filter((item: { ok?: boolean }) => item.ok === false);
    return { ...data, scenes: flagged, report };
  }
  return raw;
}

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private next = 1;

  constructor(private readonly spawner: Spawner, private readonly archiveDir: string | (() => string) = toolOutputArchiveDir) {}

  start(name: string, params: ParamValues): Job {
    const child = this.spawner(name, params);
    const report = String(params.report_json || (name === 'review' && params.out ? path.join(String(params.out), 'review.json') : ''));
    const job: Job = { id: `job-${this.next++}`, name, report, child, output: '', delivered: 0, code: null, done: Promise.resolve() };
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
      waiting.push(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }));
    }
    let abort: (() => void) | undefined;
    if (signal && !signal.aborted) waiting.push(new Promise<void>(resolve => {
      abort = resolve;
      signal.addEventListener('abort', abort, { once: true });
    }));
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
      return { text: `${progress ? progress + '\n' : ''}[还在运行：任务 ${job.id}。用 job_wait 接着等，或 job_cancel 停掉。结束本轮对话会终止仍在运行的任务；不要用定时任务接管，必须在本轮持续 job_wait 直到完成或明确失败]`, isError: false };
    }
    const visible = compact ? compactedOutput(visibleText(job.output)) : visibleText(job.output);
    const fresh = visible.slice(job.delivered);
    job.delivered = visible.length;
    const body = clip(fresh, typeof this.archiveDir === 'function' ? this.archiveDir() : this.archiveDir);
    const sep = body.endsWith('\n') || body === '' ? '' : '\n';
    if (job.code === null) return { text: `${body}${sep}[还在运行：任务 ${job.id}。用 job_wait 接着等，或 job_cancel 停掉。结束本轮对话会终止仍在运行的任务；不要用定时任务接管，必须在本轮持续 job_wait 直到完成或明确失败]`, isError: false };
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
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`);
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
    const file = path.join(archiveDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    saved = `；完整输出：${file}`;
  } catch {
    // 写临时文件失败时照常截短。
  }
  return `[前面 ${text.length - maxOutputChars} 个字符略去${saved}]\n` + text.slice(-maxOutputChars);
}

// ---------------------------------------------------------------- MCP

/**
 * onset studio tools-mcp 的服务循环：stdio 上按行收发 JSON-RPC（与 permission-mcp 同一套写法）。
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
  // 工作目录就是项目根（编排档位）：已装的第三方插件各自的工具一起登记。
  const tools = describeTools(profile, process.cwd());
  const byName = new Map(tools.map((t) => [t.name, t]));
  const jobs = new Jobs(spawner);
  const recentSceneRuns: number[] = [];
  const sceneRunWindowMs = 10 * 60 * 1000;
  const longJobNames = new Set(['scene_run', 'scene_run_all', 'align_run', 'voice_synthesize', 'concat', 'audio_mix']);
  // 被取消（编排工具那一整组收到 SIGTERM）时立刻停掉还在跑的任务：等不到 stdin 关闭，进程可能随后就被 SIGKILL。
  signal?.addEventListener('abort', () => jobs.stopAll(), { once: true });
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
                '片场的制作工具，每个工具对应一条制作步骤。参数怎么填、产出什么用 tool_help 查。' +
                '每次调用可指定 wait_seconds；没跑完时用返回的任务号调用 job_wait 接着等，job_cancel 停掉。' +
                '结果里「结果：」那一行是结构化的 JSON。onset 不在终端里，不要去找它。',
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
            const explicitWait = typeof input.wait_seconds === 'number';
            const seconds = explicitWait ? (input.wait_seconds as number) : defaultWaitSeconds(name);
            if (name === 'job_wait' || name === 'job_cancel') {
              const job = jobs.get(String(input.job ?? ''));
              if (!job) return reply({ text: `没有这个任务：${String(input.job ?? '')}（可能已经结束并交过结果）`, isError: true });
              if (name === 'job_cancel') return reply({ text: jobs.cancel(job.id) ? `已停掉 ${job.id}` : `${job.id} 已经结束`, isError: false });
              const result = await jobs.wait(job, seconds, signal);
              if (
                !result.isError &&
                job.code === null &&
                explicitWait &&
                seconds > 0 &&
                seconds < Math.min(60, maxWaitSeconds()) &&
                longJobNames.has(job.name)
              ) {
                return reply({
                  ...result,
                  text: `${result.text}\n[等待提示] 等待长任务时请省略 wait_seconds（一次等满 ${maxWaitSeconds()} 秒上限），避免短轮询反复唤醒消耗上下文。`,
                });
              }
              return reply(result);
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
            let batchNudge = '';
            if (profile === 'orchestrator' && target.name === 'scene_run') {
              const now = Date.now();
              while (recentSceneRuns.length > 0 && now - recentSceneRuns[0]! > sceneRunWindowMs) recentSceneRuns.shift();
              recentSceneRuns.push(now);
              const active = jobs.activeCount('scene_run');
              if (active >= 1 || recentSceneRuns.length >= 3) {
                batchNudge = '\n[调度提示] 检测到短时间内多次单独调用 scene_run。多镜头批量渲染或返修请改用一次 scene_run_all({"scenes":"scenes/","only_scenes":[...],"force":true}) 由片场统一并发调度，可大幅减少 job_wait 轮询与 token 消耗。';
              }
            }
            const result = await jobs.wait(jobs.start(target.name, target.params), seconds, signal);
            reply(batchNudge ? { ...result, text: result.text + batchNudge } : result);
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
