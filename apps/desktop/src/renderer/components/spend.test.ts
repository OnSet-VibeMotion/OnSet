import { describe, expect, it } from 'vitest';
import { spendParts } from './Preview';

// qoder 按额度计费、不报 token（报 0）：不写「0 token」，只写额度；claude 照旧写 token 与费用。
describe('spendParts', () => {
  it('shows credits for credit-billed tools and tokens for the rest', () => {
    expect(spendParts({ input_tokens: 0, output_tokens: 0, cost_usd: 0, credits: 43.02, source: 'qoder result' })).toEqual(['额度 43.0']);
    expect(spendParts({ input_tokens: 1_200_000, output_tokens: 30_000, cost_usd: 2.45, source: 'claude result' })).toEqual(['1.2M token', '$2.45']);
    // 混着两种工具时都写上；有的尝试没读到用量，数字是下限。
    expect(spendParts({ input_tokens: 1_200_000, cost_usd: 2.45, credits: 10, partial: true, source: 'mixed' })).toEqual(['1.2M token+', '$2.45', '额度 10.0+']);
    expect(spendParts({ source: 'codex turn.completed' })).toEqual(['0 token']);
  });
});
