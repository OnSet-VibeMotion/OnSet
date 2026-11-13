// 移植自 internal/agentrun/parse.go。
//
// agentrun 运行编排工具，并把各家 CLI 的结构化输出统一成同一套事件。
//
// am run 与 am studio 共用这一条路径：前者把事件打印成可读文字，后者推给网页。
// 各家的流格式在 2026-11 实测录下，见 testdata/；codebuddy 本机未登录，只录到
// 401 的错误流，结构按与 claude 相同处理，未经完整实测。
import { compareBytes } from '../gojson';
import { ValidTools, accumulateUsage, newUsage, usageJSON, type Usage } from '../tools';

/** 统一事件的种类。Studio 会在此之外再加自己的种类，所以是 string 而不是封闭的联合类型。 */
export type Kind = string;

export const KindSession: Kind = 'session';
export const KindText: Kind = 'text';
export const KindThinking: Kind = 'thinking';
export const KindToolCall: Kind = 'tool-call';
export const KindToolResult: Kind = 'tool-result';
export const KindUsage: Kind = 'usage';
export const KindError: Kind = 'error';
export const KindDone: Kind = 'done';
/**
 * 编排工具的待办清单（claude 的 TodoWrite、codex 的 todo_list、
 * opencode 的 todowrite）。每条都是完整的最新清单，不是增量。
 */
export const KindPlan: Kind = 'plan';

/** 待办清单的一项。status 是 pending、in_progress 或 completed。 */
export interface PlanItem {
  text: string;
  status: string;
}

/**
 * 限制工具结果正文的长度（字节）：渲染日志、ffprobe 输出动辄几万字，
 * 全文推给网页没有意义，原始流另有日志可查。
 */
export const maxToolOutput = 4000;

/**
 * 一条统一事件。只做消息级粒度，不解析 token 增量。字段名照抄 Go 的 JSON tag；
 * 写出 JSON 时经 eventJSON（字段顺序与 omitempty 与 Go 一致）。
 */
export interface Event {
  kind: Kind;
  text?: string;
  tool?: string;
  call_id?: string;
  /**
   * Go 里是 json.RawMessage（json.Marshal 的结果，map 键已排序）。这里存解析后的值，
   * 对象键已按 Go 的顺序重排，交给 gojson 写出时与 Go 逐字节相同。
   */
  input?: unknown;
  is_error?: boolean;
  session_id?: string;
  usage?: Usage;
  plan?: PlanItem[];
}

/** 按 Go struct 的字段顺序与 omitempty 排出可交给 gojson 的对象。 */
export function eventJSON(e: Event): Record<string, unknown> {
  return {
    kind: e.kind,
    text: e.text || undefined,
    tool: e.tool || undefined,
    call_id: e.call_id || undefined,
    input: e.input,
    is_error: e.is_error ? true : undefined,
    session_id: e.session_id || undefined,
    usage: e.usage ? usageJSON(e.usage) : undefined,
    plan: e.plan && e.plan.length > 0 ? e.plan.map((item) => ({ text: item.text, status: item.status })) : undefined,
  };
}

type Obj = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function obj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 读 claude 系与 opencode 的 todos 数组：[{content, status, activeForm?}]。 */
function planFromTodos(input: unknown): PlanItem[] {
  const plan: PlanItem[] = [];
  for (const item of arr(obj(input).todos)) {
    const todo = obj(item);
    let text = str(todo.content);
    if (text === '') continue;
    let status = str(todo.status);
    if (status === 'in_progress') {
      const active = str(todo.activeForm);
      if (active !== '') text = active;
    }
    if (status !== 'in_progress' && status !== 'completed') status = 'pending';
    plan.push({ text, status });
  }
  return plan;
}

/** 读 codex 的 todo_list：items 为 [{text, completed}]，第一项未完成的算进行中。 */
function planFromCodex(item: Obj): PlanItem[] {
  const plan: PlanItem[] = [];
  let current = false;
  for (const entry of arr(item.items)) {
    const todo = obj(entry);
    let status = 'pending';
    if (todo.completed === true) status = 'completed';
    else if (!current) {
      status = 'in_progress';
      current = true;
    }
    plan.push({ text: str(todo.text), status });
  }
  return plan;
}

/**
 * 把一行原始输出译成零到多条事件。Parser 有状态（会话 id 去重、用量累计），
 * 一次运行用一个。
 */
export class Parser {
  /** 目前从流里读到的会话 id；run 预先指定会话时直接写入。 */
  session = '';
  private readonly accumulated: Usage = newUsage();

  /** 不校验工具名；外部一律经 newParser 创建。 */
  constructor(readonly tool: string) {}

  /** 目前从流里读到的会话 id。 */
  sessionID(): string {
    return this.session;
  }

  /** 累计用量；一条用量事件都没读到时 usageEmpty() 为 true。 */
  usage(): Usage {
    return { ...this.accumulated };
  }

  /** 译一行。认不出的行返回空数组，不报错：各家会在流里夹带限流、钩子之类的事件。 */
  parse(line: string): Event[] {
    accumulateUsage(this.tool, line, this.accumulated);
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return [];
    }
    if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) return [];
    const e = obj(raw);
    let events: Event[];
    switch (this.tool) {
      case 'codex':
        events = parseCodex(e);
        break;
      case 'opencode':
        events = parseOpencode(e);
        break;
      default:
        events = parseClaudeLike(e);
    }
    const out: Event[] = [];
    for (const event of events) {
      if (event.kind === KindSession) {
        if (!event.session_id || event.session_id === this.session) continue;
        this.session = event.session_id;
      }
      out.push(event);
    }
    return out;
  }
}

/** 为工具创建解析器；未知工具抛错。 */
export function newParser(tool: string): Parser {
  if (!ValidTools.has(tool)) throw new Error(`未知工具：${tool}`);
  return new Parser(tool);
}

/** 对象键按 Go map 的输出顺序递归重排：对应 json.Marshal(map[string]any)。 */
function goValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(goValue);
  if (value !== null && typeof value === 'object') {
    const out: Obj = {};
    for (const key of Object.keys(value).sort(compareBytes)) out[key] = goValue((value as Obj)[key]);
    return out;
  }
  return value;
}

/** Go 的 rawJSON：nil 返回空（字段被省略）。 */
function rawJSON(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  return goValue(value);
}

/** 按 UTF-8 字节数截断到 maxToolOutput，不切坏多字节字符。 */
export function clip(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxToolOutput) return text;
  let cut = maxToolOutput;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return bytes.subarray(0, cut).toString('utf8') + '\n…（已截断）';
}

/** 处理 claude、qoder、codebuddy 共用的 stream-json；导演（director）也照这个格式输出。 */
function parseClaudeLike(e: Obj): Event[] {
  const events: Event[] = [];
  const id = str(e.session_id);
  if (id !== '') events.push({ kind: KindSession, session_id: id });
  switch (str(e.type)) {
    case 'assistant':
      for (const item of arr(obj(e.message).content)) {
        const block = obj(item);
        switch (str(block.type)) {
          case 'text': {
            const text = str(block.text);
            if (text !== '') events.push({ kind: KindText, text });
            break;
          }
          case 'thinking': {
            const text = str(block.thinking);
            if (text !== '') events.push({ kind: KindThinking, text });
            break;
          }
          case 'tool_use': {
            events.push({ kind: KindToolCall, tool: str(block.name), call_id: str(block.id), input: rawJSON(block.input) });
            if (str(block.name) === 'TodoWrite') {
              const plan = planFromTodos(block.input);
              if (plan.length > 0) events.push({ kind: KindPlan, plan });
            }
            break;
          }
        }
      }
      break;
    case 'user':
      for (const item of arr(obj(e.message).content)) {
        const block = obj(item);
        if (str(block.type) !== 'tool_result') continue;
        events.push({
          kind: KindToolResult,
          call_id: str(block.tool_use_id),
          text: clip(toolResultText(block.content)),
          is_error: block.is_error === true,
        });
      }
      break;
    case 'result':
      if (e.is_error === true) {
        let text = str(e.result);
        if (text === '') text = str(e.subtype);
        events.push({ kind: KindError, text });
      }
      break;
  }
  return events;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const text = str(obj(item).text);
      if (text !== '') parts.push(text);
    }
    return parts.join('\n');
  }
  return '';
}

/** 处理 codex exec --json 的 JSONL。 */
function parseCodex(e: Obj): Event[] {
  const item = obj(e.item);
  switch (str(e.type)) {
    case 'thread.started':
      return [{ kind: KindSession, session_id: str(e.thread_id) }];
    case 'item.started':
    case 'item.updated':
      if (str(item.type) === 'todo_list') return [{ kind: KindPlan, plan: planFromCodex(item) }];
      if (str(e.type) === 'item.started' && str(item.type) === 'command_execution') {
        return [{ kind: KindToolCall, tool: 'shell', call_id: str(item.id), input: rawJSON({ command: item.command ?? null }) }];
      }
      break;
    case 'item.completed':
      switch (str(item.type)) {
        case 'agent_message':
          return [{ kind: KindText, text: str(item.text) }];
        case 'todo_list':
          return [{ kind: KindPlan, plan: planFromCodex(item) }];
        case 'reasoning':
          return [{ kind: KindThinking, text: str(item.text) }];
        case 'command_execution': {
          const code = typeof item.exit_code === 'number' ? item.exit_code : 0;
          return [{ kind: KindToolResult, tool: 'shell', call_id: str(item.id), text: clip(str(item.aggregated_output)), is_error: code !== 0 }];
        }
        case 'file_change':
        case 'mcp_tool_call':
        case 'web_search': {
          const failed = str(item.status) === 'failed';
          return [{ kind: KindToolResult, tool: str(item.type), call_id: str(item.id), input: rawJSON(item), is_error: failed }];
        }
        case 'error':
          return [{ kind: KindError, text: str(item.message) }];
      }
      break;
    case 'turn.failed':
      return [{ kind: KindError, text: str(obj(e.error).message) }];
    case 'error':
      return [{ kind: KindError, text: str(e.message) }];
  }
  return [];
}

/** 处理 opencode run --format json 的 JSONL（2.x）。 */
function parseOpencode(e: Obj): Event[] {
  const events: Event[] = [];
  const id = str(e.sessionID);
  if (id !== '') events.push({ kind: KindSession, session_id: id });
  const part = obj(e.part);
  switch (str(e.type)) {
    case 'text': {
      const text = str(part.text);
      if (text !== '') events.push({ kind: KindText, text });
      break;
    }
    case 'reasoning': {
      const text = str(part.text);
      if (text !== '') events.push({ kind: KindThinking, text });
      break;
    }
    case 'tool_use': {
      const state = obj(part.state);
      const callID = str(part.id);
      const tool = str(part.tool);
      events.push({ kind: KindToolCall, tool, call_id: callID, input: rawJSON(state.input) });
      if (tool === 'todowrite') {
        const plan = planFromTodos(state.input);
        if (plan.length > 0) events.push({ kind: KindPlan, plan });
      }
      switch (str(state.status)) {
        case 'completed':
          events.push({ kind: KindToolResult, tool, call_id: callID, text: clip(str(state.output)) });
          break;
        case 'error':
          events.push({ kind: KindToolResult, tool, call_id: callID, text: clip(str(state.error)), is_error: true });
          break;
      }
      break;
    }
    case 'error': {
      let message = str(obj(e.error).message);
      if (message === '') message = str(obj(obj(e.error).data).message);
      events.push({ kind: KindError, text: message });
      break;
    }
  }
  return events;
}
