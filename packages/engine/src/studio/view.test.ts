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
    for (const want of ['Studio 网页上开着「镜头」页，镜头 scene-001', 'studio_show(', 'film-styles']) {
      expect(a[0], '提示词应当带上用户在看的页面与 studio_show 的约定').toContain(want);
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

  // 用户在对话里确认分镜：编排工具调 studio_confirm，后端核对原话出自这一轮用户的话，记进 gates.json。
  it('records a gate confirmed in the chat', async () => {
    const f = newSessionFixture();
    writeTree(f.root, { 'production/scene-plan.json': '{}' });
    setEnv('FAKE_VIEW', '{"page":"","confirm":{"said":"就按这七种风格，开始渲染"}}');
    const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    const id = body.session_id as string;
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"好的，就按这七种风格，开始渲染"}');
    await waitIdle(f, id);
    const { text } = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`);
    expect(text).toContain('已记下你在对话里的确认：分镜审核');
    expect(text, '关卡确认不是切页').not.toContain('event: view');
    const gates = JSON.parse(fs.readFileSync(path.join(f.root, 'production/studio/gates.json'), 'utf8'));
    expect(gates.gates['gate-storyboard'].said).toBe('就按这七种风格，开始渲染');

    // 用户没说过这句话：不记，并在对话里说明。
    const g = newSessionFixture();
    writeTree(g.root, { 'production/scene-plan.json': '{}' });
    setEnv('FAKE_VIEW', '{"page":"","confirm":{"said":"就按这七种风格，开始渲染"}}');
    const other = (await studioRequest(g.s, 'POST', '/api/sessions', '{}')).body.session_id as string;
    await studioRequest(g.s, 'POST', `/api/sessions/${other}/turns`, '{"message":"第三个镜头再快一点"}');
    await waitIdle(g, other);
    expect((await rawGet(g.s, `/api/sessions/${other}/events?follow=0`)).text).toContain('没有记下关卡确认');
    expect(fs.existsSync(path.join(g.root, 'production/studio/gates.json'))).toBe(false);
  });

  it('validateViewRequest', () => {
    const root = tempDir();
    writeTree(root, {
      'scenes/scene-001/scene.json': '{"id":"scene-001","duration_seconds":1,"output":"out.mp4"}',
      'production/notes.md': 'x',
      '.env': 'A=1',
    });
    const ok: ViewRequest[] = [
      { page: 'script' },
      { page: 'scene', target: 'scene-001' },
      { page: 'compose' },
      { page: 'file', target: 'production/notes.md' },
      { page: 'file', target: path.join(root, 'production', 'notes.md') },
    ];
    for (const req of ok) {
      const got = validateViewRequest(root, req);
      if (req.page === 'file') expect(got.target, '文件路径应当规范成相对路径').toBe('production/notes.md');
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
