import { describe, expect, it } from 'vitest';
import * as agentrun from '@am/engine/agentrun';
import { EventPrinter, summaryLimit, truncate } from './agentprint';

describe('event printer', () => {
  it('formats every kind', () => {
    let out = '';
    let err = '';
    const p = new EventPrinter({ write: (t) => (out += t) }, { write: (t) => (err += t) });
    p.print({ kind: agentrun.KindToolCall, tool: 'Write', input: { file_path: '/work/a.txt' } });
    p.print({ kind: agentrun.KindToolCall, tool: 'Odd', input: [1] });
    p.print({ kind: agentrun.KindToolResult, text: 'ok' });
    p.print({ kind: agentrun.KindToolResult, is_error: true, text: 'denied\nmore' });
    p.print({ kind: agentrun.KindThinking, text: 'secret plan' });
    p.print({ kind: agentrun.KindError, text: 'boom' });
    p.print({ kind: agentrun.KindUsage, usage: { input_tokens: 3, output_tokens: 4, cost_usd: 0.5 } });
    for (const want of ['→ Write /work/a.txt\n', '→ Odd \n', '  ✗ denied …\n', '$0.5000']) expect(out).toContain(want);
    expect(out).not.toContain('ok');
    expect(out).not.toContain('secret plan');
    expect(err).toBe('错误: boom\n');
    const long = truncate('字'.repeat(summaryLimit + 5));
    expect(long.endsWith('…')).toBe(true);
    expect([...long]).toHaveLength(summaryLimit + 1);
  });
});
