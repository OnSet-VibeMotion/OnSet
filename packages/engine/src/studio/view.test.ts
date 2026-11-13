// 移植自 internal/studio/view_test.go。
import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { studioRoot } from './turns';
import { args, newSessionFixture, lastTurn, rawGet, setEnv, studioRequest, tempDir, waitIdle, writeTree } from './testsupport';
import { describeView, drainViewInbox, validateViewRequest, ViewInboxEnv, ViewProjectEnv, writeViewRequest, type ViewRequest } from './view';

describe('view', () => {
  // 编排工具经收件目录请网页切页：Studio 译成 view 事件；用户在看的页面写进提示词、不进对话显示。
  it('turn carries view both ways', async () => {
    const f = newSessionFixture();
    setEnv('FAKE_VIEW', '{"page":"script","note":"口播稿写好了"}');
    let { status, body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"title":"审稿"}');
    expect(status).toBe(201);
    const id = body.session_id as string;
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"这个镜头太快了","view":{"page":"scene","scene":"scene-001"}}'));
    expect(status).toBe(202);
    const detail = await waitIdle(f, id);
    expect(lastTurn(detail).status).toBe('succeeded');
    const a = args(f);
    for (const want of ['Studio 网页上开着「镜头」页，镜头 scene-001', 'am studio show', 'film-styles']) {
      expect(a[0], '提示词应当带上用户在看的页面与 am studio show 的约定').toContain(want);
    }
    const { text } = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`);
    expect(text).toContain('event: view');
    expect(text).toContain('"page":"script"');
    expect(text).toContain('口播稿写好了');
    expect(text, '用户在看的页面只进提示词，不显示在对话里').not.toContain('Studio 网页上开着');
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(path.join(studioRoot(f.root), 'inbox'));
    } catch {
      entries = [];
    }
    expect(entries, '一轮结束后收件目录应当清掉').toHaveLength(0);
  });

  it('validateViewRequest', () => {
    const root = tempDir();
    writeTree(root, {
      'scenes/scene-001/scene.json': '{"id":"scene-001","duration_seconds":1,"output":"out.mp4"}',
      'production/treatment.md': 'x',
      '.env': 'A=1',
    });
    const ok: ViewRequest[] = [
      { page: 'script' },
      { page: 'scene', target: 'scene-001' },
      { page: 'compose' },
      { page: 'file', target: 'production/treatment.md' },
      { page: 'file', target: path.join(root, 'production', 'treatment.md') },
    ];
    for (const req of ok) {
      const got = validateViewRequest(root, req);
      if (req.page === 'file') expect(got.target, '文件路径应当规范成相对路径').toBe('production/treatment.md');
    }
    const bad: ViewRequest[] = [
      { page: 'nope' },
      { page: 'scene' },
      { page: 'scene', target: 'scene-009' },
      { page: 'script', target: 'x' },
      { page: 'file' },
      { page: 'file', target: '.env' },
      { page: 'file', target: '../outside' },
      { page: 'file', target: 'missing.md' },
    ];
    for (const req of bad) expect(() => validateViewRequest(root, req), `${JSON.stringify(req)} 应当被拒绝`).toThrow();
    // 不在 Studio 里：页面对就静默跳过，页面错照样报。
    expect(writeViewRequest({}, { page: 'script' }), '不在 Studio 里应当跳过').toBe(false);
    expect(() => writeViewRequest({}, { page: 'nope' }), '页面写错应当报错').toThrow();
    const inbox = path.join(tempDir(), 'inbox');
    const env = { [ViewInboxEnv]: inbox, [ViewProjectEnv]: root };
    for (const page of ['script', 'final']) expect(writeViewRequest(env, { page }), page).toBe(true);
    const got = drainViewInbox(inbox);
    expect(got.map((r) => r.page), '应当按写入顺序读出').toEqual(['script', 'final']);
    expect(drainViewInbox(inbox), '读过的请求应当删掉').toHaveLength(0);
  });

  it('ViewState.describe', () => {
    expect(describeView(null)).toBe('');
    expect(describeView({ page: 'bogus' }), '没有或不认识的页面不描述').toBe('');
    expect(describeView({ page: 'file', file: 'a.md' })).toContain('「文件」页，文件 a.md');
  });
});
