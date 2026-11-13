// 移植自 internal/tools/usage.go。

/**
 * 从渲染工具输出流里读到的用量。字段缺失就保持零值（undefined 视同 0）或 null，
 * 不做估算：报出一个编出来的数比不报更误导。
 *
 * 各家的口径不同，这里统一成一种，跨工具才能比、才能相加：
 *   - input_tokens 是全部输入，含缓存命中与缓存写入。codex 原样就是这个口径；
 *     claude 系与 opencode 的 input 不含缓存，要把缓存读写加回来——不加的话
 *     claude 一次渲染显示「输入 4、缓存 40437」，缓存比输入还大。
 *   - cached_input_tokens 是输入里命中缓存的部分，恒不大于 input_tokens。
 *   - output_tokens 含推理 / 思考 token。opencode 单列 reasoning，要加回来。
 *
 * 字段名照抄 Go 的 struct tag，从 JSON 读回的对象可以直接当 Usage 用。
 * 写出 JSON 时一律经 usageJSON（字段顺序与 omitempty 与 Go 一致）。
 */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  /** null / undefined 表示不知道费用（Go 的 nil 指针）；0 是「知道且为 0」。 */
  cost_usd?: number | null;
  turns?: number;
  /** 汇总里有的部分没读到用量或费用，数字只是下限。 */
  partial?: boolean;
  /**
   * 标明口径。新记录都是 BasisTotalInput；没有这个字段的是统一口径之前
   * 写下的老记录，读的时候用 usageNormalized 换算。
   */
  basis?: string;
  /** 记下数字来自哪种事件，方便日后核对格式是否变了。 */
  source?: string;
}

/** 统一后的口径：输入含缓存。 */
export const BasisTotalInput = 'total-input';

/** 按 Go struct 的字段顺序与 omitempty 规则排出一个可交给 gojson 的对象。 */
export function usageJSON(u: Usage): Record<string, unknown> {
  return {
    input_tokens: u.input_tokens ? u.input_tokens : undefined,
    output_tokens: u.output_tokens ? u.output_tokens : undefined,
    cached_input_tokens: u.cached_input_tokens ? u.cached_input_tokens : undefined,
    cost_usd: u.cost_usd ?? undefined,
    turns: u.turns ? u.turns : undefined,
    partial: u.partial ? true : undefined,
    basis: u.basis ? u.basis : undefined,
    source: u.source ? u.source : undefined,
  };
}

/** 零值字段补齐后的副本（Go 的值拷贝）。 */
function copyUsage(u: Usage): Usage {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cached_input_tokens: u.cached_input_tokens ?? 0,
    cost_usd: u.cost_usd ?? null,
    turns: u.turns ?? 0,
    partial: u.partial ?? false,
    basis: u.basis ?? '',
    source: u.source ?? '',
  };
}

/** 零值 Usage。 */
export function newUsage(): Usage {
  return copyUsage({});
}

/**
 * 把老记录换成统一口径。claude 系与 opencode 的老记录输入里不含缓存
 * 命中，加回去；opencode 老记录没记缓存写入与推理 token，补不回来，只能偏低。
 */
export function usageNormalized(u: Usage): Usage {
  const out = copyUsage(u);
  if (out.basis !== '' || usageEmpty(out)) return out;
  switch (out.source) {
    case 'claude result':
    case 'qoder result':
    case 'codebuddy result':
    case 'opencode step_finish':
      out.input_tokens = out.input_tokens! + out.cached_input_tokens!;
  }
  out.basis = BasisTotalInput;
  return out;
}

/** 一个用量事件都没读到。 */
export function usageEmpty(u: Usage): boolean {
  return !u.source;
}

/** 输入加输出的总 token 数。 */
export function usageTotal(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
}

/**
 * 把 other 并进 u（原地修改），用于跨尝试、跨镜头汇总。费用只在双方都有时相加，
 * 一方缺失时保留已知部分并标出不完整（partial）。
 */
export function usageAdd(u: Usage, other: Usage): void {
  other = usageNormalized(other);
  if (usageEmpty(other)) {
    // 没读到用量的一次也要留下痕迹：之后读到的数字就只是下限了。
    u.partial = true;
    return;
  }
  if (usageEmpty(u)) {
    const partial = u.partial ?? false;
    Object.assign(u, {
      input_tokens: other.input_tokens,
      output_tokens: other.output_tokens,
      cached_input_tokens: other.cached_input_tokens,
      cost_usd: other.cost_usd ?? null,
      turns: other.turns,
      source: other.source,
      partial: other.partial || partial,
      basis: BasisTotalInput,
    });
    return;
  }
  u.input_tokens = (u.input_tokens ?? 0) + other.input_tokens!;
  u.output_tokens = (u.output_tokens ?? 0) + other.output_tokens!;
  u.cached_input_tokens = (u.cached_input_tokens ?? 0) + other.cached_input_tokens!;
  u.turns = (u.turns ?? 0) + other.turns!;
  u.partial = (u.partial ?? false) || other.partial!;
  const mine = u.cost_usd ?? null;
  const theirs = other.cost_usd ?? null;
  if (mine !== null && theirs !== null) u.cost_usd = mine + theirs;
  else if (mine !== null || theirs !== null) u.partial = true;
  if (u.source !== other.source) u.source = 'mixed';
}

class BadEvent extends Error {}

/** 解析一行 JSON 对象；不是对象时返回 undefined（Go 的 Unmarshal 进 struct 失败）。null 视同空对象。 */
function parseObject(line: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 按 Go 的 struct 字段语义读整数：缺失或 null 为 0，类型不符让整次解析失败。 */
function intField(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new BadEvent();
  return v;
}

function floatPtrField(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number') throw new BadEvent();
  return v;
}

function stringField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new BadEvent();
  return v;
}

/** 读一个嵌套对象：缺失或 null 返回 undefined（Go 的 nil 指针），不是对象让解析失败。 */
function objectField(o: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new BadEvent();
  return v as Record<string, unknown>;
}

/**
 * 把输出流的一行并进 u（原地修改）。认不出的行原样忽略。
 *
 * 格式按各工具的流式 JSON 约定读取，没有逐个版本实测，所以这里只是尽力而为：
 *   - claude 系（stream-json）：收尾的 {"type":"result"} 事件带整次调用的
 *     usage、total_cost_usd 与 num_turns，是累计值，以最后一条为准。
 *   - codex（exec --json）：每轮结束的 {"type":"turn.completed"} 带该轮 usage，逐轮相加。
 *   - opencode（run --format json）：每步结束的 {"type":"step_finish"} 在 part 里带
 *     该步的 tokens 与 cost，逐步相加（2026-11 用 v2.1.0 实测）。
 *
 * 其他工具读不到就留空，尝试记录里照常写耗时。
 */
export function accumulateUsage(tool: string, line: string, u: Usage): void {
  if (tool === 'opencode') {
    accumulateOpencodeUsage(line, u);
    return;
  }
  const event = parseObject(line);
  if (!event) return;
  let type: string, cost: number | null, turns: number;
  let input: number, output: number, cached: number, cacheRead: number, cacheCreate: number;
  try {
    type = stringField(event, 'type');
    cost = floatPtrField(event, 'total_cost_usd');
    turns = intField(event, 'num_turns');
    const usage = objectField(event, 'usage');
    if (!usage) return;
    input = intField(usage, 'input_tokens');
    output = intField(usage, 'output_tokens');
    cached = intField(usage, 'cached_input_tokens');
    cacheRead = intField(usage, 'cache_read_input_tokens');
    cacheCreate = intField(usage, 'cache_creation_input_tokens');
  } catch (err) {
    if (err instanceof BadEvent) return;
    throw err;
  }
  if (tool === 'codex' && type === 'turn.completed') {
    u.input_tokens = (u.input_tokens ?? 0) + input;
    u.output_tokens = (u.output_tokens ?? 0) + output;
    u.cached_input_tokens = (u.cached_input_tokens ?? 0) + cached;
    u.turns = (u.turns ?? 0) + 1;
    u.source = 'codex turn.completed';
    u.basis = BasisTotalInput;
  } else if ((tool === 'claude' || tool === 'qoder' || tool === 'codebuddy') && type === 'result') {
    u.input_tokens = input + cacheCreate + cacheRead;
    u.output_tokens = output;
    u.cached_input_tokens = cacheRead;
    u.cost_usd = cost;
    u.turns = turns;
    u.source = tool + ' result';
    u.basis = BasisTotalInput;
  }
}

function accumulateOpencodeUsage(line: string, u: Usage): void {
  const event = parseObject(line);
  if (!event) return;
  let type: string, cost: number | null;
  let tokens: Record<string, unknown> | undefined;
  let input: number, output: number, reasoning: number, read: number, write: number;
  try {
    type = stringField(event, 'type');
    const part = objectField(event, 'part') ?? {};
    cost = floatPtrField(part, 'cost');
    tokens = objectField(part, 'tokens');
    if (!tokens) {
      input = output = reasoning = read = write = 0;
    } else {
      input = intField(tokens, 'input');
      output = intField(tokens, 'output');
      reasoning = intField(tokens, 'reasoning');
      const cache = objectField(tokens, 'cache') ?? {};
      read = intField(cache, 'read');
      write = intField(cache, 'write');
    }
  } catch (err) {
    if (err instanceof BadEvent) return;
    throw err;
  }
  if (type !== 'step_finish' || !tokens) return;
  u.input_tokens = (u.input_tokens ?? 0) + input + read + write;
  u.output_tokens = (u.output_tokens ?? 0) + output + reasoning;
  u.cached_input_tokens = (u.cached_input_tokens ?? 0) + read;
  if (cost !== null) {
    let total = cost;
    if (u.cost_usd != null) total += u.cost_usd;
    u.cost_usd = total;
  }
  u.turns = (u.turns ?? 0) + 1;
  u.source = 'opencode step_finish';
  u.basis = BasisTotalInput;
}

/** 把用量写成一行给人看的文字；没读到时如实说没读到。 */
export function formatUsage(u: Usage): string {
  u = usageNormalized(u);
  if (usageEmpty(u)) return '未读到用量';
  let text = `输入 ${groupDigits(u.input_tokens!)}（其中缓存 ${groupDigits(u.cached_input_tokens!)}）· 输出 ${groupDigits(u.output_tokens!)} · 合计 ${groupDigits(usageTotal(u))} token`;
  if (u.cost_usd != null) text += ` · $${u.cost_usd.toFixed(4)}`;
  if (u.partial) text += '（有的尝试没读到用量，这是下限）';
  return text;
}

function groupDigits(n: number): string {
  if (n < 0) return '-' + groupDigits(-n);
  let s = String(n);
  for (let i = s.length - 3; i > 0; i -= 3) s = s.slice(0, i) + ',' + s.slice(i);
  return s;
}
