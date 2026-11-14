import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as agentrun from '@onset/engine/agentrun';
import { EventPrinter, summaryLimit, truncate } from './agentprint';

describe('event printer', () => {
  // 记录下来的真实 codex 输出经解析器译成事件后，打印出来应当是人能读的（整理记忆 onset memory consolidate 用它）。
  it('prints a recorded stream readably', () => {
    const fixture = path.resolve(__dirname, '..', '..', 'engine', 'src', 'agentrun', 'testdata', 'codex-1.jsonl');
    const parser = agentrun.newParser('codex');
    let out = '';
    const p = new EventPrinter({ write: (t) => (out += t) }, { write: () => true });
    for (const line of fs.readFileSync(fixture, 'utf8').split('\n')) for (const event of parser.parse(line)) p.print(event);
    p.print({ kind: agentrun.KindSession, session_id: parser.sessionID() });
    p.print({ kind: agentrun.KindUsage, usage: parser.usage() });
    for (const want of ['会话: 01a19706-15cc-7c23-92b3-d0008785ee57', '→ shell /bin/zsh -lc', '\nOK\n', '用量: 输入 41579']) {
      expect(out).toContain(want);
    }
    expect(out, '不应再透传原始 JSON').not.toContain('"type"');
  });

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
