import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BasisTotalInput, newUsage, type Usage } from '../tools';
import { SourceConsolidate, SourceStudio, append, fromResult, lastSessionUsage, memoryFile, projectFile, read, sortedKeys, summarize } from './index';

describe('ledger', () => {
  it('append, read and summarize', () => {
    const file = projectFile(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-ledger-')));
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
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-ledger-')), 'x.jsonl');
    append(file, { ...fromResult(SourceConsolidate, 'codex', '', '', { input_tokens: 1, source: 'codex turn.completed', basis: BasisTotalInput }, null, false), time: 't' });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      '{"time":"t","source":"consolidate","tool":"codex","status":"succeeded","usage":{"input_tokens":1,"basis":"total-input","source":"codex turn.completed"}}\n',
    );
  });

  // 修复前 claude 续接记下的是会话累计费用：合计时同一会话的后一条减掉前一条；新账带 session_total，原样相加。
  it('summarize undoes cumulative claude costs and finds the resume baseline', () => {
    const file = projectFile(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-ledger-')));
    const legacy = (cost: number): Usage => ({ input_tokens: 10, cost_usd: cost, source: 'claude result', basis: BasisTotalInput });
    append(file, fromResult(SourceStudio, 'claude', '', 'a', legacy(1), null, false));
    append(file, fromResult(SourceStudio, 'claude', '', 'a', legacy(1.5), null, false));
    append(file, fromResult(SourceStudio, 'claude', '', 'b', legacy(2), null, false));
    append(file, fromResult(SourceStudio, 'claude', '', 'a', legacy(2.25), null, false));
    expect(summarize(read(file)).total.cost_usd).toBeCloseTo(2.25 + 2, 10);
    // 旧账的费用就是会话累计值，拿来当基线。
    expect(lastSessionUsage(file, 'a')?.cost_usd).toBe(2.25);
    expect(lastSessionUsage(file, 'missing')).toBeNull();

    const fresh: Usage = { input_tokens: 10, cost_usd: 0.5, source: 'claude result', basis: BasisTotalInput, session_total: { input_tokens: 10, output_tokens: 0, cached_input_tokens: 0, cost_usd: 2.75, turns: 1 } };
    append(file, fromResult(SourceStudio, 'claude', '', 'a', fresh, null, false));
    expect(summarize(read(file)).total.cost_usd).toBeCloseTo(4.75, 10);
    expect(lastSessionUsage(file, 'a')?.cost_usd).toBe(2.75);
  });
});
