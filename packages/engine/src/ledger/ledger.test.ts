import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BasisTotalInput, newUsage, type Usage } from '../tools';
import { SourceConsolidate, SourceStudio, append, fromResult, memoryFile, projectFile, read, sortedKeys, summarize } from './index';

describe('ledger', () => {
  it('append, read and summarize', () => {
    const file = projectFile(fs.mkdtempSync(path.join(os.tmpdir(), 'am-ledger-')));
    // 不存在的账本读出空。
    expect(read(file)).toBeNull();
    const claude: Usage = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, cost_usd: 0.5, source: 'claude result', basis: BasisTotalInput };
    const codex: Usage = { input_tokens: 200, output_tokens: 20, source: 'codex turn.completed', basis: BasisTotalInput };
    for (const entry of [
      fromResult(SourceConsolidate, 'claude', 'claude-opus', 's1', claude, null, false),
      fromResult(SourceStudio, 'codex', '', 's2', codex, new Error('boom'), false),
      fromResult(SourceStudio, 'codex', '', 's3', newUsage(), null, true),
    ]) {
      append(file, entry);
    }
    // 坏行跳过，不拖垮整本账。
    fs.appendFileSync(file, 'not json\n');

    const entries = read(file)!;
    expect(entries).toHaveLength(3);
    expect(entries[0].time).not.toBe('');
    expect(entries[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(entries[1].status).toBe('failed');
    expect(entries[2].status).toBe('cancelled');
    expect(entries[2].usage).toBeUndefined();
    const summary = summarize(entries);
    expect(summary.calls).toBe(3);
    expect(summary.total.input_tokens).toBe(300);
    expect(summary.total.output_tokens).toBe(30);
    // 有一次没读到用量、codex 不报费用：合计只是下限。
    expect(summary.total.partial).toBe(true);
    expect(summary.by_source[SourceStudio].partial).toBe(true);
    expect(summary.by_source[SourceConsolidate].partial).toBe(false);
    expect(summary.by_model['claude/claude-opus']).toBeDefined();
    expect(sortedKeys(summary.by_model)).toEqual(['claude/claude-opus', 'codex']);
    expect(memoryFile('/m')).toBe(path.join('/m', 'orchestrator-usage.jsonl'));
  });

  // TS 额外：写出的行与 Go 的 json.Marshal(Entry) 字段顺序一致。
  it('writes Go-compatible lines', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-ledger-')), 'x.jsonl');
    append(file, { ...fromResult(SourceConsolidate, 'codex', '', '', { input_tokens: 1, source: 'codex turn.completed', basis: BasisTotalInput }, null, false), time: 't' });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      '{"time":"t","source":"consolidate","tool":"codex","status":"succeeded","usage":{"input_tokens":1,"basis":"total-input","source":"codex turn.completed"}}\n',
    );
  });
});
