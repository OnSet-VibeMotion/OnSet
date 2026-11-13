import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as agentrun from '../agentrun';
import {
  attachmentText,
  createSession,
  emit,
  getSession,
  kindNotice,
  kindTurnReverted,
  kindUser,
  listSessions,
  maxQuoteRunes,
  newID,
  transcript,
  transcriptLimit,
  updateMeta,
  validateAttachments,
  type SessionEvent,
} from './sessions';
import { Server } from './studio';
import { args, lastTurn, newSessionFixture, rawGet, readScenePrompt, send, setEnv, sleep, studioRequest, tempDir, waitIdle, writeStudioFile } from './testsupport';
import { loadTurn, saveTurn, type Turn } from './turns';

function eventOf(kind: string, text: string): SessionEvent {
  return { kind, text, seq: 0, time: '' };
}

describe('sessions', () => {
  it('turn, resume and revert', async () => {
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"title":"改镜头"}');
    expect(status).toBe(201);
    const id = body.session_id as string;
    expect(body.tool).toBe('claude');
    expect(body.kind).toBe('chat');

    ({ status, body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"把开头改快一点"}'));
    expect(status).toBe(202);
    let detail = await waitIdle(f, id);
    const first = lastTurn(detail);
    expect(first.status).toBe('succeeded');
    expect(readScenePrompt(f)).toBe('edited');
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0].path).toBe('scenes/scene-001/prompt.md');
    const cliSession = detail.session.cli_session_id as string;
    let a = args(f);
    expect(a[0]).toContain('--session-id ' + cliSession);
    expect(a[0]).toContain('把开头改快一点');
    expect(a[0]).toContain('动手前先读项目规则');

    // 第二轮续接同一个 CLI 会话，不再带开场说明。
    setEnv('FAKE_CONTENT', 'edited twice');
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"再慢一点"}'));
    expect(status).toBe(202);
    detail = await waitIdle(f, id);
    const second = lastTurn(detail);
    a = args(f);
    expect(a[1]).toContain('--resume ' + cliSession);
    expect(a[1]).not.toContain('动手前先读项目规则');

    // 事件流：断线重放从 Last-Event-ID 之后开始。
    const events = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`);
    expect(events.status).toBe(200);
    for (const want of ['event: user', 'event: turn-start', 'event: session', 'event: tool-call', 'event: text', 'event: files-changed', 'event: usage', 'event: turn-end']) {
      expect(events.text, `缺少 ${want}`).toContain(want);
    }
    expect(events.text, 'done 是 agentrun 内部事件，不进会话流').not.toContain('event: done');
    const tail = await rawGet(f.s, `/api/sessions/${id}/events?follow=0&after=1000`);
    expect(tail.status).toBe(200);
    expect(tail.text).not.toContain('event:');
    // Last-Event-ID 与 ?after= 同义。
    const resumed = await send(f.s, 'GET', `/api/sessions/${id}/events?follow=0`, undefined, { 'Last-Event-ID': '1000' });
    expect(await resumed.text()).not.toContain('event:');

    // 改动详情：前后内容都能取到。
    ({ status, body } = await studioRequest(f.s, 'GET', `/api/turns/${second.turn_id}/file?path=scenes/scene-001/prompt.md`));
    expect(status).toBe(200);
    expect(body.before).toBe('edited\n');
    expect(body.after).toBe('edited twice\n');

    // 先回退第一轮：第二轮之后文件又变了，必须冲突。
    ({ status, body } = await studioRequest(f.s, 'POST', `/api/turns/${first.turn_id}/revert`));
    expect(status).toBe(409);
    expect(body.code).toBe('revert_conflict');
    // 依次回退第二轮、第一轮，回到最初。
    for (const turn of [second, first]) {
      ({ status, body } = await studioRequest(f.s, 'POST', `/api/turns/${turn.turn_id}/revert`));
      expect(status, JSON.stringify(body)).toBe(200);
    }
    expect(readScenePrompt(f)).toBe('original');
    ({ status } = await studioRequest(f.s, 'POST', `/api/turns/${first.turn_id}/revert`));
    expect(status).toBe(409);

    // 重启 Studio 后会话与事件都还在。
    const s2 = new Server({ projectPath: f.root, configPath: f.s.config.configPath });
    const sessions = listSessions(s2, f.root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cli_session_id).toBe(cliSession);
    expect(sessions[0].turns).toHaveLength(2);
    const restored = getSession(s2, f.root, id)!.events;
    expect(restored.length).toBeGreaterThan(0);
    expect(restored[restored.length - 1].kind).toBe(kindTurnReverted);
  });

  it('resume failure reseeds transcript', async () => {
    const f = newSessionFixture();
    const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    const id = body.session_id as string;
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"第一句"}');
    await waitIdle(f, id);
    setEnv('FAKE_FAIL_RESUME', '1');
    const { status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"第二句"}');
    expect(status).toBe(202);
    const detail = await waitIdle(f, id);
    expect(lastTurn(detail).status).toBe('succeeded');
    const a = args(f);
    expect(a).toHaveLength(3);
    expect(a[1]).toContain('--resume');
    expect(a[2]).toContain('--session-id');
    for (const want of ['之前的对话', '第一句', '改好了', '第二句']) expect(a[2], '补发的提示词没带上对话记录').toContain(want);
    const { text } = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`);
    expect(text, '应提示续接失败').toContain('原会话无法续接');
  });

  it('production start, busy and cancel', async () => {
    const f = newSessionFixture();
    setEnv('FAKE_SLEEP', '5');
    let { status, body } = await studioRequest(f.s, 'POST', '/api/production/start', '{"message":"竖屏，三分钟"}');
    expect(status).toBe(202);
    const id = body.session_id as string;
    expect(body.prompt).toBe('PROMPT.md');
    // 进行中：其他写入一律 409。
    for (const p of ['/api/production/start', '/api/render/all', '/api/scenes/scene-001/render', '/api/commands/project.concat']) {
      ({ status, body } = await studioRequest(f.s, 'POST', p, '{}'));
      expect(status, p).toBe(409);
    }
    // 同一个会话里再发一条：排到这一轮之后，不是 409。
    ({ status, body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"再来"}'));
    expect(status).toBe(202);
    expect(body.queued, '应当排队').toBe(true);
    ({ status, body } = await studioRequest(f.s, 'GET', '/api/sessions'));
    expect(status).toBe(200);
    expect(body.busy).not.toBe('');
    // 等编排工具真正启动后再取消。
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      // 文件先被重定向建出来、内容随后才写进去，要等到整行写完。
      if (fs.existsSync(f.argsLog) && fs.readFileSync(f.argsLog, 'utf8').endsWith('\n')) break;
      await sleep(20);
    }
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/cancel`));
    expect(status).toBe(200);
    const detail = await waitIdle(f, id);
    const turn = lastTurn(detail);
    expect(turn.status).toBe('cancelled');
    expect(detail.session.kind).toBe('production');
    // 按停止：排队的消息一并作废，不会自己开下一轮。
    expect(detail.turns, '停止后不该再跑排队的消息').toHaveLength(1);
    const { text } = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`);
    expect(text).toContain('event: queued');
    expect(text).toContain('排队的 1 条消息不再发送');
    const a = args(f);
    expect(a[0]).toContain('整片制作提示词');
    expect(a[0]).toContain('用户补充：竖屏，三分钟');
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/cancel`));
    expect(status).toBe(409);
  });

  it('interrupted turn is marked on restart', () => {
    const f = newSessionFixture();
    const sess = createSession(f.s, f.root, 'chat', 'x', { tool: 'claude', renderer: 'claude' });
    const turn: Turn = { turn_id: newID('t'), session_id: sess.meta.session_id, kind: '', message: '', status: 'running', started_at: new Date().toISOString(), changes: null, before: null };
    saveTurn(f.root, turn);
    updateMeta(sess, (meta) => {
      meta.turns = [turn.turn_id];
      meta.running_turn = turn.turn_id;
    });
    const s2 = new Server({ projectPath: f.root, configPath: f.s.config.configPath });
    expect(listSessions(s2, f.root)[0].running_turn).toBeUndefined();
    expect(loadTurn(f.root, turn.turn_id).status).toBe('interrupted');
  });

  it('session request validation', async () => {
    const f = newSessionFixture();
    const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    const id = body.session_id as string;
    const cases: [string, string, string, number][] = [
      ['POST', '/api/sessions', '{', 400],
      ['DELETE', '/api/sessions', '', 405],
      ['GET', '/api/sessions/../x', '', 404],
      ['GET', '/api/sessions/s-missing', '', 404],
      ['GET', `/api/sessions/${id}/bogus`, '', 404],
      ['GET', `/api/sessions/${id}/turns`, '', 405],
      ['POST', `/api/sessions/${id}/turns`, '{"message":"  "}', 400],
      ['POST', `/api/sessions/${id}/turns`, '{"message":"x","attachments":[{"path":"../../etc/passwd"}]}', 400],
      ['POST', `/api/sessions/${id}/turns`, '{"message":"x","attachments":[{"path":"production/studio/attachments/missing.png"}]}', 400],
      ['POST', `/api/sessions/${id}/turns`, '{"message":"x","attachments":[{"source":"../outside.html"}]}', 400],
      ['GET', `/api/sessions/${id}/cancel`, '', 405],
      ['GET', '/api/production/start', '', 405],
      ['POST', '/api/production/start', '{"prompt":"../x.md"}', 400],
      ['POST', '/api/production/start', '{"prompt":"missing.md"}', 400],
      ['GET', '/api/turns/t-missing', '', 404],
      ['POST', '/api/commands/rm-rf', '{}', 404],
      ['GET', '/api/commands/project.concat', '', 405],
      ['POST', '/api/commands/scene.validate', '{"scene_id":"missing"}', 404],
      ['POST', '/api/commands/publish.check', '{}', 400],
      ['POST', '/api/commands/beat.regrid', '{"meter":4,"anchor":4}', 400],
      ['POST', '/api/commands/beat.regrid', '{"meter":0,"anchor":0}', 400],
      ['POST', '/api/commands/beat.regrid', '{"meter":"4","anchor":"1"}', 400],
      ['GET', '/api/scenes/scene-001/render', '', 405],
      ['POST', '/api/scenes/scene-001/attachment', '{"seconds":0}', 400],
      ['POST', '/api/scenes/scene-001/attachment', '{"seconds":-1}', 400],
    ];
    for (const [method, p, payload, want] of cases) {
      const res = await studioRequest(f.s, method, p, payload);
      expect(res.status, `${method} ${p} → ${JSON.stringify(res.body)}`).toBe(want);
    }
  });

  it('files, preview and skills', async () => {
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'GET', '/api/files?path=scenes/scene-001/prompt.md');
    expect(status).toBe(200);
    expect(body.content).toBe('original');
    expect(body.binary).toBe(false);
    for (const [p, want] of Object.entries({ '../etc/passwd': 400, '/etc/passwd': 400, '.env': 403, 'missing.md': 404, scenes: 404 })) {
      ({ status, body } = await studioRequest(f.s, 'GET', '/api/files?path=' + p));
      expect(status, `${p} → ${JSON.stringify(body)}`).toBe(want);
    }
    try {
      fs.symlinkSync('/etc', path.join(f.root, 'escape'));
      ({ status } = await studioRequest(f.s, 'GET', '/api/files?path=escape/hosts'));
      expect(status, '符号链接逃逸应被拒').toBe(400);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
    writeStudioFile(path.join(f.root, 'blob.bin'), 'a\x00b');
    ({ body } = await studioRequest(f.s, 'GET', '/api/files?path=blob.bin'));
    expect(body.binary).toBe(true);
    expect(body.content).toBe('');

    const preview = await rawGet(f.s, '/preview/scenes/scene-001/');
    expect(preview.status).toBe(200);
    expect(preview.text).toContain('composition');
    for (const p of ['/preview/scenes/scene-001/.env', '/preview/scenes/missing/index.html', '/preview/scenes/scene-001/%2e%2e/%2e%2e/PROMPT.md']) {
      const res = await rawGet(f.s, p);
      const leaked = res.status === 200 && (res.text.includes('NOTE=1') || res.text.includes('整片制作提示词'));
      expect(leaked, `${p} 不应可读：${res.text}`).toBe(false);
    }

    ({ status, body } = await studioRequest(f.s, 'GET', '/api/skills'));
    expect(status).toBe(200);
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0].name).toBe('scene-kit');
    expect(body.upstream.commit).toBe('abc');
  });

  it('session events follow streams new events', async () => {
    const f = newSessionFixture();
    const sess = createSession(f.s, f.root, 'chat', 'x', { tool: 'claude', renderer: 'claude' });
    const controller = new AbortController();
    const res = await f.s.handle(new Request(`http://studio.test/api/sessions/${sess.meta.session_id}/events`, { signal: controller.signal }));
    const timer = setTimeout(() => emit(sess, '', { kind: kindNotice, text: 'hello' }), 100);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 5000;
    let got = false;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
      if (text.split('\n').some((line) => line.startsWith('data:') && line.includes('hello'))) {
        got = true;
        break;
      }
    }
    clearTimeout(timer);
    await reader.cancel();
    controller.abort();
    expect(got, '没有收到新事件').toBe(true);
  });

  it('attachment text', () => {
    const text = attachmentText([
      { scene_id: 'scene-001', path: 'production/studio/attachments/a.png', seconds: 1.5, region: { x: 1, y: 2, w: 3, h: 4 }, selector: '#title', source: 'scenes/scene-001/index.html', note: '太挤' },
    ]);
    for (const want of ['镜头 scene-001', '1.50 秒', 'a.png', 'x=1 y=2 宽 3 高 4', '`#title`', 'index.html', '太挤']) expect(text).toContain(want);
    expect(attachmentText(null), '没有附件时不加内容').toBe('');
    const quoted = attachmentText([
      { quote: '第一行\n第二行', label: '口播稿第 2 段', source: 'production/script-final.md' },
      { ref: true, scene_id: 'scene-003' },
      { ref: true, source: 'production/treatment.md', note: '看主旨' },
    ]);
    for (const want of ['用户引用的内容', '口播稿第 2 段（production/script-final.md）：\n  > 第一行\n  > 第二行', '- 镜头 scene-003', '- 文件 production/treatment.md\n  备注：看主旨']) {
      expect(quoted).toContain(want);
    }
    const root = tempDir();
    expect(() => validateAttachments(root, [{ quote: '字'.repeat(maxQuoteRunes + 1) }]), '超长引用应当拒绝').toThrow();
    expect(() => validateAttachments(root, [{ ref: true }]), '空引用应当拒绝').toThrow();
    expect(() => validateAttachments(root, [{ quote: 'x', source: '../outside.md' }]), '项目外的出处应当拒绝').toThrow();
    const got = transcript([eventOf(kindUser, '长'.repeat(transcriptLimit + 10))]);
    expect([...got].length, '对话记录没有截断').toBeLessThanOrEqual(transcriptLimit);
    // agentrun 的正文事件算「你」说的话。
    expect(transcript([eventOf(agentrun.KindText, '好')])).toBe('你：好');
  });

  // 进行中发的消息排队，这一轮结束后合并成下一轮；「打断并发送」停掉当前这一轮，马上发出排队的消息。
  it('queued messages run after turn and interrupt', async () => {
    const f = newSessionFixture();
    setEnv('FAKE_SLEEP', '1');
    let { status, body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"title":"排队"}');
    expect(status).toBe(201);
    const id = body.session_id as string;
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"第一件事"}'));
    expect(status).toBe(202);
    for (const message of ['补充一', '补充二']) {
      ({ status, body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, `{"message":"${message}"}`));
      expect(status).toBe(202);
      expect(body.queued, '应当排队').toBe(true);
    }
    // 第一轮结束后自动开第二轮，两条补充合并成一条消息。
    let deadline = Date.now() + 10_000;
    let turns: any[] = [];
    while (Date.now() < deadline) {
      const detail = await waitIdle(f, id);
      turns = detail.turns;
      if (turns.length === 2) break;
      await sleep(50);
    }
    expect(turns, '排队的消息应当自动发出').toHaveLength(2);
    expect(turns[1].message).toContain('补充一');
    expect(turns[1].message).toContain('补充二');

    // 打断并发送。
    setEnv('FAKE_SLEEP', '5');
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"慢活"}'));
    expect(status).toBe(202);
    deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(f.argsLog) && (fs.readFileSync(f.argsLog, 'utf8').match(/\n/g) ?? []).length >= 3) break;
      await sleep(20);
    }
    setEnv('FAKE_SLEEP', '');
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"改主意了","interrupt":true}'));
    expect(status).toBe(202);
    deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const detail = await waitIdle(f, id);
      turns = detail.turns;
      if (turns.length === 4) break;
      await sleep(50);
    }
    expect(turns).toHaveLength(4);
    expect(turns[2].status).toBe('cancelled');
    expect(turns[3].message).toBe('改主意了');
  });

  // 排队的消息能移除；「引导对话」停掉这一轮，把那条提到最前马上发出。
  it('queued messages can be removed and steered', async () => {
    const f = newSessionFixture();
    setEnv('FAKE_SLEEP', '5');
    let { status, body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"title":"排队管理"}');
    expect(status).toBe(201);
    const id = body.session_id as string;
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"慢活"}'));
    expect(status).toBe(202);
    for (const message of ['不要了', '先做这个']) {
      ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, `{"message":"${message}"}`));
      expect(status).toBe(202);
    }
    let { text } = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`);
    const ids = [...text.matchAll(/"queue_id":"(q-[a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(ids, text).toHaveLength(2);
    ({ status } = await studioRequest(f.s, 'DELETE', `/api/sessions/${id}/queue/${ids[0]}`));
    expect(status).toBe(200);
    ({ status } = await studioRequest(f.s, 'DELETE', `/api/sessions/${id}/queue/${ids[0]}`));
    expect(status).toBe(409);
    setEnv('FAKE_SLEEP', '');
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/queue/${ids[1]}/steer`));
    expect(status).toBe(200);
    const deadline = Date.now() + 10_000;
    let turns: any[] = [];
    while (Date.now() < deadline) {
      const detail = await waitIdle(f, id);
      turns = detail.turns;
      if (turns.length === 2) break;
      await sleep(50);
    }
    expect(turns).toHaveLength(2);
    expect(turns[0].status).toBe('cancelled');
    expect(turns[1].message).toBe('先做这个');
    ({ text } = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`));
    expect(text, '移除要留下 unqueued 事件').toContain('event: unqueued');
  });
});
