import { expect, test } from 'vitest';
import type { AgentInfo, AgentsResponse } from '../types';
import { rendererState } from './agentReady';

// 渲染工具能不能用：首次引导会不会自动出现、首页与「开始制作」能不能点都看它（原 e2e/onboarding.spec.mjs 里的「without a renderer」两例）。

const agent = (id: string, label: string, installed: boolean, extra: Partial<AgentInfo> = {}): AgentInfo => ({ id, label, command: id, installed, renderer: true, ...extra });

function agents(list: AgentInfo[]): AgentsResponse {
  return { agents: list, orchestrator: 'claude', renderer: 'qoder', orchestrator_model: '', renderer_model: '', global_renderer: 'qoder' };
}

const thisComputer = agents([
  agent('claude', 'Claude Code', true),
  agent('codex', 'Codex', true),
  agent('qoder', 'Qoder', false),
  agent('opencode', 'OpenCode', true),
  agent('director', '制作人', false, { hint: '先在设置里配置一个模型服务' }),
]);

test('a renderer that is not installed is not ready and names the installed ones', () => {
  const state = rendererState(thisComputer, 'qoder');
  expect(state.ok).toBe(false);
  expect(state.info?.id).toBe('qoder');
  expect(state.installed.map((a) => a.id)).toEqual(['claude', 'codex', 'opencode']);
  expect(state.reason).toBe('画面要靠 Qoder 来画，这台电脑上没有它；换成已经装好的 Claude Code、Codex、OpenCode 就能开工');
});

test('an installed renderer is ready', () => {
  expect(rendererState(thisComputer, 'claude')).toMatchObject({ ok: true, reason: '' });
});

test('the director needs a model service before it can draw', () => {
  expect(rendererState(thisComputer, 'director').reason).toContain('制作人还没有可用的模型服务');
  const withService = agents(thisComputer.agents.map((a) => (a.id === 'director' ? { ...a, installed: true, hint: undefined } : a)));
  expect(rendererState(withService, 'director').ok).toBe(true);
});

test('with nothing installed it says so; before the list arrives it does not block', () => {
  const none = agents([agent('claude', 'Claude Code', false), agent('codex', 'Codex', false)]);
  expect(rendererState(none, 'claude').reason).toBe('画面要靠 Claude Code、Codex 这类工具来画，这台电脑上一个都还没装');
  expect(rendererState(null, 'qoder').ok).toBe(true);
  expect(rendererState(thisComputer, '').ok).toBe(true);
  // 不能当渲染工具的不算装好了的渲染工具。
  const orchestratorOnly = agents([agent('claude', 'Claude Code', true, { renderer: false }), agent('qoder', 'Qoder', false)]);
  expect(rendererState(orchestratorOnly, 'qoder').installed).toEqual([]);
});
