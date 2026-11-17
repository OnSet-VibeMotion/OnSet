import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as audition from '../audition';
import { load as loadScene, newAttempt, writeLive } from '../scene';
import { discoverScenes } from './scenes';
import * as tasks from './tasks';
import { startStudio, studioRequest, tempDir, writeTree } from './testsupport';

function setup() {
  const root = fs.realpathSync(tempDir());
  writeTree(root, {
    'onset.conf': '',
    'frame.md': '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n',
    'scenes/scene-001/scene.json': '{"id":"scene-001","duration_seconds":3,"output":"scene-001.mp4","transcript":"t.srt","text":"口播"}',
    'scenes/scene-001/t.srt': '1\n00:00:00,000 --> 00:00:03,000\n字幕\n',
  });
  const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
  const a = audition.create(root, loadScene(path.join(root, 'scenes', 'scene-001')), [{ renderer: 'claude', model: 'opus' }, { renderer: 'codex', model: '' }], {
    withMemory: true,
    shuffle: (l) => [...l],
  });
  return { root, s, a };
}

function finishAll(root: string, a: audition.Audition): void {
  for (const c of a.contestants) {
    fs.writeFileSync(path.join(root, c.workdir, 'scene-001.mp4'), 'v');
    audition.applyAttempt(root, c, newAttempt({ outcome: 'succeeded', model: 'm-' + c.renderer }), '');
  }
  audition.save(root, a);
}

describe('auditions API', () => {
  it.each([
    [{ result: 'Failed to authenticate: OAuth token revoked. secret-model' }, '工具登录已失效', '先恢复'],
    [{ errors: ['Dedicated resource package balance is low secret-model'] }, '模型额度不足', '先补足'],
    [{ errors: ['Empty stream: upstream ended the turn with finish_reason=error secret-model'] }, '模型服务异常结束', '可以重试'],
  ])('explains historical service failures while preserving blind identities', async (failure, label, hint) => {
    const { root, s, a } = setup();
    audition.applyAttempt(root, a.contestants[0], null, '渲染器退出码 1');
    audition.save(root, a);
    fs.writeFileSync(path.join(root, a.contestants[0].workdir, `render-${a.scene_id}.stream.jsonl`), [
      { type: 'system', subtype: 'init', model: 'secret-model' },
      { type: 'result', is_error: true, ...failure },
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    const r = await studioRequest(s, 'GET', `/api/auditions/${a.id}/activity`);
    expect(r.body.contestants[0].current).toBe(label);
    expect(r.body.contestants[0].hint).toContain(hint);
    expect(JSON.stringify(r.body)).not.toContain('secret-model');
  });

  it('recovers abandoned contestants and serializes retry tasks before accepting votes', async () => {
    const { root, s, a } = setup();
    a.contestants[0].status = 'running';
    audition.save(root, a);
    let r = await studioRequest(s, 'GET', `/api/auditions/${a.id}/activity`);
    expect(r.body.contestants.map((c: { state: string }) => c.state)).toEqual(['interrupted', 'interrupted']);
    let finish!: () => void;
    const operation = vi.spyOn(tasks, 'runStudioOp').mockImplementation(() => new Promise(resolve => { finish = () => resolve({ text: '' }); }));
    try {
      r = await studioRequest(s, 'POST', `/api/auditions/${a.id}/retry`, '{"slot":"A"}');
      expect(r.status).toBe(202);
      expect(r.body.task_id).toBeTruthy();
      expect(operation).toHaveBeenCalledWith(s, expect.any(AbortSignal), expect.objectContaining({ path: root }), 'scene_audition_retry', { audition: a.id, slot: 'A', project_root: root });
      expect((await studioRequest(s, 'POST', `/api/auditions/${a.id}/retry`, '{"slot":"A"}')).status).toBe(409);
      expect((await studioRequest(s, 'POST', `/api/auditions/${a.id}/vote`, '{"kind":"none"}')).status).toBe(409);
    } finally {
      finish?.();
      await vi.waitFor(() => expect(s.busyHolder(root)).toBe(''));
      operation.mockRestore();
    }
  });

  it('holds the audition lease between contestants, ignores dead owners, and rejects escaped workdirs', () => {
    const { root, a } = setup();
    const release = audition.acquireRun(root, a);
    try {
      expect(audition.isRunning(root, a)).toBe(true);
      expect(() => audition.acquireRun(root, a)).toThrow('仍在运行');
    } finally { release(); }
    expect(audition.isRunning(root, a)).toBe(false);
    writeLive(path.join(root, audition.Dir, a.id), a.id, { pid: 2147483647, renderer: '', started_at: '' });
    const recovered = audition.acquireRun(root, a);
    recovered();
    expect(audition.retryContestant(root, a, 'A')).toBe(a.contestants[0]);
    a.contestants[0].workdir = a.scene_dir;
    expect(() => audition.retryContestant(root, a, 'A')).toThrow('目录与试镜不符');
  });

  it('rejects retry of successful or judged contestants and prevents overlapping writes', async () => {
    const { root, s, a } = setup();
    finishAll(root, a);
    const retry = (slot: unknown) => studioRequest(s, 'POST', `/api/auditions/${a.id}/retry`, JSON.stringify({ slot }));
    expect((await retry('A')).body.message).toContain('已有合格产物');
    expect((await retry('../A')).status).toBe(400);
    expect((await retry(1)).status).toBe(400);
    audition.applyAttempt(root, a.contestants[0], null, '已取消');
    audition.save(root, a);
    s.acquire(root, '其余选手仍在试镜');
    try {
      expect((await retry('A')).body.code).toBe('project_busy');
    } finally { s.release(root); }
    // 旧版本或另一个进程还在渲染时，同样不能重试。
    writeLive(path.join(root, a.contestants[1].workdir), a.scene_id, { pid: process.pid, renderer: 'codex', started_at: new Date().toISOString() });
    expect((await retry('A')).status).toBe(409);
    a.verdict = { kind: 'none', winner: '', note: '', at: new Date().toISOString() };
    audition.save(root, a);
    expect((await retry('A')).body.message).toContain('已经评判');
    expect((await studioRequest(s, 'GET', `/api/auditions/${a.id}/retry`)).status).toBe(405);
  });

  it('shows each live contestant activity without leaking blind identities or log contents', async () => {
    const { root, s, a } = setup();
    const c = a.contestants[0];
    c.status = 'running';
    audition.save(root, a);
    const dir = path.join(root, c.workdir);
    writeLive(dir, a.scene_id, { pid: process.pid, renderer: c.renderer, started_at: new Date().toISOString() });
    const log = path.join(dir, `render-${a.scene_id}.stream.jsonl`);
    const call = (id: string, name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    fs.writeFileSync(log, [
      { type: 'system', subtype: 'init', model: 'secret-model' },
      call('render', 'mcp__onset__hyperframes', { subcommand: 'render', args: ['secret-model'] }),
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret-model 带经验的学生' }] } },
      call('read', 'Read', { file_path: '/secret-model/config' }),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'secret-model' }] } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    let r = await studioRequest(s, 'GET', `/api/auditions/${a.id}/activity`);
    expect(r.status).toBe(200);
    expect(r.body.contestants[0]).toMatchObject({ slot: 'A', state: 'running', current: '取帧与编码', step_count: 3 });
    expect(r.body.contestants[1]).toMatchObject({ slot: 'B', state: 'pending', current: '等待上场' });
    for (const secret of ['secret-model', 'claude', 'codex', '带经验', root, 'started_at', 'updated_at']) expect(JSON.stringify(r.body)).not.toContain(secret);
    fs.appendFileSync(log, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'render', content: 'secret-model rendered' }] } }) + '\n');
    r = await studioRequest(s, 'GET', `/api/auditions/${a.id}/activity`);
    expect(r.body.contestants[0]).toMatchObject({ state: 'waiting', current: '等待模型响应', step_count: 3 });
    expect(r.body.contestants[0].steps[0].state).toBe('done');
    finishAll(root, a);
    await studioRequest(s, 'POST', `/api/auditions/${a.id}/vote`, JSON.stringify({ kind: 'tie' }));
    r = await studioRequest(s, 'GET', `/api/auditions/${a.id}/activity`);
    expect(r.body.contestants[0]).toMatchObject({ state: 'done', current: '已完成' });
    expect(JSON.stringify(r.body)).toContain('secret-model');
  });

  it('reads design progress and recognizes a dead renderer instead of showing running forever', async () => {
    const { root, s, a } = setup();
    const c = a.contestants[0];
    c.status = 'running';
    c.designer = 'claude';
    audition.save(root, a);
    const dir = path.join(root, c.workdir);
    writeLive(dir, a.scene_id, { pid: 2147483647, renderer: 'claude', started_at: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, `design-${a.scene_id}.stream.jsonl`), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: 'design.md', content: 'secret' } }] } }) + '\n');
    const r = await studioRequest(s, 'GET', `/api/auditions/${a.id}/activity`);
    expect(r.status).toBe(200);
    expect(r.body.contestants[0]).toMatchObject({ phase: 'design', state: 'interrupted', current: '试镜已中断' });
    expect(r.body.contestants[0].steps).toEqual([{ label: '编写设计稿', state: 'interrupted' }]);
    writeLive(dir, a.scene_id, { pid: process.pid, renderer: 'codex', started_at: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, `render-${a.scene_id}.stream.jsonl`), JSON.stringify({ type: 'thread.started', thread_id: 'render' }) + '\n');
    const rendering = await studioRequest(s, 'GET', `/api/auditions/${a.id}/activity`);
    expect(rendering.body.contestants[0]).toMatchObject({ phase: 'render', state: 'starting', step_count: 0 });
  });

  it('isolates invalid contestant paths and handles missing logs', async () => {
    const { root, s, a } = setup();
    a.contestants[0].workdir = '../outside';
    a.contestants[1].status = 'running';
    audition.save(root, a);
    const r = await studioRequest(s, 'GET', `/api/auditions/${a.id}/activity`);
    expect(r.status).toBe(200);
    expect(r.body.contestants[0]).toMatchObject({ state: 'unavailable', steps: [] });
    expect(r.body.contestants[1]).toMatchObject({ state: 'starting', current: '准备渲染', steps: [] });
    expect((await studioRequest(s, 'POST', `/api/auditions/${a.id}/activity`, '{}')).status).toBe(405);
  });

  it('keeps the copies out of the scene list', () => {
    const { root } = setup();
    expect(discoverScenes(root).map((x) => x.directory)).toEqual([path.join(root, 'scenes', 'scene-001')]);
  });

  it('lists auditions blind until judged, then reveals', async () => {
    const { root, s, a } = setup();
    let r = await studioRequest(s, 'GET', '/api/auditions?scene=scene-001');
    expect(r.status).toBe(200);
    expect(r.body.auditions).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain('codex');
    r = await studioRequest(s, 'POST', `/api/auditions/${a.id}/vote`, JSON.stringify({ kind: 'tie' }));
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('还有选手没渲染完');
    finishAll(root, a);
    r = await studioRequest(s, 'POST', `/api/auditions/${a.id}/adopt`, JSON.stringify({ slot: 'A' }));
    expect(r.status).toBe(409);
    r = await studioRequest(s, 'POST', `/api/auditions/${a.id}/vote`, JSON.stringify({ kind: 'winner', winner: 'B', note: '更稳' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.blind).toBe(false);
    expect(r.body.contestants[1].renderer).toBe('codex');
    expect(r.body.warning).toBeUndefined();
    // 跨项目的评判记录写进了记忆库目录（测试里 ONSET_MEMORY_DIR 指到临时目录）。
    expect(audition.readVerdicts(process.env.ONSET_MEMORY_DIR!).map((v) => v.winner)).toContain('codex/m-codex');
    expect((await studioRequest(s, 'GET', `/api/auditions/${a.id}`)).body.verdict.winner).toBe('B');
  });

  it('rejects bad requests', async () => {
    const { s } = setup();
    const post = (body: unknown) => studioRequest(s, 'POST', '/api/auditions', JSON.stringify(body));
    expect((await post({ scene_id: 'scene-001', contestants: [{ renderer: 'claude' }] })).body.code).toBe('invalid_contestants');
    expect((await post({ scene_id: 'scene-001', contestants: [{ renderer: 'nope' }, { renderer: 'claude' }] })).body.code).toBe('invalid_agent');
    expect((await post({ scene_id: 'scene-001', contestants: [{ renderer: 'codex', model: 'a,b' }, { renderer: 'claude' }] })).body.code).toBe('invalid_model');
    expect((await post({ scene_id: 'scene-404', contestants: [{ renderer: 'codex' }, { renderer: 'claude' }] })).status).toBe(404);
    expect((await studioRequest(s, 'GET', '/api/auditions/not-an-id')).status).toBe(404);
  });
});
