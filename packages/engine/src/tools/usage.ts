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
  /**
   * 按额度计费的工具报的额度（qoder 的 total_credits；它不报 token 也不报费用，2026-11 实测 1.1.89）。
   * null / undefined 表示没报；与 cost_usd 一样只在双方都有时相加。
   */
  credits?: number | null;
  turns?: number;
  /** 最近一次模型请求的输入量，仅用于判断上下文大小，不参与汇总。 */
  last_request_input_tokens?: number;
  /** 汇总里有的部分没读到用量或费用，数字只是下限。 */
  partial?: boolean;
  /** 标明口径：都是 BasisTotalInput（输入含缓存）。 */
  basis?: string;
  /** 记下数字来自哪种事件，方便日后核对格式是否变了。 */
  source?: string;
  /**
   * CLI 在 result 里报的整个会话的累计值（只有续接时数字会累计的工具才有，见 cumulativeFields）。
   * 不参与汇总，只给同一会话下一次续接当基线（sessionBaseline）。
   */
  session_total?: SessionTotal;
  /**
   * 续接同一个 CLI 会话前由调用方给的基线：上一次记下的会话累计值（sessionBaseline）。
   * 不给（undefined）表示新会话；null 表示续接了但不知道上一次累计到多少，累计的那几项就记成不知道。不写出。
   */
  baseline?: SessionTotal | null;
}

/** 会话累计值：按 Usage 的口径（输入含缓存）。 */
export interface SessionTotal {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: number | null;
  credits?: number | null;
  turns: number;
}

/**
 * 哪些工具续接时 result 报的是整个会话的累计值，累计的是哪几项（2026-11 实测）：
 *   - claude 2.1.325：total_cost_usd 与 modelUsage 从会话开头累计，usage 与 num_turns 只算这一次。
 *     第一次 $0.000731、续接后报 $0.000921，后者正是两次之和。
 *   - codebuddy：usage 与 num_turns 也累计（第一次 input 26942、续接后 53939，num_turns 3 → 6）。
 *   - qoder 1.1.89：total_credits 累计（同一会话四轮依次报 0.0139、0.0213、0.0287、0.0349，后三轮都只回一句 ok）。
 * 不在表里的（qoder 不报费用，director 是自己写的流，每个进程从零算）按「只算这一次」处理。
 * 不处理的话每轮都把会话至今的花费再记一遍：一个整片会话 30 轮，账本加总是实际的 10 倍（片场宣传视频：$394 对 $38）。
 */
function cumulativeFields(tool: string): { cost: boolean; tokens: boolean; credits: boolean } {
  switch (tool) {
    case 'claude':
      return { cost: true, tokens: false, credits: false };
    case 'codebuddy':
      return { cost: true, tokens: true, credits: false };
    case 'qoder':
    case 'qoder-intl':
      return { cost: false, tokens: false, credits: true };
    default:
      return { cost: false, tokens: false, credits: false };
  }
}

/**
 * 同一会话下一次续接用的基线：上一次记下的用量里的 session_total；
 * 旧记录没有它时，按旧的写法它记的就是 CLI 报的原值（费用是累计的），拿来当基线。没有上一次的记录返回 null。
 */
export function sessionBaseline(previous: Usage | null | undefined): SessionTotal | null {
  if (!previous || usageEmpty(previous)) return null;
  if (previous.session_total) return { ...previous.session_total };
  return {
    input_tokens: previous.input_tokens ?? 0,
    output_tokens: previous.output_tokens ?? 0,
    cached_input_tokens: previous.cached_input_tokens ?? 0,
    cost_usd: previous.cost_usd ?? null,
    credits: previous.credits ?? null,
    turns: previous.turns ?? 0,
  };
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
    credits: u.credits ?? undefined,
    turns: u.turns ? u.turns : undefined,
    last_request_input_tokens: u.last_request_input_tokens || undefined,
    partial: u.partial ? true : undefined,
    basis: u.basis ? u.basis : undefined,
    source: u.source ? u.source : undefined,
    session_total: u.session_total
      ? {
          input_tokens: u.session_total.input_tokens,
          output_tokens: u.session_total.output_tokens,
          cached_input_tokens: u.session_total.cached_input_tokens,
          cost_usd: u.session_total.cost_usd ?? undefined,
          credits: u.session_total.credits ?? undefined,
          turns: u.session_total.turns,
        }
      : undefined,
  };
}

/** 零值字段补齐后的副本（Go 的值拷贝）。 */
function copyUsage(u: Usage): Usage {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cached_input_tokens: u.cached_input_tokens ?? 0,
    cost_usd: u.cost_usd ?? null,
    credits: u.credits ?? null,
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
  other = copyUsage(other);
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
      credits: other.credits ?? null,
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
  // 额度只有按额度计费的工具才报：一方没有不算「不完整」（claude 本来就没有额度），有就加上。
  if (other.credits != null) u.credits = (u.credits ?? 0) + other.credits;
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
 *   - mcode（exec --output-format stream-json）：每轮结束的 {"type":"turn.completed"} 带该轮 usage：
 *     inputTokens 不含缓存（totalTokens = inputTokens + outputTokens），cacheReadTokens / cacheWriteTokens 另列，
 *     要加回输入（2026-11 用 0.6.12 实测）。一次 exec 一轮；exec.completed 里是同一份，不再算。
 *
 * 其他工具读不到就留空，尝试记录里照常写耗时。
 */
export function accumulateUsage(tool: string, line: string, u: Usage): void {
  if (tool === 'opencode') {
    accumulateOpencodeUsage(line, u);
    return;
  }
  if (tool === 'mcode') {
    accumulateMcodeUsage(line, u);
    return;
  }
  const event = parseObject(line);
  if (!event) return;
  let type: string, cost: number | null, credits: number | null, turns: number;
  let input: number, output: number, cached: number, cacheRead: number, cacheCreate: number;
  try {
    type = stringField(event, 'type');
    cost = floatPtrField(event, 'total_cost_usd');
    credits = floatPtrField(event, 'total_credits');
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
  } else if ((tool === 'claude' || tool === 'qoder' || tool === 'qoder-intl' || tool === 'codebuddy' || tool === 'director') && type === 'result') {
    const reported: SessionTotal = { input_tokens: input + cacheCreate + cacheRead, output_tokens: output, cached_input_tokens: cacheRead, cost_usd: cost, credits, turns };
    const cumulative = cumulativeFields(tool);
    const baseline = u.baseline;
    let mine = reported;
    if (cumulative.cost || cumulative.tokens || cumulative.credits) {
      u.session_total = { ...reported };
      if (baseline === null) {
        // 续接了却不知道上一次累计到多少：累计的几项报不出这一次的数，照实记成不知道。
        mine = { ...reported };
        if (cumulative.cost) mine.cost_usd = null;
        if (cumulative.credits) mine.credits = null;
        if (cumulative.tokens) mine = { ...mine, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, turns: 0 };
        u.partial = true;
      } else if (baseline !== undefined) {
        mine = { ...reported };
        if (cumulative.cost) mine.cost_usd = subtractCost(reported.cost_usd, baseline.cost_usd);
        if (cumulative.credits) mine.credits = subtractCost(reported.credits ?? null, baseline.credits ?? null);
        if (cumulative.tokens && reported.input_tokens >= baseline.input_tokens && reported.turns >= baseline.turns) {
          mine.input_tokens = reported.input_tokens - baseline.input_tokens;
          mine.output_tokens = Math.max(reported.output_tokens - baseline.output_tokens, 0);
          mine.cached_input_tokens = Math.max(reported.cached_input_tokens - baseline.cached_input_tokens, 0);
          mine.turns = reported.turns - baseline.turns;
        }
      }
    }
    u.input_tokens = mine.input_tokens;
    u.output_tokens = mine.output_tokens;
    u.cached_input_tokens = mine.cached_input_tokens;
    u.cost_usd = mine.cost_usd;
    u.credits = mine.credits ?? null;
    u.turns = mine.turns;
    u.source = tool + ' result';
    u.basis = BasisTotalInput;
  }
}

/** 会话累计费用减去基线；累计值比基线小说明会话被换掉了（重开），这时报的就是这一次的。 */
function subtractCost(reported: number | null, baseline: number | null): number | null {
  if (reported === null) return null;
  if (baseline === null) return null;
  if (reported < baseline) return reported;
  return reported - baseline;
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

function accumulateMcodeUsage(line: string, u: Usage): void {
  const event = parseObject(line);
  if (!event) return;
  let input: number, output: number, read: number, write: number;
  try {
    if (stringField(event, 'type') !== 'turn.completed') return;
    const usage = objectField(event, 'usage');
    if (!usage) return;
    input = intField(usage, 'inputTokens');
    output = intField(usage, 'outputTokens');
    read = intField(usage, 'cacheReadTokens');
    write = intField(usage, 'cacheWriteTokens');
  } catch (err) {
    if (err instanceof BadEvent) return;
    throw err;
  }
  u.input_tokens = (u.input_tokens ?? 0) + input + read + write;
  u.output_tokens = (u.output_tokens ?? 0) + output;
  u.cached_input_tokens = (u.cached_input_tokens ?? 0) + read;
  u.turns = (u.turns ?? 0) + 1;
  u.source = 'mcode turn.completed';
  u.basis = BasisTotalInput;
}

/** 把用量写成一行给人看的文字；没读到时如实说没读到。 */
export function formatUsage(u: Usage): string {
  u = copyUsage(u);
  if (usageEmpty(u)) return '未读到用量';
  let text = `输入 ${groupDigits(u.input_tokens!)}（其中缓存 ${groupDigits(u.cached_input_tokens!)}）· 输出 ${groupDigits(u.output_tokens!)} · 合计 ${groupDigits(usageTotal(u))} token`;
  if (u.cost_usd != null) text += ` · $${u.cost_usd.toFixed(4)}`;
  if (u.credits != null) text += ` · 额度 ${u.credits.toFixed(2)}`;
  if (u.partial) text += '（有的尝试没读到用量，这是下限）';
  return text;
}

function groupDigits(n: number): string {
  if (n < 0) return '-' + groupDigits(-n);
  let s = String(n);
  for (let i = s.length - 3; i > 0; i -= 3) s = s.slice(0, i) + ',' + s.slice(i);
  return s;
}
