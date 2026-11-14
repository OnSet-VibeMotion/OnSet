import './testsupport';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as config from '../config';
import * as director from '../director';
import { viewPage } from '../studioview';
import { newSessionFixture, setEnv, studioRequest } from './testsupport';
import { noVisionNote, orchestratorCannotSee } from './vision';

function agentDir(...services: { vision: boolean; active?: boolean }[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-vision-test-'));
  services.forEach((s, i) => {
    const id = director.saveService(dir, { name: 's' + i, protocol: 'openai', base_url: 'https://example.com/v1', model: 'm' + i, vision: s.vision, key: 'sk-test' });
    if (s.active) director.setActiveService(dir, id);
  });
  setEnv('ONSET_AGENT_DIR', dir);
  return dir;
}

describe('director vision', () => {
  it('flags a director turn whose service cannot read images', () => {
    agentDir({ vision: false });
    const cfg = (orchestrator: string, orchestratorModel = '') => config.newConfig({ orchestrator, orchestratorModel });
    expect(orchestratorCannotSee(cfg('director'))).toBe(true);
    // 能不能看图按服务上写的那一项，临时换模型名不改变它。
    expect(orchestratorCannotSee(cfg('director', 'other'))).toBe(true);
    // 不是导演：别家工具自己的事。
    expect(orchestratorCannotSee(cfg('claude'))).toBe(false);
    // 换成一套能看图的在用。
    agentDir({ vision: false }, { vision: true, active: true });
    expect(orchestratorCannotSee(cfg('director'))).toBe(false);
    // 没有服务：不提示（导演根本开不了工）。
    agentDir();
    expect(orchestratorCannotSee(cfg('director'))).toBe(false);
  });

  it('agent services say what the director will use and whether it can see', async () => {
    agentDir({ vision: false });
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'GET', '/api/agent-services');
    expect(status).toBe(200);
    expect((body.services as { vision: boolean; has_key: boolean }[]).map((s) => [s.vision, s.has_key])).toEqual([[false, true]]);
    expect(JSON.stringify(body)).not.toContain('sk-test');
    const presets = Object.fromEntries((body.presets as { id: string; vision: boolean }[]).map((p) => [p.id, p.vision]));
    expect(presets).toMatchObject({ deepseek: false, kimi: true, anthropic: true });

    ({ status, body } = await studioRequest(f.s, 'GET', '/api/agent-services/vision'));
    expect(status).toBe(200);
    expect(body).toEqual({ model: 'm0', service: 's0', vision: false });
    ({ body } = await studioRequest(f.s, 'GET', '/api/agent-services/vision?model=x'));
    expect(body).toEqual({ model: 'x', service: 's0', vision: false });
    agentDir();
    ({ body } = await studioRequest(f.s, 'GET', '/api/agent-services/vision'));
    expect(body).toEqual({ model: '', service: '', vision: null });
    expect((await studioRequest(f.s, 'POST', '/api/agent-services/vision', '{}')).status).toBe(405);
  });

  it('creates, edits, activates and deletes services over the API', async () => {
    agentDir();
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'POST', '/api/agent-services', JSON.stringify({ preset: 'deepseek', protocol: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', vision: false, key: 'sk-a' }));
    expect(status).toBe(200);
    const first = (body.services as { id: string; name: string }[])[0]!;
    expect(first.name).toBe('DeepSeek');
    expect(body.active).toBe(first.id);
    ({ body } = await studioRequest(f.s, 'POST', '/api/agent-services', JSON.stringify({ name: '中转', protocol: 'anthropic', base_url: 'https://relay.example.com', model: 'claude-x', vision: true, key: 'sk-b' })));
    const second = (body.services as { id: string }[])[1]!;
    ({ status, body } = await studioRequest(f.s, 'POST', `/api/agent-services/${second.id}/activate`));
    expect(status).toBe(200);
    expect(body.active).toBe(second.id);
    ({ status } = await studioRequest(f.s, 'POST', '/api/agent-services', JSON.stringify({ protocol: 'openai', base_url: 'nope', model: 'm' })));
    expect(status).toBe(400);
    ({ status, body } = await studioRequest(f.s, 'DELETE', `/api/agent-services/${second.id}`));
    expect(status).toBe(200);
    expect(body.active).toBe(first.id);
    expect((await studioRequest(f.s, 'DELETE', '/api/agent-services/s-nope')).status).toBe(404);
  });

  it('writes the turn note like the production prompt', () => {
    // 与 project/boundary.test.ts、flowprompts.test.ts 同样的约束：不点名执行者身份、不教 onset 命令，工具写成调用。
    expect(noVisionNote.toLowerCase()).not.toContain('agent');
    expect(noVisionNote).not.toMatch(/\bAI\b|Codex|主控|导演|模型|\.\/onset|`onset /);
    expect(noVisionNote).toContain('我看不了图，请你看这几张');
    const calls = [...noVisionNote.matchAll(/studio_show\((\{.*?\})\)/g)].map((m) => JSON.parse(m[1]!) as { page: string });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(viewPage(call.page), call.page).toBeTruthy();
  });
});
