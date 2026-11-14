import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installStation, stageStation, writeStationForTest } from '../flow';
import { onStudioEvent } from './events';
import { emitStationHook, pageCSP, tickStationSchedules } from './stations';
import { newSessionFixture, send, startStudio, studioRequest, tempDir, waitStudioTask } from './testsupport';

const fake = path.join(__dirname, '..', 'flow', 'testdata', 'fake-publisher');

describe('stations API', () => {
  it('lists the stations of the project with their prompt, stops and ops', async () => {
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'GET', '/api/stations');
    expect(status).toBe(200);
    expect(body.problems).toEqual([]);
    expect(body.stations.map((x: { id: string; builtin: boolean }) => [x.id, x.builtin])).toEqual([
      ['algorithmic-art', true],
      ['anidoodle-styles', true],
      ['beat', true],
      ['cast', true],
      ['huashu-styles', true],
      ['lemo-styles', true],
      ['publishing', true],
      ['skins', true],
      ['song', true],
      ['text-to-lottie', true],
    ]);
    // 内置插件常开：没有开关，也没有「因为关掉而藏起来的页面」。
    expect(body).not.toHaveProperty('hidden_pages');
    for (const b of body.stations) expect(b).not.toHaveProperty('enabled');

    installStation(`link:${fake}`);
    const gone = writeStationForTest({ 'am-station.json': JSON.stringify({ id: 'gone', version: '1', name: '没了' }) });
    installStation(`link:${gone}`);
    fs.rmSync(gone, { recursive: true, force: true });
    ({ status, body } = await studioRequest(f.s, 'GET', '/api/stations'));
    expect(status).toBe(200);
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]).toMatchObject({ id: 'gone', linked: true });
    expect(body.problems[0].message).toContain('第三方插件 gone');
    const station = body.stations.find((x: { id: string }) => x.id === 'fake-publisher');
    expect(station).toMatchObject({ id: 'fake-publisher', name: '假发布', linked: true, after: 'publish' });
    expect(station.experimental).toEqual(['hooks', 'schedules', 'slots', 'commands', 'inserts', 'flow', 'provides', 'renderer_skills', 'film_styles']);
    // 内置插件不标实验性。
    for (const b of body.stations.filter((x: { builtin: boolean }) => x.builtin)) expect(b.experimental).toEqual([]);
    expect(station.prompt).toContain('请用户在发布页点');
    expect(station.nodes).toEqual([{ id: 'auto-publish', label: '自动发布', step: 'publish', gate: false }]);
    expect(station.ops.map((o: { name: string; trigger: string; tool: string }) => [o.name, o.trigger, o.tool])).toEqual([
      ['send', 'user', ''],
      ['status', 'agent', 'x_fake_publisher_status'],
      ['on_event', 'agent', 'x_fake_publisher_on_event'],
      ['speak', 'agent', 'x_fake_publisher_speak'],
      ['scribble', 'user', ''],
    ]);
  });

  it('validates requests before starting a write task', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    const post = (url: string, body: unknown) => studioRequest(f.s, 'POST', url, JSON.stringify(body));
    expect((await post('/api/stations', { source: '' })).status).toBe(400);
    expect((await post('/api/stations', { source: 'npm:thing' })).body.message).toContain('认不出来源');
    expect((await post('/api/stations/nope/ops/send', {})).status).toBe(404);
    expect((await post('/api/stations/fake-publisher/ops/nope', {})).status).toBe(404);
    expect((await post('/api/stations/fake-publisher/ops/send', { params: {} })).body.message).toContain('缺参数 platform');
    expect((await post('/api/stations/fake-publisher/ops/send', { params: { platform: 1 } })).body.message).toContain('要是 string');
    expect((await post('/api/stations/nope/remove', {})).status).toBe(404);
    expect((await post('/api/stations/nope/update', {})).status).toBe(404);
    expect((await post('/api/stations/fake-publisher/update', {})).body.message).toContain('不需要更新');
  });

  it('serves plugin pages from the station only, under a CSP that blocks every request', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    const { body } = await studioRequest(f.s, 'GET', '/api/stations');
    expect(body.stations.find((x: { id: string }) => x.id === 'fake-publisher').pages).toEqual([
      { id: 'dashboard', label: '发布看板', tab: 'x:fake-publisher:dashboard', url: '/station-ui/fake-publisher/ui/index.html', reads: ['publish.md'] },
      { id: 'mini', label: '发布小窗', tab: 'x:fake-publisher:mini', url: '/station-ui/fake-publisher/ui/slot.html', reads: ['publish.md'] },
    ]);
    expect(body.stations.find((x: { id: string }) => x.id === 'fake-publisher').slots).toEqual([{ at: 'publish', page: 'mini', height: 140, tab: 'x:fake-publisher:mini', url: '/station-ui/fake-publisher/ui/slot.html' }]);
    expect(body.stations.find((x: { id: string }) => x.id === 'fake-publisher').commands).toEqual([{ name: 'fabu', description: '打开发布看板', page: 'dashboard', prompt: '', tab: 'x:fake-publisher:dashboard' }]);
    const page = await send(f.s, 'GET', '/station-ui/fake-publisher/ui/index.html');
    expect(page.status).toBe(200);
    const csp = page.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('script-src am://app/station-ui/fake-publisher/ am://app/station-ui/_sdk.js');
    expect(await page.text()).toContain('发布看板');
    expect((await send(f.s, 'GET', '/station-ui/fake-publisher/ui/slot.html')).status).toBe(200);
    expect((await send(f.s, 'GET', '/station-ui/_sdk.js')).headers.get('Content-Type')).toContain('javascript');
    // 只给页面所在目录：清单、命令、站目录外的文件都不给。
    for (const bad of ['/station-ui/fake-publisher/am-station.json', '/station-ui/fake-publisher/bin/publish.cjs', '/station-ui/fake-publisher/prompt.md', '/station-ui/nope/ui/index.html']) {
      expect((await send(f.s, 'GET', bad)).status, bad).not.toBe(200);
    }
  });

  it('lets a page read only what the station declared', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    fs.writeFileSync(path.join(f.root, 'publish.md'), '---\nplatform: douyin\n---\n');
    fs.writeFileSync(path.join(f.root, '.env'), 'SECRET=1\n');
    fs.mkdirSync(path.join(f.root, 'production', 'publish'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'production', 'publish', 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const read = (p: string) => studioRequest(f.s, 'GET', `/api/stations/fake-publisher/read?path=${encodeURIComponent(p)}`);
    let r = await read('publish.md');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ path: 'publish.md', size: 25, text: '---\nplatform: douyin\n---\n' });
    r = await read('production/publish/cover.png');
    expect(r.body.data_url).toBe('data:image/png;base64,iVBORw==');
    expect((await read('production/publish/receipts.json')).status).toBe(404);
    for (const bad of ['.env', 'article-to-motion.conf', '../etc/passwd', '/etc/passwd', 'production/publish/../../.env', 'production/studio/tasks.json']) {
      expect((await read(bad)).status, bad).toBe(403);
    }
  });

  it('serves declared project media to pages, and checks what a page may call', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    fs.mkdirSync(path.join(f.root, 'production', 'publish'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'production', 'publish', 'cover.png'), 'png');
    let res = await send(f.s, 'GET', '/station-media/fake-publisher/production/publish/cover.png');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('png');
    for (const bad of ['/station-media/fake-publisher/.env', '/station-media/fake-publisher/article-to-motion.conf', '/station-media/nope/publish.md']) {
      expect((await send(f.s, 'GET', bad)).status, bad).toBe(404);
    }
    // 只能调清单里申请过的 am 操作。
    res = await send(f.s, 'POST', '/api/stations/fake-publisher/call/scene_run', '{"params":{}}');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain('没有申请调用 scene_run');
    // 设置：密钥只回「填没填」。
    let r = await studioRequest(f.s, 'POST', '/api/stations/fake-publisher/settings', JSON.stringify({ key: 'token', value: 'tok-xyz' }));
    expect(r.status).toBe(200);
    expect(r.body.settings.find((x: { key: string }) => x.key === 'token')).toMatchObject({ set: true });
    expect(JSON.stringify(r.body)).not.toContain('tok-xyz');
    r = await studioRequest(f.s, 'POST', '/api/stations/fake-publisher/settings', JSON.stringify({ key: 'platform', value: 'weibo' }));
    expect(r.status).toBe(400);
    expect(pageCSP('x', ['https://api.example.com'])).toContain('connect-src https://api.example.com');
    expect(pageCSP('x')).toContain("connect-src 'none'");
  });

  it('tells listeners when a gate is confirmed', async () => {
    const f = newSessionFixture();
    const seen: string[] = [];
    onStudioEvent((_s, _p, event, payload) => seen.push(`${event} ${JSON.stringify(payload)}`));
    fs.mkdirSync(path.join(f.root, 'production'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'production', 'script-final.md'), '# 稿\n正文\n');
    expect((await studioRequest(f.s, 'POST', '/api/progress/gates/gate-script', '{}')).status).toBe(200);
    expect(seen).toContain('gate.confirmed {"gate":"gate-script"}');
  });

  it('starts scheduled ops when they are due, and only then', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    const t0 = Date.now();
    expect(tickStationSchedules(f.s, t0)).toEqual(['fake-publisher/on_event']);
    // 等这个任务结束（测试里执行进程起不来，很快失败），放出写权。
    for (let i = 0; i < 50 && [...f.s.tasks.tasks.values()].some((t) => t.status === 'running' || t.status === 'queued'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(tickStationSchedules(f.s, t0 + 10 * 60_000)).toEqual([]);
    expect(tickStationSchedules(f.s, t0 + 31 * 60_000)).toEqual(['fake-publisher/on_event']);
    f.s.shutdown();
  });

  it('shows files an op wrote outside its declared scope, and posts a notice when a hook ran it', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    // 测试里没有真的执行进程：换一个假的 am，像插件那样在项目里顺手写一个没声明的文件。
    const bin = fs.mkdtempSync(path.join(f.root, '..', 'am-fake-'));
    const fakeAm = path.join(bin, 'am');
    fs.writeFileSync(fakeAm, '#!/bin/sh\nmkdir -p notes\necho x > notes/stray.txt\nmkdir -p production/publish\necho y > production/publish/ok.json\nprintf \'写好了\\n\\000am-result {"ok":true,"exit_code":0}\\n\'\n', { mode: 0o755 });
    f.s.config.executable = fakeAm;
    const done = async () => {
      for (let i = 0; i < 250 && [...f.s.tasks.tasks.values()].some((t) => t.status === 'running' || t.status === 'queued'); i++) await new Promise((r) => setTimeout(r, 20));
    };

    expect((await studioRequest(f.s, 'POST', '/api/stations/fake-publisher/ops/scribble', '{"params":{}}')).status).toBe(202);
    await done();
    const task = [...f.s.tasks.tasks.values()].find((t) => t.type === 'station.run')!;
    expect(task.status).toBe('succeeded');
    expect(task.warning).toBe('插件「假发布」改了它没有声明会写的项目文件：notes/stray.txt。');
    const { body } = await studioRequest(f.s, 'GET', '/api/stations');
    const op = body.stations.find((x: { id: string }) => x.id === 'fake-publisher').ops.find((o: { name: string }) => o.name === 'scribble');
    expect(op.last_run).toMatchObject({ ok: true, out_of_scope: ['notes/stray.txt'], out_of_scope_more: 0 });
    expect(op.last_run.reserved).toBeUndefined();

    // 钩子触发：没人在看，另在最近的对话里发一条 notice。
    const created = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    fs.rmSync(path.join(f.root, 'notes'), { recursive: true });
    emitStationHook(f.s, f.s.currentProject(), 'film.approved');
    await done();
    const hook = [...f.s.tasks.tasks.values()].find((t) => t.type === 'station.hook')!;
    expect(hook.warning).toContain('notes/stray.txt');
    const events = (await send(f.s, 'GET', `/api/sessions/${created.body.session_id}/events?follow=0`)).text();
    expect(await events).toContain('自动执行的插件「假发布」改了它没有声明会写的项目文件：notes/stray.txt。');
    f.s.shutdown();
  });

  it('manages plugins without an open project, and keeps project things behind one', async () => {
    const s = startStudio({ configPath: path.join(tempDir(), 'projects.json') });
    installStation(`link:${fake}`);
    let r = await studioRequest(s, 'GET', '/api/stations');
    expect(r.status).toBe(200);
    expect(r.body.stations.some((x: { id: string }) => x.id === 'fake-publisher')).toBe(true);
    // 设置是用户级的。
    r = await studioRequest(s, 'POST', '/api/stations/fake-publisher/settings', JSON.stringify({ key: 'token', value: 'tok' }));
    expect(r.status).toBe(200);
    // 装、去掉、更新是不占项目写锁的后台任务。
    r = await studioRequest(s, 'POST', '/api/stations', JSON.stringify({ source: `link:${fake}` }));
    expect(r.status).toBe(202);
    await waitStudioTask(s, r.body.task_id);
    // 取回待装的插件：能再看一次它的实情，取消后就没了，已装的不变。
    const staged = stageStation(`link:${fake}`);
    r = await studioRequest(s, 'GET', `/api/stations/staged/${staged.token}`);
    expect(r.status).toBe(200);
    expect(r.body.preview).toMatchObject({ id: 'fake-publisher', flow: '快剪', after: 'publish' });
    expect(r.body.preview.ops_trust).toContain('它的操作是在你电脑上运行的程序');
    expect((await studioRequest(s, 'POST', `/api/stations/staged/${staged.token}/discard`, '{}')).status).toBe(200);
    expect((await studioRequest(s, 'GET', `/api/stations/staged/${staged.token}`)).status).toBe(404);
    expect((await studioRequest(s, 'POST', '/api/stations/staged/not-a-token/install', '{}')).status).toBe(404);
    expect((await studioRequest(s, 'POST', '/api/stations/nope/remove', '{}')).status).toBe(404);
    expect((await studioRequest(s, 'POST', '/api/stations/fake-publisher/update', '{}')).body.message).toContain('不需要更新');
    // 执行操作、读项目文件要打开项目。
    expect((await studioRequest(s, 'POST', '/api/stations/fake-publisher/ops/status', '{"params":{}}')).status).not.toBe(202);
    expect((await studioRequest(s, 'GET', '/api/stations/fake-publisher/read?path=publish.md')).status).not.toBe(200);
    s.shutdown();
  });

  it('refuses API calls from a sandboxed page', async () => {
    const f = newSessionFixture();
    const res = await send(f.s, 'GET', '/api/state', undefined, { Origin: 'null' });
    expect(res.status).toBe(403);
    expect((await send(f.s, 'GET', '/api/state')).status).toBe(200);
  });
});
