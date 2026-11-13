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

function agentDir(...providers: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-vision-test-'));
  for (const p of providers) director.setProviderKey(dir, p, 'sk-test');
  setEnv('AM_AGENT_DIR', dir);
  return dir;
}

describe('director vision', () => {
  it('flags a director turn whose model cannot read images', () => {
    agentDir('deepseek');
    const cfg = (orchestrator: string, orchestratorModel = '') => config.newConfig({ orchestrator, orchestratorModel });
    // 只填了 DeepSeek：没选模型时用它的推荐模型，看不了图。
    expect(orchestratorCannotSee(cfg('director'))).toBe(true);
    expect(orchestratorCannotSee(cfg('director', 'deepseek/deepseek-flash'))).toBe(false);
    // 目录里查不到的模型按不知道，不提示。
    expect(orchestratorCannotSee(cfg('director', 'deepseek/deepseek-v9'))).toBe(false);
    // 不是导演：别家工具自己的事。
    expect(orchestratorCannotSee(cfg('claude', 'deepseek/deepseek-v4-pro'))).toBe(false);
    // 又填了一家能读图的：没选模型时挑它。
    agentDir('deepseek', 'moonshotai-cn');
    expect(orchestratorCannotSee(cfg('director'))).toBe(false);
  });

  it('agent keys say which providers can read images and what the director will use', async () => {
    agentDir('zai-coding-cn');
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'GET', '/api/agent-keys');
    expect(status).toBe(200);
    const vision = Object.fromEntries((body.providers as { id: string; vision: boolean }[]).map((p) => [p.id, p.vision]));
    expect(vision).toMatchObject({ deepseek: false, 'zai-coding-cn': false, 'moonshotai-cn': true, anthropic: true });

    ({ status, body } = await studioRequest(f.s, 'GET', '/api/agent-keys/vision'));
    expect(status).toBe(200);
    expect(body).toEqual({ model: 'zai-coding-cn/glm-5.3', vision: false });
    ({ body } = await studioRequest(f.s, 'GET', '/api/agent-keys/vision?model=' + encodeURIComponent('anthropic/claude-sonnet-5-5')));
    expect(body).toEqual({ model: 'anthropic/claude-sonnet-5-5', vision: null });
    agentDir();
    ({ body } = await studioRequest(f.s, 'GET', '/api/agent-keys/vision'));
    expect(body).toEqual({ model: '', vision: null });
    expect((await studioRequest(f.s, 'POST', '/api/agent-keys/vision', '{}')).status).toBe(405);
  });

  it('writes the turn note like the production prompt', () => {
    // 与 project/boundary.test.ts、flowprompts.test.ts 同样的约束：不点名执行者身份、不教 am 命令，工具写成调用。
    expect(noVisionNote.toLowerCase()).not.toContain('agent');
    expect(noVisionNote).not.toMatch(/\bAI\b|Codex|主控|导演|模型|\.\/am|`am /);
    expect(noVisionNote).toContain('我看不了图，请你看这几张');
    const calls = [...noVisionNote.matchAll(/studio_show\((\{.*?\})\)/g)].map((m) => JSON.parse(m[1]!) as { page: string });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(viewPage(call.page), call.page).toBeTruthy();
  });
});
