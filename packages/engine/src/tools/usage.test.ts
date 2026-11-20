import { describe, expect, it } from 'vitest';
import { marshal } from '../gojson';
import { BasisTotalInput, accumulateUsage, formatUsage, newUsage, sessionBaseline, usageAdd, usageEmpty, usageJSON, usageTotal } from './index';

describe('usage', () => {
  it('accumulate usage reads claude result event', () => {
    const u = newUsage();
    accumulateUsage('claude', `{"type":"assistant","message":{"content":[]}}`, u);
    // assistant 事件不该产生用量。
    expect(usageEmpty(u)).toBe(true);
    accumulateUsage('claude', `{"type":"result","num_turns":7,"total_cost_usd":0.42,"usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":300,"output_tokens":50}}`, u);
    // 输入含缓存读写：100 + 20 + 300。
    expect(u).toMatchObject({ input_tokens: 420, output_tokens: 50, cached_input_tokens: 300, turns: 7, cost_usd: 0.42 });
  });

  it('accumulate usage sums codex turns', () => {
    const u = newUsage();
    for (let i = 0; i < 2; i++) accumulateUsage('codex', `{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3}}`, u);
    accumulateUsage('codex', 'not json', u);
    expect(u).toMatchObject({ input_tokens: 20, output_tokens: 6, cached_input_tokens: 8, turns: 2, cost_usd: null });
  });

  // 三家的口径统一成「输入含缓存、缓存不大于输入、输出含推理」，数字取自真实录制的流。
  it('usage is comparable across tools', () => {
    const cases: [string, string, number, number, number][] = [
      ['claude', `{"type":"result","usage":{"input_tokens":4,"cache_creation_input_tokens":18803,"cache_read_input_tokens":40437,"output_tokens":207}}`, 59244, 40437, 207],
      ['codex', `{"type":"turn.completed","usage":{"input_tokens":41579,"cached_input_tokens":32768,"output_tokens":55}}`, 41579, 32768, 55],
      ['opencode', `{"type":"step_finish","part":{"tokens":{"input":3410,"output":36,"reasoning":16,"cache":{"read":16976,"write":0}}}}`, 20386, 16976, 52],
      ['mcode', `{"schemaVersion":1,"type":"turn.completed","model":{"providerId":"minimax","modelId":"MiniMax-M3.1-Flash"},"usage":{"inputTokens":29948,"outputTokens":751,"cacheReadTokens":33591,"totalTokens":30699}}`, 63539, 33591, 751],
      ['agy', `{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","num_turns":1,"usage":{"input_tokens":14216,"output_tokens":74,"thinking_tokens":20,"cache_read_tokens":9973,"total_tokens":14290}}}`, 24189, 9973, 74],
    ];
    for (const [tool, line, input, cached, output] of cases) {
      const u = newUsage();
      accumulateUsage(tool, line, u);
      expect(u, tool).toMatchObject({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
      expect(u.cached_input_tokens!).toBeLessThanOrEqual(u.input_tokens!);
    }
  });

  it('usage add marks partial totals', () => {
    const total = newUsage();
    usageAdd(total, { input_tokens: 10, output_tokens: 2, cost_usd: 0.5, source: 'claude result' });
    usageAdd(total, { input_tokens: 5, output_tokens: 1, cost_usd: 0.5, source: 'claude result' });
    expect(usageTotal(total)).toBe(18);
    expect(total.cost_usd).toBe(1);
    expect(total.partial).toBe(false);
    usageAdd(total, {});
    // 有一次没读到用量时总数只是下限。
    expect(total.partial).toBe(true);
    const mixed = newUsage();
    usageAdd(mixed, { input_tokens: 1, source: 'codex turn.completed' });
    usageAdd(mixed, { input_tokens: 1, cost_usd: 0.5, source: 'claude result' });
    // 费用只有一部分知道时要标出。
    expect(mixed.partial).toBe(true);
    expect(mixed.source).toBe('mixed');
  });

  it('usage add remembers missing first attempt', () => {
    const total = newUsage();
    usageAdd(total, {});
    usageAdd(total, { input_tokens: 3, source: 'codex turn.completed' });
    // 第一次没读到用量，合计只是下限。
    expect(total.partial).toBe(true);
    expect(total.input_tokens).toBe(3);
    expect(formatUsage({})).toBe('未读到用量');
    expect(formatUsage({ input_tokens: 1234567, source: 'x' })).toContain('1,234,567');
  });

  // TS 额外：写出的 JSON 与 Go struct 的字段顺序、omitempty 一致（指针 0 费用照写）。
  it('usage JSON matches Go field order and omitempty', () => {
    expect(marshal(usageJSON(newUsage()))).toBe('{}');
    expect(marshal(usageJSON({ source: 's', cost_usd: 0, turns: 1, input_tokens: 2, basis: BasisTotalInput }))).toBe(
      '{"input_tokens":2,"cost_usd":0,"turns":1,"basis":"total-input","source":"s"}',
    );
  });

  // 2026-11 实测：claude 续接后 total_cost_usd 是整个会话的累计值，usage 与 num_turns 只算这一次。
  it('claude resume reports the session cost cumulatively', () => {
    const first = newUsage();
    accumulateUsage('claude', '{"type":"result","num_turns":1,"total_cost_usd":0.00073109,"usage":{"input_tokens":2,"cache_read_input_tokens":649,"cache_creation_input_tokens":3612,"output_tokens":4}}', first);
    expect(first.cost_usd).toBeCloseTo(0.00073109, 10);
    expect(first.session_total?.cost_usd).toBeCloseTo(0.00073109, 10);

    const second: typeof first = { ...newUsage(), baseline: sessionBaseline(first) };
    accumulateUsage('claude', '{"type":"result","num_turns":1,"total_cost_usd":0.00092085,"usage":{"input_tokens":2,"cache_read_input_tokens":3536,"cache_creation_input_tokens":761,"output_tokens":4}}', second);
    expect(second.cost_usd).toBeCloseTo(0.00018976, 10);
    expect(second.input_tokens).toBe(2 + 3536 + 761);
    expect(second.turns).toBe(1);
    expect(second.session_total?.cost_usd).toBeCloseTo(0.00092085, 10);
    // 基线不写进记录；会话累计值写进去，给再下一次续接用。
    expect(marshal(usageJSON(second))).toContain('"session_total":');
    expect(marshal(usageJSON(second))).not.toContain('baseline');

    // 续接了却不知道之前累计到多少：费用照实记成不知道。
    const unknown: typeof first = { ...newUsage(), baseline: null };
    accumulateUsage('claude', '{"type":"result","num_turns":1,"total_cost_usd":0.00092085,"usage":{"input_tokens":2,"output_tokens":4}}', unknown);
    expect(unknown.cost_usd).toBeNull();
    expect(unknown.partial).toBe(true);
    expect(unknown.input_tokens).toBe(2);
  });

  // 2026-11 实测：codebuddy 续接后 usage 与 num_turns 也是累计值。
  it('codebuddy resume reports tokens and turns cumulatively', () => {
    const first = newUsage();
    accumulateUsage('codebuddy', '{"type":"result","num_turns":3,"total_cost_usd":0,"usage":{"input_tokens":26942,"cache_read_input_tokens":3072,"output_tokens":36}}', first);
    const second: typeof first = { ...newUsage(), baseline: sessionBaseline(first) };
    accumulateUsage('codebuddy', '{"type":"result","num_turns":6,"total_cost_usd":0,"usage":{"input_tokens":53939,"cache_read_input_tokens":29696,"output_tokens":60}}', second);
    expect(second.input_tokens).toBe(53939 + 29696 - (26942 + 3072));
    expect(second.cached_input_tokens).toBe(29696 - 3072);
    expect(second.output_tokens).toBe(24);
    expect(second.turns).toBe(3);
  });

  // 2026-11 实测：agy --conversation 续接后 result.usage 与 num_turns 也是整个会话的累计值。
  it('agy resume reports tokens and turns cumulatively', () => {
    const first = newUsage();
    accumulateUsage('agy', '{"event":"result","result":{"num_turns":1,"usage":{"input_tokens":14216,"output_tokens":74,"thinking_tokens":0,"cache_read_tokens":9973}}}', first);
    expect(first).toMatchObject({ input_tokens: 24189, cached_input_tokens: 9973, output_tokens: 74, turns: 1 });
    const second: typeof first = { ...newUsage(), baseline: sessionBaseline(first) };
    accumulateUsage('agy', '{"event":"result","result":{"num_turns":2,"usage":{"input_tokens":16469,"output_tokens":76,"thinking_tokens":0,"cache_read_tokens":20101}}}', second);
    expect(second).toMatchObject({ input_tokens: 2253 + 10128, cached_input_tokens: 10128, output_tokens: 2, turns: 1 });
  });

  // director 是自己写的流，每个进程从零算，不减基线。
  it('director results are per invocation', () => {
    const u: ReturnType<typeof newUsage> = { ...newUsage(), baseline: { input_tokens: 5, output_tokens: 5, cached_input_tokens: 0, cost_usd: 1, turns: 1 } };
    accumulateUsage('director', '{"type":"result","num_turns":2,"total_cost_usd":0.3,"usage":{"input_tokens":10,"output_tokens":3}}', u);
    expect(u.cost_usd).toBe(0.3);
    expect(u.turns).toBe(2);
    expect(u.session_total).toBeUndefined();
  });

  // 2026-11 实测 qoder 1.1.89：不报 token 与费用，只报 total_credits，续接后是整个会话的累计值。
  it('qoder reports credits cumulatively', () => {
    const line = (credits: number) => `{"type":"result","num_turns":1,"total_cost_usd":0,"total_credits":${credits},"usage":{"input_tokens":0,"output_tokens":0}}`;
    const first = newUsage();
    accumulateUsage('qoder', line(0.0139), first);
    expect(first.credits).toBeCloseTo(0.0139, 10);
    const second: typeof first = { ...newUsage(), baseline: sessionBaseline(first) };
    accumulateUsage('qoder-intl', line(0.0213), second);
    expect(second.credits).toBeCloseTo(0.0074, 10);
    expect(second.session_total?.credits).toBeCloseTo(0.0213, 10);
    expect(marshal(usageJSON(second))).toContain('"credits":');

    // 汇总：额度相加；claude 那样不报额度的一方不算「不完整」。
    const total = newUsage();
    usageAdd(total, first);
    usageAdd(total, second);
    usageAdd(total, { input_tokens: 5, cost_usd: 0.1, source: 'claude result' });
    expect(total.credits).toBeCloseTo(0.0213, 10);
    expect(total.partial).toBe(false);
    expect(formatUsage(total)).toContain('额度 0.02');
  });
});
