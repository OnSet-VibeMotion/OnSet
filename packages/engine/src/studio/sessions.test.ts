import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as agentrun from '../agentrun';
import * as ledger from '../ledger';
import * as preset from '../preset';
import * as project from '../project';
import { collect, prepare } from '../renderassets';
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
  replayGuard,
  reseedPrompt,
  type SessionEvent,
  sessionEventJSON,
  transcript,
  transcriptLimit,
  updateMeta,
  validateAttachments,
} from './sessions';
import { Server } from './studio';
import {
  args,
  lastTurn,
  newSessionFixture,
  rawGet,
  readScenePrompt,
  send,
  setEnv,
  sleep,
  studioRequest,
  tempDir,
  waitIdle,
  writeStudioFile,
} from './testsupport';
import { loadTurn, saveTurn, type Turn } from './turns';

function eventOf(kind: string, text: string): SessionEvent {
  return { kind, text, seq: 0, time: '' };
}

describe('sessions', () => {
  it('keeps streamed thought prefixes that also appeared in the previous turn', () => {
    const previous = [{ turn_id: 't1', kind: 'thinking', text: 'Let me ', text_id: 'acp-thought-1' }];
    const replay = replayGuard(previous, 't2');
    expect(replay({ kind: 'thinking', text: 'Let me ', text_id: 'acp-thought-1' })).toBe(false);
    expect(replay({ kind: 'thinking', text: 'check the new request', text_id: 'acp-thought-1' })).toBe(false);
  });

  it('serves shared font and JS links through the actual preview route', async () => {
    const f = newSessionFixture();
    const source = path.join(f.root, 'assets', 'shared-test');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'font.woff2'), 'font-bytes');
    fs.writeFileSync(path.join(source, 'library.js'), 'window.shared = true;');
    const scene = path.join(f.root, 'scenes', 'scene-001');
    prepare(f.root, scene, collect([{ from: source, to: 'vendor' }]));
    for (const [name, body] of [
      ['font.woff2', 'font-bytes'],
      ['library.js', 'window.shared = true;'],
    ]) {
      const response = await rawGet(f.s, '/preview/scenes/scene-001/vendor/' + name);
      expect(response.status).toBe(200);
      expect(response.text).toBe(body);
    }
  });
  it('keeps overlapping plugin writes out of a turn rollback', async () => {
    const f = newSessionFixture();
    const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"title":"并发"}');
    const sessionID = body.session_id as string;
    f.s.beginShared('upload', f.root, '正在上传');
    const started = await studioRequest(f.s, 'POST', `/api/sessions/${sessionID}/turns`, '{"message":"改开头"}');
    expect(started.status).toBe(202);
    const receipt = path.join(f.root, 'production/plugin/receipt.json');
    writeStudioFile(receipt, '{"uploaded":true}');
    f.s.endShared('upload');

    const turn = lastTurn(await waitIdle(f, sessionID));
    expect(turn.changes).toContainEqual({ path: 'production/plugin/receipt.json', change: 'added', revertable: false });
    const reverted = await studioRequest(f.s, 'POST', `/api/turns/${turn.turn_id}/revert`);
    expect(reverted.status).toBe(200);
    expect(reverted.body.skipped).toContain('production/plugin/receipt.json');
    expect(fs.readFileSync(receipt, 'utf8')).toBe('{"uploaded":true}');
  });

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
    expect(a[0]).toContain('## 镜头实现的归属');

    // 第二轮续接同一个 CLI 会话，不再重复发送开场说明与 5KB 镜头归属规则。
    setEnv('FAKE_CONTENT', 'edited twice');
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"再慢一点"}'));
    expect(status).toBe(202);
    detail = await waitIdle(f, id);
    const second = lastTurn(detail);
    a = args(f);
    expect(a[1]).toContain('--resume ' + cliSession);
    expect(a[1]).not.toContain('动手前先读项目规则');
    expect(a[1]).not.toContain('不得创建、编辑或覆盖镜头实现代码');

    // 事件流：断线重放从 Last-Event-ID 之后开始。
    const events = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`);
    expect(events.status).toBe(200);
    for (const want of [
      'event: user',
      'event: turn-start',
      'event: session',
      'event: tool-call',
      'event: text',
      'event: files-changed',
      'event: usage',
      'event: turn-end',
    ]) {
      expect(events.text, `缺少 ${want}`).toContain(want);
    }
    expect(events.text, 'done 是 agentrun 内部事件，不进会话流').not.toContain('event: done');
    const tail = await rawGet(f.s, `/api/sessions/${id}/events?follow=0&after=1000`);
    expect(tail.status).toBe(200);
    expect(tail.text).not.toContain('event:');
    // Last-Event-ID 与 ?after= 同义。
    const resumed = await send(f.s, 'GET', `/api/sessions/${id}/events?follow=0`, undefined, {
      'Last-Event-ID': '1000',
    });
    expect(await resumed.text()).not.toContain('event:');

    // 改动详情：前后内容都能取到。
    ({ status, body } = await studioRequest(
      f.s,
      'GET',
      `/api/turns/${second.turn_id}/file?path=scenes/scene-001/prompt.md`,
    ));
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

  // qoder 续接前压缩长对话后会把上一轮结尾的思考与回复原样再吐一遍：开头那几段一字不差的不算这一轮说的。
  it('drops the previous turn replayed at the start of a resumed turn', () => {
    const events = [
      { turn_id: 't1', kind: 'thinking', text: '总结一下' },
      { turn_id: 't1', kind: 'text', text: '成片重出了。' },
      { turn_id: 't2', kind: 'user', text: '分镜 5 不对' },
    ];
    const replay = replayGuard(events, 't2');
    expect(replay({ kind: 'session' })).toBe(false);
    expect(replay({ kind: 'thinking', text: '总结一下' })).toBe(true);
    expect(replay({ kind: 'text', text: ' 成片重出了。\n' })).toBe(true);
    expect(replay({ kind: 'text', text: '我先看一下 scene-005。' })).toBe(false);
    // 有了新东西以后，哪怕又说了一样的话，也照常记下。
    expect(replay({ kind: 'text', text: '成片重出了。' })).toBe(false);
    // 第一轮没有上一轮，什么都不拦。
    expect(replayGuard([{ turn_id: 't1', kind: 'user', text: 'x' }], 't1')({ kind: 'text', text: 'x' })).toBe(false);
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
    for (const want of ['之前的对话', '第一句', '改好了', '第二句'])
      expect(a[2], '补发的提示词没带上对话记录').toContain(want);
    const { text } = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`);
    expect(text, '应提示续接失败').toContain('原会话无法续接');
  });

  // 编排会话越续越长，每次调用都要重读整段上下文：最近一轮平均上下文到了阈值，下一轮换新会话、带上对话记录与交接说明（rotate.ts）。
  it('starts a new CLI session once the conversation gets too long', async () => {
    const f = newSessionFixture();
    const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    const id = body.session_id as string;
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"第一句"}');
    const first = await waitIdle(f, id);
    const old = first.session.cli_session_id as string;
    ledger.append(
      ledger.projectFile(f.root),
      ledger.fromResult(
        ledger.SourceStudio,
        'claude',
        '',
        old,
        { input_tokens: 40 * 300_000, turns: 40, source: 'claude result', basis: 'total-input' },
        null,
        false,
      ),
    );
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"第二句"}');
    const detail = await waitIdle(f, id);
    expect(lastTurn(detail).status).toBe('succeeded');
    const a = args(f);
    expect(a).toHaveLength(2);
    expect(a[1]).not.toContain('--resume');
    expect(a[1]).toContain('--session-id');
    expect(detail.session.cli_session_id).not.toBe(old);
    for (const want of ['换了一个新会话接着做', '以文件为准', '之前的对话', '第一句', '第二句'])
      expect(a[1], want).toContain(want);
    const { text } = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`);
    expect(text).toContain('这一轮换一个新会话接着做');
    // 新会话还短：再下一轮照常续接。
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"第三句"}');
    await waitIdle(f, id);
    expect(args(f)[2]).toContain('--resume ' + (detail.session.cli_session_id as string));
  });

  // 整片制作换了 CLI 会话时，第一轮的制作说明不在对话记录里，要重发（2026-11：qoder 换会话后只剩对话记录）。
  it('a reseeded production session gets the production prompt again', async () => {
    const f = newSessionFixture();
    const { body } = await studioRequest(f.s, 'POST', '/api/production/start', '{"message":"竖屏，三分钟"}');
    const id = body.session_id as string;
    const initial = await waitIdle(f, id);
    expect(lastTurn(initial).status, JSON.stringify(lastTurn(initial))).toBe('succeeded');
    setEnv('FAKE_FAIL_RESUME', '1');
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"第二句"}');
    await waitIdle(f, id);
    const a = args(f);
    expect(a).toHaveLength(3);
    // 制作提示词的标题（第一轮原样发过），重开的会话里也要有；续接尝试 a[1] 不重复发送 5KB 归属规则，重开新会话 a[2] 自动补回。
    const opening = project.runPrompt(f.root, '').prompt.toString('utf8').split('\n')[0];
    expect(a[0]).toContain(opening);
    expect(a[0]).toContain('## 镜头实现的归属');
    expect(a[0]).toContain('flow_guide(');
    expect(a[1]).not.toContain('## 镜头实现的归属');
    expect(a[2]).toContain('## 镜头实现的归属');
    expect(a[2], '重开的会话没带上制作说明').toContain(opening);
    for (const want of ['整片制作的说明', '之前的对话', '改好了', '第二句']) expect(a[2]).toContain(want);
    // 普通对话不带制作说明。
    expect(reseedPrompt('用户：你好', '再说一句')).not.toContain('整片制作的说明');
  });

  it('production start, busy and cancel', async () => {
    const f = newSessionFixture();
    setEnv('FAKE_SLEEP', '5');
    let { status, body } = await studioRequest(f.s, 'POST', '/api/production/start', '{"message":"竖屏，三分钟"}');
    expect(status).toBe(202);
    const id = body.session_id as string;
    expect(body.prompt).toBe('口播流程');
    const initial = await studioRequest(f.s, 'GET', `/api/sessions/${id}`);
    expect(initial.body.session.running_turn, JSON.stringify(lastTurn(initial.body))).toBeDefined();
    // 进行中：其他写入一律 409。
    for (const p of [
      '/api/production/start',
      '/api/render/all',
      '/api/scenes/scene-001/render',
      '/api/commands/project.concat',
    ]) {
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
    // 开工发的是按项目流程组合出的制作提示词。
    expect(a[0]).toContain('# 完成一次从稿件到成片的');
    expect(a[0]).toContain('用户补充：竖屏，三分钟');
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/cancel`));
    expect(status).toBe(409);
  });

  it('interrupted turn is marked on restart', () => {
    const f = newSessionFixture();
    const sess = createSession(f.s, f.root, 'chat', 'x', { tool: 'claude', renderer: 'claude' });
    const turn: Turn = {
      turn_id: newID('t'),
      session_id: sess.meta.session_id,
      kind: '',
      message: '',
      status: 'running',
      started_at: new Date().toISOString(),
      changes: null,
      before: null,
    };
    saveTurn(f.root, turn);
    updateMeta(sess, (meta) => {
      meta.turns = [turn.turn_id];
      meta.running_turn = turn.turn_id;
    });
    emit(sess, turn.turn_id, { kind: 'turn-start', status: 'running' });
    const s2 = new Server({ projectPath: f.root, configPath: f.s.config.configPath });
    expect(listSessions(s2, f.root)[0].running_turn).toBeUndefined();
    expect(loadTurn(f.root, turn.turn_id).status).toBe('interrupted');
    expect(getSession(s2, f.root, sess.meta.session_id)!.events.at(-1)).toMatchObject({
      kind: 'turn-end',
      turn_id: turn.turn_id,
      status: 'interrupted',
      text: 'Studio 在本轮进行中退出',
    });
  });

  it.each(['running', 'interrupted', 'succeeded', 'failed', 'missing'])(
    'repairs a missing end event for a %s turn even after running_turn was cleared',
    async (status) => {
      const f = newSessionFixture();
      const sess = createSession(f.s, f.root, 'chat', 'x', { tool: 'qoder', renderer: 'qoder' });
      const turn: Turn = {
        turn_id: newID('t'),
        session_id: sess.meta.session_id,
        kind: 'chat',
        message: '渲染所有镜头',
        status,
        started_at: new Date().toISOString(),
        changes: [],
        before: null,
      };
      if (status !== 'missing') saveTurn(f.root, turn);
      updateMeta(sess, (meta) => {
        meta.turns = [turn.turn_id];
      });
      emit(sess, turn.turn_id, { kind: 'turn-start', status: 'running' });
      emit(sess, turn.turn_id, { kind: 'tool-call', tool: 'mcp__onset__scene_run_all', call_id: 'render' });
      const s2 = new Server({ projectPath: f.root, configPath: f.s.config.configPath });
      const restored = getSession(s2, f.root, sess.meta.session_id)!;
      const expected = status === 'missing' || status === 'running' ? 'interrupted' : status;
      expect(restored.cancel).toBeNull();
      expect(restored.events.at(-1)).toMatchObject({
        seq: 3,
        kind: 'turn-end',
        turn_id: turn.turn_id,
        status: expected,
      });
      const response = await rawGet(s2, `/api/sessions/${sess.meta.session_id}/events?follow=0&after=2`);
      expect(response.text).toContain('event: turn-end');
      const s3 = new Server({ projectPath: f.root, configPath: f.s.config.configPath });
      expect(getSession(s3, f.root, sess.meta.session_id)!.events.map(sessionEventJSON)).toEqual(
        restored.events.map(sessionEventJSON),
      );
    },
  );

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
      [
        'POST',
        `/api/sessions/${id}/turns`,
        '{"message":"x","attachments":[{"path":"production/studio/attachments/missing.png"}]}',
        400,
      ],
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
    for (const [p, want] of Object.entries({
      '../etc/passwd': 400,
      '/etc/passwd': 400,
      '.env': 403,
      'missing.md': 404,
      scenes: 404,
    })) {
      ({ status, body } = await studioRequest(f.s, 'GET', '/api/files?path=' + p));
      expect(status, `${p} → ${JSON.stringify(body)}`).toBe(want);
    }
    const outside = fs.realpathSync(tempDir());
    writeStudioFile(path.join(outside, 'private.txt'), 'outside project');
    fs.symlinkSync(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    ({ status } = await studioRequest(f.s, 'GET', '/api/files?path=escape/private.txt'));
    expect(status, '符号链接逃逸应被拒').toBe(400);
    writeStudioFile(path.join(f.root, 'blob.bin'), 'a\x00b');
    ({ body } = await studioRequest(f.s, 'GET', '/api/files?path=blob.bin'));
    expect(body.binary).toBe(true);
    expect(body.content).toBe('');

    const preview = await rawGet(f.s, '/preview/scenes/scene-001/');
    expect(preview.status).toBe(200);
    expect(preview.text).toContain('composition');
    for (const p of [
      '/preview/scenes/scene-001/.env',
      '/preview/scenes/missing/index.html',
      '/preview/scenes/scene-001/%2e%2e/%2e%2e/onset.conf',
    ]) {
      const res = await rawGet(f.s, p);
      const leaked = res.status === 200 && (res.text.includes('NOTE=1') || res.text.includes('ORCHESTRATOR=claude'));
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
    const res = await f.s.handle(
      new Request(`http://studio.test/api/sessions/${sess.meta.session_id}/events`, { signal: controller.signal }),
    );
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
      {
        scene_id: 'scene-001',
        path: 'production/studio/attachments/a.png',
        seconds: 1.5,
        region: { x: 1, y: 2, w: 3, h: 4 },
        selector: '#title',
        source: 'scenes/scene-001/index.html',
        note: '太挤',
      },
    ]);
    for (const want of ['镜头 scene-001', '1.50 秒', 'a.png', 'x=1 y=2 宽 3 高 4', '`#title`', 'index.html', '太挤'])
      expect(text).toContain(want);
    expect(attachmentText(null), '没有附件时不加内容').toBe('');
    const quoted = attachmentText([
      { quote: '第一行\n第二行', label: '口播稿第 2 段', source: 'production/script-final.md' },
      { ref: true, scene_id: 'scene-003' },
      { ref: true, source: 'production/treatment.md', note: '看主旨' },
    ]);
    for (const want of [
      '用户引用的内容',
      '口播稿第 2 段（production/script-final.md）：\n  > 第一行\n  > 第二行',
      '- 镜头 scene-003',
      '- 文件 production/treatment.md\n  备注：看主旨',
    ]) {
      expect(quoted).toContain(want);
    }
    const root = tempDir();
    expect(() => validateAttachments(root, [{ quote: '字'.repeat(maxQuoteRunes + 1) }]), '超长引用应当拒绝').toThrow();
    expect(() => validateAttachments(root, [{ ref: true }]), '空引用应当拒绝').toThrow();
    expect(
      () => validateAttachments(root, [{ quote: 'x', source: '../outside.md' }]),
      '项目外的出处应当拒绝',
    ).toThrow();
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
    ({ status } = await studioRequest(
      f.s,
      'POST',
      `/api/sessions/${id}/turns`,
      '{"message":"改主意了","interrupt":true}',
    ));
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

it('keeps an existing conversation usable when its usage ledger cannot be read', async () => {
  const f = newSessionFixture();
  const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
  const id = body.session_id as string;
  await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"first"}');
  const first = await waitIdle(f, id);
  const spy = vi.spyOn(ledger, 'read').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  try {
    const response = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"second"}');
    expect(response.status).toBe(202);
  } finally {
    spy.mockRestore();
  }
  const second = await waitIdle(f, id);
  expect(lastTurn(second).status).toBe('succeeded');
  expect(second.session.cli_session_id).toBe(first.session.cli_session_id);
});
it('hands off the last saved plan after restarting and rotating the CLI session', async () => {
  const f = newSessionFixture();
  const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
  const id = body.session_id as string;
  await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"first"}');
  const first = await waitIdle(f, id);
  const sess = getSession(f.s, f.root, id)!;
  emit(sess, lastTurn(first).turn_id, {
    kind: agentrun.KindPlan,
    plan: [{ id: 'task-1', text: '尚未完成的精确任务', status: 'pending' }],
  });
  ledger.append(
    ledger.projectFile(f.root),
    ledger.fromResult(
      ledger.SourceStudio,
      'claude',
      '',
      first.session.cli_session_id as string,
      { input_tokens: 40 * 300_000, turns: 40, source: 'claude result', basis: 'total-input' },
      null,
      false,
    ),
  );
  const restarted = new Server({ ...f.s.config, projectPath: f.root });
  try {
    expect(
      getSession(restarted, f.root, id)!.events.find((e) => e.kind === agentrun.KindPlan)?.plan?.[0].id,
    ).toBeUndefined();
    await studioRequest(restarted, 'POST', `/api/sessions/${id}/turns`, '{"message":"continue"}');
    await waitIdle({ ...f, s: restarted }, id);
    expect(args(f)[1]).toContain('尚未完成的精确任务');
  } finally {
    restarted.shutdown();
  }
});

it('supports manual stage-boundary session handoff with a fresh CLI session and project state snapshot', async () => {
  const f = newSessionFixture();
  const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
  const id = body.session_id as string;

  // 空会话不能分段接力。
  const rejected = await studioRequest(f.s, 'POST', `/api/sessions/${id}/handoff`, '{}');
  expect(rejected.status).toBe(400);

  await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"先定分镜"}');
  const first = await waitIdle(f, id);
  expect(first.session.cli_session_id).toBeTruthy();

  // 在项目里放一个未渲染镜头和一个已渲染镜头，验证项目快照准确写入交接提示词。
  const s1 = path.join(f.root, 'scenes', 'scene-001');
  const s2 = path.join(f.root, 'scenes', 'scene-002');
  fs.mkdirSync(s1, { recursive: true });
  fs.mkdirSync(s2, { recursive: true });
  fs.writeFileSync(path.join(s1, 'scene.json'), '{"id":"scene-001","duration_seconds":3,"output":"scene-001.mp4"}');
  fs.writeFileSync(path.join(s1, 'scene-001.mp4'), 'mp4');
  fs.writeFileSync(path.join(s2, 'scene.json'), '{"id":"scene-002","duration_seconds":4,"output":"scene-002.mp4"}');

  const handed = await studioRequest(f.s, 'POST', `/api/sessions/${id}/handoff`, '{"reason":"分镜已确认，切入渲染"}');
  expect(handed.status).toBe(200);
  expect(handed.body.session.cli_session_id).toBeUndefined();
  expect(handed.body.session.handoff_reason).toBe('分镜已确认，切入渲染');
  const eventsText = (await rawGet(f.s, `/api/sessions/${id}/events?follow=0`)).text;
  expect(eventsText).toContain('已开启新会话接力');

  await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"开始渲染剩余镜头"}');
  const second = await waitIdle(f, id);
  expect(lastTurn(second).status).toBe('succeeded');
  expect(second.session.cli_session_id).not.toBe(first.session.cli_session_id);
  expect(second.session.handoff_reason).toBeUndefined();
  // 第二轮走了开新会话（没有 --resume），提示词里带了交接原因和实时项目快照。
  expect(args(f)[1]).not.toContain('--resume');
  expect(args(f)[1]).toContain('分镜已确认，切入渲染');
  expect(args(f)[1]).toContain('当前项目文件快照');
  expect(args(f)[1]).toContain('共 2 镜；已就绪 1；未渲染 1（scene-002）');
});

it('auto-hands off production sessions when a major stage gate is confirmed', async () => {
  const f = newSessionFixture();
  writeStudioFile(path.join(f.root, 'production', 'script-final.md'), '# 终稿\n\n第一句。\n');
  const started = await studioRequest(f.s, 'POST', '/api/production/start', '{}');
  expect(started.status).toBe(202);
  const id = started.body.session_id as string;
  await waitIdle(f, id);
  await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"继续完善口播稿"}');
  const second = await waitIdle(f, id);
  const oldCliSession = second.session.cli_session_id as string;
  expect(oldCliSession).toBeTruthy();
  // 会话上下文已攒到 ≥10 万 token 时，关卡确认应自动分段接力。
  ledger.append(ledger.projectFile(f.root), {
    time: new Date().toISOString(),
    source: 'studio',
    tool: 'claude',
    session: oldCliSession,
    status: 'succeeded',
    usage: { input_tokens: 10 * 110_000, turns: 10, source: 'claude result', basis: 'total-input' },
  });

  const confirmed = await studioRequest(f.s, 'POST', '/api/progress/gates/gate-script', '{}');
  expect(confirmed.status).toBe(200);
  const sess = getSession(f.s, f.root, id)!;
  expect(sess.meta.handoff_reason).toContain('自动分段接力进入下一阶段');

  await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"开始配音"}');
  const third = await waitIdle(f, id);
  expect(lastTurn(third).status).toBe('succeeded');
  expect(third.session.cli_session_id).not.toBe(oldCliSession);
  expect(third.session.handoff_reason).toBeUndefined();
  expect(args(f)[2]).not.toContain('--resume');
  expect(args(f)[2]).toContain('当前项目文件快照');

  // 终审关卡（gate-final，由编排落盘 production/approval.json）在会话够重或空闲超过缓存 TTL 时也能自动预约下一轮接力。
  const finalCliSession = third.session.cli_session_id as string;
  ledger.append(ledger.projectFile(f.root), {
    time: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    source: 'studio',
    tool: 'claude',
    session: finalCliSession,
    status: 'succeeded',
    usage: { input_tokens: 4 * 50_000, turns: 4, source: 'claude result', basis: 'total-input' },
  });
  const { scheduleGateHandoff } = await import('./sessions');
  scheduleGateHandoff(f.s, f.root, 'gate-final', '试听确认');
  expect(getSession(f.s, f.root, id)!.meta.handoff_reason).toContain('试听确认');
});

it('skips gate auto-handoff when the CLI session is still light and warm in cache', async () => {
  const f = newSessionFixture();
  writeStudioFile(path.join(f.root, 'production', 'script-final.md'), '# 终稿\n\n第一句。\n');
  const started = await studioRequest(f.s, 'POST', '/api/production/start', '{}');
  const id = started.body.session_id as string;
  await waitIdle(f, id);
  await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"微调一句"}');
  const second = await waitIdle(f, id);
  const cliSession = second.session.cli_session_id as string;
  expect(cliSession).toBeTruthy();

  // 写入一条刚结束（热缓存）且上下文很轻（5 万 token、4 步）的账本记录。
  ledger.append(ledger.projectFile(f.root), {
    time: new Date().toISOString(),
    source: 'studio',
    tool: 'claude',
    session: cliSession,
    status: 'succeeded',
    usage: { input_tokens: 4 * 50_000, turns: 4, source: 'claude result', basis: 'total-input' },
  });

  const confirmed = await studioRequest(f.s, 'POST', '/api/progress/gates/gate-script', '{}');
  expect(confirmed.status).toBe(200);
  // 轻会话 + 热缓存不拆缓存，保持原会话继续复用。
  expect(getSession(f.s, f.root, id)!.meta.handoff_reason).toBeUndefined();

  // 一旦上下文增长到 ≥10 万 token，关卡确认就会预约分段接力。
  ledger.append(ledger.projectFile(f.root), {
    time: new Date().toISOString(),
    source: 'studio',
    tool: 'claude',
    session: cliSession,
    status: 'succeeded',
    usage: { input_tokens: 8 * 110_000, turns: 8, source: 'claude result', basis: 'total-input' },
  });
  const { scheduleGateHandoff } = await import('./sessions');
  scheduleGateHandoff(f.s, f.root, 'gate-voice', '配音审核');
  expect(getSession(f.s, f.root, id)!.meta.handoff_reason).toContain('配音审核');
});

it('creates and starts production across every builtin canvas preset without placeholder errors', async () => {
  const f = newSessionFixture();
  const parent = tempDir();
  setEnv('HOME', parent);
  if (process.platform === 'win32') setEnv('USERPROFILE', parent);
  for (const p of preset.all()) {
    const created = await studioRequest(
      f.s,
      'POST',
      '/api/projects/create',
      JSON.stringify({
        parent,
        name: `startup-${p.id}`,
        canvas: p.id,
        delivery: 'speech',
        narration: 'solo',
      }),
    );
    expect(created.status, `create ${p.id}`).toBe(201);

    const started = await studioRequest(
      f.s,
      'POST',
      '/api/production/start',
      JSON.stringify({ message: `启动 ${p.id} 测试` }),
    );
    expect(started.status, `start ${p.id}: ${JSON.stringify(started.body)}`).toBe(202);
    const sid = started.body.session_id as string;
    const detail = await waitIdle(f, sid);
    expect(lastTurn(detail).status, `turn ${p.id}`).toBe('succeeded');
  }
  const calls = args(f);
  expect(calls.length).toBeGreaterThanOrEqual(preset.all().length);
  for (const call of calls) {
    expect(call).not.toMatch(/\{\{[^}]+\}\}/);
  }
});
