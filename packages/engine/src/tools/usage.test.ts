import { describe, expect, it } from 'vitest';
import { marshal } from '../gojson';
import { BasisTotalInput, accumulateUsage, formatUsage, newUsage, usageAdd, usageEmpty, usageJSON, usageTotal } from './index';

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
});
