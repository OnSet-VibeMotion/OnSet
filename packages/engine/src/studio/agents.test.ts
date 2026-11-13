// 移植自 internal/studio/agents_test.go。
import './testsupport';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as config from '../config';
import * as tools from '../tools';
import { agentOrder } from './agents';
import { eventsAfter, getSession, kindNotice, overrideAgents, updateMeta } from './sessions';
import { newSessionFixture, setEnv, studioRequest, waitIdle } from './testsupport';

describe('agents', () => {
  it('agentOrder covers valid tools', () => {
    const seen = new Set<string>();
    for (const a of agentOrder) {
      expect(tools.ValidTools.has(a.id) && !seen.has(a.id), `agentOrder 里的 ${a.id} 无效或重复`).toBe(true);
      seen.add(a.id);
    }
    expect(seen.size, 'agentOrder 漏了工具').toBe(tools.ValidTools.size);
  });

  it('agents API reports installed tools and defaults', async () => {
    const f = newSessionFixture();
    const { status, body } = await studioRequest(f.s, 'GET', '/api/agents');
    expect(status).toBe(200);
    expect(body.agents).toHaveLength(agentOrder.length);
    const claude = body.agents[0];
    expect(claude.id).toBe('claude');
    expect(claude.command).toBe('claude');
    expect(claude.installed).toBe(true);
    expect(claude.path.endsWith('/claude')).toBe(true);
    expect(body.orchestrator).toBe('claude');
    expect(body.renderer).toBe('claude');
    for (const a of body.agents) expect(a.command, '命令名为空').not.toBe('');
    expect((await studioRequest(f.s, 'POST', '/api/agents', '{}')).status).toBe(405);
  });

  it('session agent choice reaches child and can switch', async () => {
    const f = newSessionFixture();
    for (const payload of ['{"tool":"nope"}', '{"renderer":"nope"}']) {
      expect((await studioRequest(f.s, 'POST', '/api/sessions', payload)).status, payload).toBe(400);
    }
    let { status, body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"renderer":"codex"}');
    expect(status).toBe(201);
    const id = body.session_id as string;
    expect(body.tool, '没选的一项应沿用项目配置').toBe('claude');
    expect(body.renderer).toBe('codex');

    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"改一下"}'));
    expect(status).toBe(202);
    await waitIdle(f, id);
    expect(fs.readFileSync(f.argsLog + '.renderer', 'utf8').trim(), '编排工具的子进程应拿到会话选的渲染工具').toBe('codex');

    expect((await studioRequest(f.s, 'POST', `/api/sessions/${id}/agents`, '{"tool":"nope"}')).status).toBe(400);
    expect((await studioRequest(f.s, 'GET', `/api/sessions/${id}/agents`)).status).toBe(405);
    ({ status, body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/agents`, '{"tool":"codex","renderer":"claude"}'));
    expect(status).toBe(200);
    expect(body.tool).toBe('codex');
    expect(body.renderer).toBe('claude');
    expect(body.cli_session_id, '换工具后应清掉会话 id').toBeUndefined();
    const sess = getSession(f.s, f.root, id)!;
    const { events } = eventsAfter(sess, 0);
    const last = events[events.length - 1];
    expect(last.kind, '换工具应在会话里留一条提示').toBe(kindNotice);
    expect(last.text).toContain('codex');

    // 只换渲染工具不动会话 id，也不发提示。
    updateMeta(sess, (meta) => (meta.cli_session_id = 'keep'));
    ({ body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/agents`, '{"renderer":"qoder"}'));
    expect(body.tool).toBe('codex');
    expect(body.renderer).toBe('qoder');
    expect(body.cli_session_id).toBe('keep');
  });

  it('session agents cannot change mid-turn', async () => {
    const f = newSessionFixture();
    setEnv('FAKE_SLEEP', '5');
    let { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    const id = body.session_id as string;
    let status: number;
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"慢一点"}'));
    expect(status).toBe(202);
    ({ status, body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/agents`, '{"tool":"codex"}'));
    expect(status).toBe(409);
    expect(body.code).toBe('turn_running');
    expect((await studioRequest(f.s, 'POST', `/api/sessions/${id}/cancel`)).status).toBe(200);
    await waitIdle(f, id);
  });

  it('production start and renders accept agent choice', async () => {
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'POST', '/api/production/start', '{"tool":"nope"}');
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_agent');
    ({ status, body } = await studioRequest(f.s, 'POST', '/api/production/start', '{"renderer":"opencode"}'));
    expect(status).toBe(202);
    const detail = await waitIdle(f, body.session_id);
    expect(detail.session.tool).toBe('claude');
    expect(detail.session.renderer).toBe('opencode');

    for (const p of ['/api/scenes/scene-001/render', '/api/render/all']) {
      ({ status, body } = await studioRequest(f.s, 'POST', p, '{"renderer":"nope"}'));
      expect(status, p).toBe(400);
      expect(body.code, p).toBe('invalid_agent');
    }
  });

  it('overrideAgents keeps config for empty choice', () => {
    const base = config.newConfig({ orchestrator: 'claude', renderer: 'claude' });
    const cfg = overrideAgents(base, { tool: '', renderer: 'opencode' });
    expect(cfg.orchestrator).toBe('claude');
    expect(cfg.renderer).toBe('opencode');
    // childEnvironment 把它写进子进程，am scene run 读到的就是这个值。
    expect(config.childEnvironment(cfg, { PATH: '/bin' }, false, []).RENDERER).toBe('opencode');
    expect(() => overrideAgents(base, { tool: 'nope', renderer: '' }), '无效工具应报错').toThrow();
  });
});
