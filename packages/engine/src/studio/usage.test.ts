// 移植自 internal/studio/usage_test.go。
//
// 推迟到下一轮（依赖 scene 包）：
// - TestChatTurnUsageIsRecordedAndSurvivesRevert 末尾经 /api/scenes 读项目用量合计的断言；
// - TestSceneRenderingFollowsLogActivity（sceneRendering）。
import './testsupport';
import { describe, expect, it } from 'vitest';
import * as ledger from '../ledger';
import { lastTurn, newSessionFixture, studioRequest, waitIdle } from './testsupport';

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
  });
});
