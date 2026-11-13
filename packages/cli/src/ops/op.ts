/**
 * 操作表：am 的每一条制作步骤是一个 Op——名字、说明、具名参数、处理函数。
 *
 * 编排工具与渲染器经工具服务（MCP）调用的工具、客户端后端跑的写任务，都直接从这张表来：
 * 工具名就是 Op 的 name，参数就是 params，结果是处理函数写下的文字加结构化的 data。
 * 命令行（`am beat import …`）只是给开发与 CI 用的一层适配（ops/cli.ts），不对外提供。
 *
 * 说明与例子按工具的写法写（`beat_cues({"scenes": "scenes/"})`），不写 `am <命令>`：
 * agent 拿到什么就照着调什么，写成命令行它就会去终端里找 am。
 */
import type { Out } from '../cobra';

/** 参数类型。strings 是字符串数组；duration 按字符串传（例如 "90s"），与 Go 的 time.Duration 写法相同。 */
export type ParamType = 'string' | 'boolean' | 'integer' | 'number' | 'strings' | 'duration';

export interface ParamSpec {
  type: ParamType;
  description: string;
  /** 缺省值。没写的参数处理函数拿到这里的值（strings 缺省 []，boolean 缺省 false，数字缺省 0，字符串缺省 ''）。 */
  default?: string | number | boolean | string[];
  /** 必填。 */
  required?: boolean;
  /**
   * 命令行适配：作为位置参数时的次序（0 起）。`'rest'` 收下剩余的全部位置参数（只能用于 strings）。
   * 不写的参数在命令行里是 --flag。
   */
  positional?: number | 'rest';
  /** 命令行适配：flag 名，缺省是参数名把下划线换成连字符。 */
  flag?: string;
  /** 命令行适配：单字母简写。 */
  shorthand?: string;
  /** 不进工具列表（只给命令行用，例如交互确认的 --yes）。 */
  cliOnly?: boolean;
}

/** 处理函数能用的环境。 */
export interface OpContext {
  /** 给人（以及 agent）看的结果文字与进度。 */
  out: Out;
  /** 警告与诊断。工具服务里与 out 合在一起交给 agent。 */
  err: Out;
  /** 取消信号：工具服务里 job_cancel、客户端里「取消」都走这里。 */
  signal: AbortSignal;
  /** 关闭 AI CLI 权限隔离（危险）；只对会启动 AI CLI 的操作有意义。 */
  unsafe: boolean;
}

/** 处理函数的结构化结果。文字部分是写进 ctx.out 的内容。 */
export interface OpResult {
  data?: unknown;
}

export type ParamValues = Record<string, unknown>;

/** 谁能调用：orchestrator 是编排工具（以及客户端后端），renderer 是渲染器，cli 只在命令行里出现。 */
export type OpScope = 'orchestrator' | 'renderer' | 'cli';

export interface Op {
  /** 工具名，小写加下划线，例如 beat_import。 */
  name: string;
  /** 命令行里的路径，例如 ['beat', 'import']。 */
  cli: string[];
  /** 一句话说明，进工具列表。 */
  summary: string;
  /** 完整说明，tool_help 返回。 */
  description?: string;
  /** 例子，按工具写法：`beat_import({"music": "~/Music/track.mp3"})`；单独一行 `# …` 是说明，可以留空行分组。 */
  examples?: string[];
  params: Record<string, ParamSpec>;
  /** 缺省 ['orchestrator']。 */
  scopes?: OpScope[];
  /** 客户端对话里显示这次调用时的说法（内置插件的操作经 /api/stations 交给界面）。 */
  verb?: string;
  /** 命令行适配：不解析参数，原样交给 rawArgs（hyperframes 透传用）。 */
  passthrough?: boolean;
  run(params: ParamValues, ctx: OpContext): void | OpResult | Promise<void | OpResult>;
}

/** 参数校验或调用方式不对：工具服务把它原样交给 agent，不当成操作失败的堆栈（与内置插件的操作同一个类）。 */
export { ParamError } from '@am/engine/opkit';
import { ParamError } from '@am/engine/opkit';

const registry = new Map<string, Op>();

/** 登记一条操作。名字重复直接报错：两条同名的工具 agent 分不清。 */
export function defineOp(op: Op): Op {
  if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(op.name)) throw new Error(`操作名 ${op.name} 要是小写加下划线`);
  if (registry.has(op.name)) throw new Error(`操作 ${op.name} 登记了两次`);
  for (const [key, spec] of Object.entries(op.params)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`${op.name} 的参数名 ${key} 要是小写加下划线`);
    if (spec.positional === 'rest' && spec.type !== 'strings') throw new Error(`${op.name} 的 ${key}：收剩余位置参数的只能是 strings`);
  }
  registry.set(op.name, op);
  return op;
}

/** 撤掉一条操作：只给内置插件撤销登记用（测试里登记的假插件）。 */
export function removeOp(name: string): void {
  registry.delete(name);
}

export function allOps(): Op[] {
  return [...registry.values()];
}

export function findOp(name: string): Op | undefined {
  return registry.get(name);
}

export function opScopes(op: Op): OpScope[] {
  return op.scopes ?? ['orchestrator'];
}

/** 参数的缺省值。 */
export function defaultValue(spec: ParamSpec): unknown {
  if (spec.default !== undefined) return Array.isArray(spec.default) ? [...spec.default] : spec.default;
  switch (spec.type) {
    case 'boolean':
      return false;
    case 'integer':
    case 'number':
      return 0;
    case 'strings':
      return [];
    default:
      return '';
  }
}

/**
 * 校验并补齐一次调用的参数：未知参数、类型不对、缺必填都抛 ParamError。
 * 工具服务与客户端后端都经这里，命令行适配已经按类型解析过，也再过一遍。
 */
export function normalizeParams(op: Op, input: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const key of Object.keys(input)) {
    if (input[key] === undefined || input[key] === null) continue;
    if (!op.params[key]) throw new ParamError(`${op.name} 没有参数 ${key}（参数怎么填用 tool_help({"tool": "${op.name}"}) 查）`);
  }
  for (const [key, spec] of Object.entries(op.params)) {
    const raw = input[key];
    if (raw === undefined || raw === null) {
      if (spec.required) throw new ParamError(`${op.name} 缺少参数 ${key}：${spec.description}`);
      out[key] = defaultValue(spec);
      continue;
    }
    out[key] = coerce(op, key, spec, raw);
  }
  return out;
}

function coerce(op: Op, key: string, spec: ParamSpec, raw: unknown): unknown {
  const bad = (want: string) => new ParamError(`${op.name} 的参数 ${key} 要是${want}，收到 ${JSON.stringify(raw)}`);
  switch (spec.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      throw bad('true 或 false');
    case 'integer': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof n === 'number' && Number.isInteger(n)) return n;
      throw bad('整数');
    }
    case 'number': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof n === 'number' && Number.isFinite(n)) return n;
      throw bad('数字');
    }
    case 'strings':
      if (Array.isArray(raw)) return raw.map((v) => String(v));
      if (typeof raw === 'string') return [raw];
      throw bad('字符串数组');
    default:
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
      throw bad('字符串');
  }
}

/** 工具调用写法，与提示词相同：`beat_cues({"scenes": "scenes/"})`。 */
export function callText(name: string, params: ParamValues = {}): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return `${name}()`;
  const value = (v: unknown): string => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  return `${name}({${entries.map(([k, v]) => `${JSON.stringify(k)}: ${value(v)}`).join(', ')}})`;
}

/** 收集写进 Out 的文字。 */
export class TextSink implements Out {
  text = '';
  constructor(private readonly forward?: (chunk: string) => void) {}
  write(chunk: string): void {
    this.text += chunk;
    this.forward?.(chunk);
  }
}
