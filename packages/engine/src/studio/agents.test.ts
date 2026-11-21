import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as config from '../config';
import * as tools from '../tools';
import { agentOrder } from './agents';
import { eventsAfter, getSession, kindNotice, overrideAgents, updateMeta } from './sessions';
import { args, newSessionFixture, setEnv, studioRequest, waitIdle } from './testsupport';

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
    expect(path.basename(claude.path)).toBe(process.platform === 'win32' ? 'claude.cmd' : 'claude');
    expect(body.orchestrator).toBe('claude');
    expect(body.renderer).toBe('claude');
    expect(body.global_renderer, '没有全局设置时是默认的渲染工具').toBe(config.GlobalDefaults.RENDERER);
    expect(claude.install_url).toMatch(/^https:\/\//);
    for (const a of body.agents) expect(a.id === 'director' || /^https:\/\//.test(a.install_url), `${a.id} 没有安装入口`).toBe(true);
    for (const a of body.agents) expect(a.command, '命令名为空').not.toBe('');
    // 每家能调的选项随工具列表一起给，界面据此画控件。
    for (const a of body.agents) expect(a.option_specs.length, `${a.id} 没有选项`).toBeGreaterThan(0);
    expect(claude.option_specs.map((o: { key: string }) => o.key)).toEqual(['effort', 'repair_effort', 'simple_effort', 'fast']);
    expect(body.orchestrator_options).toBe('');
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

  it('session models reach the orchestrator and its children', async () => {
    const f = newSessionFixture();
    expect((await studioRequest(f.s, 'POST', '/api/sessions', '{"model":"bad model"}')).status, '模型名里不能有空白').toBe(400);
    let { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"model":"opus","renderer":"codex","renderer_model":"gpt-6.1-sol"}');
    const id = body.session_id as string;
    expect([body.model, body.renderer_model]).toEqual(['opus', 'gpt-6.1-sol']);
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"改一下"}');
    await waitIdle(f, id);
    expect(args(f).at(-1)).toContain('--model opus');
    expect(fs.readFileSync(f.argsLog + '.renderer_model', 'utf8').trim(), '编排工具调用的 scene_run 要用会话选的渲染模型').toBe('gpt-6.1-sol');

    // 同一家换模型：会话照样续接，发一条提示。
    const sess = getSession(f.s, f.root, id)!;
    updateMeta(sess, (meta) => (meta.cli_session_id = 'keep'));
    ({ body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/agents`, '{"model":"sonnet"}'));
    expect([body.model, body.cli_session_id]).toEqual(['sonnet', 'keep']);
    expect(eventsAfter(sess, 0).events.at(-1)?.text).toContain('sonnet');
    // 换了工具又没给模型：模型是给上一家选的，回到跟随设置。
    ({ body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/agents`, '{"tool":"codex","renderer":"claude"}'));
    expect([body.model, body.renderer_model]).toEqual([undefined, undefined]);
  });

  // 推理强度、快速模式这类选项与模型一样按会话选：交给编排工具、经子进程环境交给它调用的 scene_run。
  it('session options reach the orchestrator and its children', async () => {
    const f = newSessionFixture();
    expect((await studioRequest(f.s, 'POST', '/api/sessions', '{"options":"effort high"}')).status, '选项写法不对').toBe(400);
    expect((await studioRequest(f.s, 'POST', '/api/sessions', '{"tool":"claude","options":"effort=ultra"}')).status).toBe(400);
    let { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"options":"effort=high,fast=on","renderer":"qoder-intl","renderer_options":"context=200000"}');
    const id = body.session_id as string;
    expect([body.options, body.renderer_options]).toEqual(['effort=high,fast=on', 'context=200000']);
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"改一下"}');
    await waitIdle(f, id);
    const line = args(f).at(-1)!;
    expect(line).toContain('--effort high');
    expect(line).toContain('"fastMode":true');
    expect(fs.readFileSync(f.argsLog + '.renderer_options', 'utf8').trim()).toBe('context=200000');

    const sess = getSession(f.s, f.root, id)!;
    updateMeta(sess, (meta) => (meta.cli_session_id = 'keep'));
    expect((await studioRequest(f.s, 'POST', `/api/sessions/${id}/agents`, '{"options":"effort=ultra"}')).status).toBe(400);
    expect((await studioRequest(f.s, 'POST', `/api/sessions/${id}/agents`, '{"renderer":"claude","renderer_options":"fast=maybe"}')).status).toBe(400);
    ({ body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/agents`, '{"options":"effort=low"}'));
    expect([body.options, body.cli_session_id], '同一家换选项照样续接').toEqual(['effort=low', 'keep']);
    expect(eventsAfter(sess, 0).events.at(-1)?.text).toContain('effort=low');
    ({ body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/agents`, '{"tool":"codex","renderer":"claude"}'));
    expect([body.options, body.renderer_options], '换了工具回到跟随设置').toEqual([undefined, undefined]);
  });

  it('session options override the settings key by key, only for the same tool', () => {
    const cfg = config.newConfig({ orchestrator: 'claude', orchestratorOptions: 'effort=high,fast=on', renderer: 'claude', rendererOptions: 'effort=max' });
    expect(overrideAgents(cfg, { tool: '', renderer: '', options: 'fast=off' })).toMatchObject({ orchestratorOptions: 'effort=high,fast=off', rendererOptions: 'effort=max' });
    expect(overrideAgents(cfg, { tool: 'codex', renderer: 'claude', options: '' })).toMatchObject({ orchestratorOptions: '', rendererOptions: 'effort=max' });
    expect(overrideAgents(cfg, { tool: 'claude', renderer: 'codebuddy', rendererOptions: 'effort=minimal' })).toMatchObject({ rendererOptions: 'effort=minimal' });
  });

  it('a configured model only follows the tool it was chosen for', () => {
    const cfg = config.newConfig({ orchestrator: 'claude', orchestratorModel: 'opus', renderer: 'claude', rendererModel: 'sonnet' });
    expect(overrideAgents(cfg, { tool: '', renderer: '' })).toMatchObject({ orchestratorModel: 'opus', rendererModel: 'sonnet' });
    expect(overrideAgents(cfg, { tool: 'codex', renderer: 'claude', model: '' })).toMatchObject({ orchestrator: 'codex', orchestratorModel: '', rendererModel: 'sonnet' });
    expect(overrideAgents(cfg, { tool: 'claude', renderer: 'qoder', rendererModel: 'Qwen3.8-Max' })).toMatchObject({ orchestratorModel: 'opus', rendererModel: 'Qwen3.8-Max' });
  });

  it('agent models API lists what each tool offers', async () => {
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'GET', '/api/agents/claude/models');
    expect(status).toBe(200);
    expect(body.models.map((m: { id: string }) => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    // 带连字符的工具名（qoder-intl）也要认得。
    ({ status } = await studioRequest(f.s, 'GET', '/api/agents/qoder-intl/models'));
    expect(status).toBe(200);
    ({ status } = await studioRequest(f.s, 'GET', '/api/agents/nope/models'));
    expect(status).toBe(404);
    // 没装的工具：列表为空、附说明，界面仍能手填。
    setEnv('PATH', path.dirname(f.argsLog));
    ({ status, body } = await studioRequest(f.s, 'GET', '/api/agents/opencode/models?refresh=1'));
    expect(status).toBe(200);
    expect(body.models).toEqual([]);
    expect(body.error).toContain('opencode');
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
    // childEnvironment 把它写进子进程，onset scene run 读到的就是这个值。
    expect(config.childEnvironment(cfg, { PATH: '/bin' }, false, []).RENDERER).toBe('opencode');
    expect(() => overrideAgents(base, { tool: 'nope', renderer: '' }), '无效工具应报错').toThrow();
  });
});
