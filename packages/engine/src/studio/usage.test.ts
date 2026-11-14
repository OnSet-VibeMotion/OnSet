import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ledger from '../ledger';
import { sceneRendering } from './scenes';
import { lastTurn, newSessionFixture, studioRequest, tempDir, waitIdle } from './testsupport';

describe('usage', () => {
  // 每轮对话的编排用量记进项目账本，账本不算这一轮的改动，回退后账还在。
  it('chat turn usage is recorded and survives revert', async () => {
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"title":"记账"}');
    expect(status).toBe(201);
    const id = body.session_id as string;
    ({ status, body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"改一下"}'));
    expect(status).toBe(202);
    const turnID = body.turn_id as string;
    const detail = await waitIdle(f, id);
    for (const change of lastTurn(detail).changes) expect(change.path, '账本不能算进一轮的改动').toBe('scenes/scene-001/prompt.md');
    ({ status } = await studioRequest(f.s, 'POST', `/api/turns/${turnID}/revert`, '{}'));
    expect(status).toBe(200);

    const entries = ledger.read(ledger.projectFile(f.root));
    expect(entries).toHaveLength(1);
    const e = entries![0];
    expect(e.source).toBe(ledger.SourceStudio);
    expect(e.turn).toBe(turnID);
    expect(e.tool).toBe('claude');
    expect(e.model).toBe('claude-fake');
    expect(e.status).toBe('succeeded');
    expect(e.usage?.output_tokens).toBe(4);

    ({ status, body } = await studioRequest(f.s, 'GET', '/api/scenes'));
    expect(status).toBe(200);
    const { orchestrator, total } = body.usage;
    expect(orchestrator.calls).toBe(1);
    expect(total.output_tokens).toBe(4);
    expect(total.cost_usd).toBe(0.01);
  });

  // 只认进行中标记：没有标记时日志再新也不算渲染中。
  it('scene rendering needs the live marker', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'render-s1.stream.jsonl'), '{}');
    expect(sceneRendering(dir, 's1'), '刚写的日志、没有标记：不算渲染中').toBe(false);
  });
});
