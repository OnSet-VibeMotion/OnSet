// 移植自 internal/cli/agentprint_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as agentrun from '@am/engine/agentrun';
import { EventPrinter, summaryLimit, truncate } from './agentprint';
import { Buffer, run, setenv, tempDir, writeExecutable } from './testutil';

describe('event printer', () => {
  it('am run prints readable events', async () => {
    const fixture = path.resolve(__dirname, '..', '..', 'engine', 'src', 'agentrun', 'testdata', 'codex-1.jsonl');
    expect(fs.existsSync(fixture)).toBe(true);
    const root = tempDir();
    const bin = tempDir();
    fs.writeFileSync(path.join(root, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    fs.writeFileSync(path.join(root, 'PROMPT.md'), 'p');
    writeExecutable(path.join(bin, 'codex'), `#!/bin/sh\ncat >/dev/null\ncat '${fixture}'\n`);
    setenv('PATH', bin + path.delimiter + (process.env.PATH ?? ''));
    setenv('ORCHESTRATOR', 'codex');
    setenv('RENDERER', 'claude');
    process.chdir(root);
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['run'], out, errOut), errOut.text).toBe(0);
    for (const want of ['会话: 01a19706-15cc-7c23-92b3-d0008785ee57', '→ shell /bin/zsh -lc', '\nOK\n', '用量: 输入 41579']) {
      expect(out.text).toContain(want);
    }
    expect(out.text, '不应再透传原始 JSON').not.toContain('"type"');
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
