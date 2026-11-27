import { compareBytes } from '../gojson';
import { type Usage, usageJSON } from '../tools';

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
/** 当前进程的后台任务完整快照；空数组表示全部结束。 */
export const KindBackgroundTasks: Kind = 'background-tasks';
export const KindContextCompaction: Kind = 'context-compaction';

export interface ContextCompaction {
  /** ended 只表示工具退出了压缩状态，不保证成功；completed 必须有明确的完成事件。 */
  state: 'running' | 'completed' | 'ended' | 'failed' | 'cancelled';
  pre_tokens?: number;
  post_tokens?: number;
}

/** 各家只转换明确的生命周期信号；没有成功信号时用 ended。 */
export function compactionEvent(state: ContextCompaction['state']): Event {
  const text = {
    running: '正在压缩上下文',
    completed: '上下文压缩完成',
    ended: '上下文压缩阶段结束，等待模型继续',
    failed: '上下文压缩失败',
    cancelled: '上下文压缩已取消',
  }[state];
  return { kind: KindContextCompaction, text, compaction: { state } };
}

export interface BackgroundTask {
  id: string;
  description: string;
  activity?: string;
}

/** 待办清单的一项。status 是 pending、in_progress 或 completed。 */
export interface PlanItem {
  text: string;
  status: string;
  /** 任务编号：只有逐条建、逐条改的任务工具（TaskCreate / TaskUpdate）才有，续接时靠它接上（TaskBoard）。 */
  id?: string;
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
  /** 流式思考的分批文本；同一轮里同一 text_id 按原样拼接，不另加换行。 */
  text_id?: string;
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
  background_tasks?: BackgroundTask[];
  compaction?: ContextCompaction;
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
    background_tasks: e.background_tasks,
    text_id: e.text_id || undefined,
    compaction: e.compaction,
  };
}

export type Obj = Record<string, unknown>;

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function obj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
export function rawJSON(value: unknown): unknown {
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

export function toolResultText(content: unknown): string {
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

/** 读 claude 系与 opencode 的 todos 数组：[{content, status, activeForm?}]。 */
export function planFromTodos(input: unknown): PlanItem[] {
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

const RoutedOnsetToolPattern = /^(?:mcp__onset__|mcp_onset_|onset[._])?(?:tool_call|onset_call)$/;

/**
 * 把经 tool_call / onset_call 路由调用的 onset 扩展工具拆回真实操作名 mcp__onset__<op> 与参数对象，
 * 保证全 9 家编排后端与内置制作人在客户端时间线、状态栏、中文动词与进度归类上 100% 透明一致。
 */
export function unwrapOnsetToolCall(name: string, input: unknown): { tool: string; input: unknown } {
  if (!RoutedOnsetToolPattern.test(name)) return { tool: name, input };
  const o = obj(input);
  const toolName = str(o.tool).trim();
  if (toolName === '') return { tool: name, input };
  let args: unknown = o.arguments ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      // 非法 JSON 保留原值供界面显示。
    }
  }
  return { tool: `mcp__onset__${toolName}`, input: args };
}
