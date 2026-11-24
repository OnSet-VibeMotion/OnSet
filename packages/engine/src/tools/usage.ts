/**
 * 各渲染 / 编排工具流式 JSON 用量解析与增量累加。
 */
import { BasisTotalInput, type SessionTotal, type Usage } from './usage_core';

export {
  BasisTotalInput,
  formatUsage,
  newUsage,
  type SessionTotal,
  sessionBaseline,
  type Usage,
  usageAdd,
  usageEmpty,
  usageJSON,
  usageTotal,
} from './usage_core';

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
    case 'agy':
      return { cost: false, tokens: true, credits: false };
    case 'qoder':
    case 'qoder-intl':
      return { cost: false, tokens: false, credits: true };
    default:
      return { cost: false, tokens: false, credits: false };
  }
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
  if (tool === 'agy') {
    accumulateAgyUsage(line, u);
    return;
  }
  const event = parseObject(line);
  if (!event) return;
  let type: string;
  let cost: number | null;
  let credits: number | null;
  let turns: number;
  let input: number;
  let output: number;
  let cached: number;
  let cacheRead: number;
  let cacheCreate: number;
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
  } else if (
    (tool === 'claude' || tool === 'qoder' || tool === 'qoder-intl' || tool === 'codebuddy' || tool === 'director') &&
    type === 'result'
  ) {
    const reported: SessionTotal = {
      input_tokens: input + cacheCreate + cacheRead,
      output_tokens: output,
      cached_input_tokens: cacheRead,
      cost_usd: cost,
      credits,
      turns,
    };
    applyResultUsage(tool, reported, u);
  }
}

function applyResultUsage(tool: string, reported: SessionTotal, u: Usage): void {
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
  let type: string;
  let cost: number | null;
  let tokens: Record<string, unknown> | undefined;
  let input: number;
  let output: number;
  let reasoning: number;
  let read: number;
  let write: number;
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
    if (u.cost_usd !== null && u.cost_usd !== undefined) total += u.cost_usd;
    u.cost_usd = total;
  }
  u.turns = (u.turns ?? 0) + 1;
  u.source = 'opencode step_finish';
  u.basis = BasisTotalInput;
}

function accumulateMcodeUsage(line: string, u: Usage): void {
  const event = parseObject(line);
  if (!event) return;
  let input: number;
  let output: number;
  let read: number;
  let write: number;
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

/**
 * Antigravity CLI（`agy --output-format stream-json`，v1.5.13 实测）：
 * - 每步完成有 `{"event":"step_update","step_update":{"state":"DONE","step_type":"agent_response","usage":{"input_tokens":…,"cache_read_tokens":…}}}`，
 *   用来统计真实模型调用步数与最近一次请求的上下文大小；
 * - 收尾的 `{"event":"result","result":{"num_turns":…,"usage":{"input_tokens":…,"output_tokens":…,"thinking_tokens":…,"cache_read_tokens":…}}}`。
 * input_tokens 不含 cache_read_tokens，output_tokens 已含 thinking_tokens；--conversation 续接后 result 是整个会话的累计值。
 */
function accumulateAgyUsage(line: string, u: Usage): void {
  const event = parseObject(line);
  if (!event) return;
  let kind: string;
  try {
    kind = stringField(event, 'event');
  } catch (err) {
    if (err instanceof BadEvent) return;
    throw err;
  }
  if (kind === 'step_update') {
    try {
      const step = objectField(event, 'step_update');
      if (!step || stringField(step, 'state') !== 'DONE' || stringField(step, 'step_type') !== 'agent_response') return;
      const usage = objectField(step, 'usage');
      if (!usage) return;
      const reqInput = intField(usage, 'input_tokens') + intField(usage, 'cache_read_tokens');
      u.turns = (u.turns ?? 0) + 1;
      if (reqInput > 0) u.last_request_input_tokens = reqInput;
    } catch (err) {
      if (err instanceof BadEvent) return;
      throw err;
    }
    return;
  }
  if (kind !== 'result') return;
  let input: number;
  let output: number;
  let cacheRead: number;
  let turns: number;
  try {
    const result = objectField(event, 'result');
    if (!result) return;
    const usage = objectField(result, 'usage');
    if (!usage) return;
    turns = intField(result, 'num_turns');
    input = intField(usage, 'input_tokens');
    output = intField(usage, 'output_tokens');
    cacheRead = intField(usage, 'cache_read_tokens');
  } catch (err) {
    if (err instanceof BadEvent) return;
    throw err;
  }
  const stepTurns = u.turns ?? 0;
  applyResultUsage(
    'agy',
    {
      input_tokens: input + cacheRead,
      output_tokens: output,
      cached_input_tokens: cacheRead,
      cost_usd: null,
      credits: null,
      turns,
    },
    u,
  );
  if (stepTurns > (u.turns ?? 0)) u.turns = stepTurns;
}
