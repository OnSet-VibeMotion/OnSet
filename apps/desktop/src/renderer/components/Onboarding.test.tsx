// @vitest-environment jsdom
/*
 * 首次引导里「谁来画镜头」（原 e2e/onboarding.spec.mjs「picking the director still needs a renderer installed…」）。
 * 这台（假）电脑上能画镜头的只有 Claude Code、Codex、OpenCode，而全局设置里的渲染工具是 Qoder。
 * 缺渲染工具时引导会自动弹出（app 按 rendererState 判断，取值的各种情况在 agentReady.test.ts）。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test } from 'vitest';
import { App } from '../app';
import { mockApi, type MockRequest } from '../testing';
import type { AgentInfo, AgentService, AgentServicePreset, AgentServicesResponse, AgentsResponse, SettingRow, SettingsResponse } from '../types';
import { Onboarding } from './Onboarding';
import type { SetupHandle } from './SetupGuide';

const presets: AgentServicePreset[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', vision: false, key_url: 'https://platform.deepseek.com/api_keys' },
  { id: 'kimi', label: 'Kimi（月之暗面）', protocol: 'openai', base_url: 'https://api.moonshot.cn/v1', model: 'kimi-k3', vision: true, key_url: 'https://platform.moonshot.cn/console/api-keys' },
];

const tools: [string, string, boolean][] = [
  ['claude', 'Claude Code', true],
  ['codex', 'Codex', true],
  ['qoder', 'Qoder', false],
  ['codebuddy', 'CodeBuddy', false],
  ['opencode', 'OpenCode', true],
];

function backend() {
  const global: Record<string, string> = { RENDERER: 'qoder' };
  const services: AgentService[] = [];
  const agents = (): AgentsResponse => {
    const list: AgentInfo[] = tools.map(([id, label, installed]) => ({ id, label, command: id, installed, renderer: true, install_url: `https://example.com/${id}` }));
    const ready = services.length > 0;
    list.push({ id: 'director', label: '制作人', command: 'onset studio agent', installed: ready, renderer: true, ...(ready ? {} : { hint: '先在设置里配置一个模型服务' }) });
    return { agents: list, orchestrator: global.ORCHESTRATOR || 'claude', renderer: global.RENDERER, orchestrator_model: '', renderer_model: '', global_renderer: global.RENDERER };
  };
  const options = [...tools.map(([value, label]) => ({ value, label })), { value: 'director', label: '制作人' }];
  const row = (key: string, opts: SettingRow['options'], def: string): SettingRow => ({
    key, label: key, hint: '', options: opts, default: def, global: global[key] ?? '', project: '', effective: global[key] || def, source: global[key] ? 'global' : 'default',
  });
  const settings = (): SettingsResponse => ({
    file: '/tmp/onset/settings.conf',
    has_project: false,
    machine: [],
    rows: [row('ORCHESTRATOR', options, 'claude'), row('ORCHESTRATOR_MODEL', [], ''), row('RENDERER', options, 'claude'), row('TTS_PROVIDER', [{ value: 'edge', label: '微软 Edge' }], 'edge')],
  });
  const servicesResponse = (): AgentServicesResponse => ({ presets, services: [...services], active: services[0]?.id ?? '', storage: { encrypted: true } });
  const api = mockApi({
    '/api/agents': () => agents(),
    '/api/settings': () => settings(),
    'POST /api/settings/global': (req: MockRequest) => {
      const { key, value } = req.body as { key: string; value: string };
      global[key] = value;
      return { ok: true };
    },
    '/api/agent-services': () => servicesResponse(),
    'POST /api/agent-services': (req: MockRequest) => {
      const body = req.body as AgentService & { key?: string };
      services.push({ ...body, id: 'svc-1', has_key: !!body.key });
      return servicesResponse();
    },
    '/api/agent-services/vision': () => ({ model: services[0]?.model ?? '', service: services[0]?.name ?? '', vision: services[0] ? services[0].vision : null }),
  });
  return { api, global };
}

/** 工具都装好了：第一步「摄制组就位」已完成。 */
const setup: SetupHandle = {
  status: { ready: true, items: [], command: '' },
  checking: false,
  recheck: async () => {},
  start: async () => {},
  cancel: async () => {},
  startError: '',
  proxy: '',
  setProxy: () => {},
};

beforeEach(() => localStorage.clear());

test('a missing renderer opens the guide by itself, at the second step', async () => {
  const { api } = backend();
  api.set('/api/projects', { projects: [], current_project_id: '', summaries: {}, default_parent: '' });
  api.set('/api/setup', setup.status);
  api.set('/api/styles', { canvases: [], modes: [] });
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelector('#onboarding .ob-main h2')?.textContent).toBe('请 AI 来编排'));
  expect(container.querySelector('.home')).toBeNull();
});

test('picking the director still needs a renderer installed on this computer', async () => {
  const user = userEvent.setup();
  const { api, global } = backend();
  const { container } = render(<Onboarding setup={setup} projectCount={0} onClose={() => {}} />);
  const step = (id: string) => container.querySelector(`[data-step="${id}"]`) as HTMLElement;

  // 缺渲染工具也算没准备好：停在第二步。
  await waitFor(() => expect(container.querySelector('.ob-main h2')?.textContent).toBe('请 AI 来编排'));

  // 选制作人、配一套只读得了文字的服务（DeepSeek 预设不勾「能看图片」）：制作人能用了，但这一步仍没做完。
  await user.click(container.querySelector('[data-agent="director"]')!);
  await waitFor(() => expect(global.ORCHESTRATOR).toBe('director'));
  const form = await screen.findByRole('form', { name: '添加模型服务' });
  await user.click(form.querySelector('[data-preset="deepseek"]')!);
  expect((within(form).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  await user.type(within(form).getByLabelText('API key'), 'sk-guide');
  await user.click(within(form).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(container.querySelector('.agent-service-list li')?.textContent).toContain('看不了画面'));
  await waitFor(() => expect(container.querySelector('[data-agent="director"]')?.textContent).toContain('在用'));
  await waitFor(() => expect(container.querySelector('#director-vision-note')?.textContent).toContain('看不了画面'));

  const seat = container.querySelector('#ob-renderer') as HTMLElement;
  expect(within(seat).getByRole('alert').textContent).toContain('Qoder');
  expect(seat.querySelector('[data-renderer="qoder"]')).toBeNull();
  // 能选的只有装好了的几家。
  expect([...seat.querySelectorAll('[data-renderer]')].map((el) => el.getAttribute('data-renderer'))).toEqual(['claude', 'codex', 'opencode', 'director']);
  expect(step('ai').classList.contains('done')).toBe(false);
  await user.click(step('shoot'));
  expect((screen.getByRole('button', { name: '去开拍' }) as HTMLButtonElement).disabled).toBe(true);

  // 从已经装好的里挑一家：写进全局设置，这一步就做完了。
  await user.click(step('ai'));
  await user.click(container.querySelector('#ob-renderer [data-renderer="claude"]')!);
  await waitFor(() => expect(global.RENDERER).toBe('claude'));
  await waitFor(() => expect(step('ai').classList.contains('done')).toBe(true));
  expect(within(container.querySelector('#ob-renderer') as HTMLElement).queryByRole('alert')).toBeNull();
  expect(api.calls.filter((c) => c.path === '/api/settings/global').map((c) => c.body)).toEqual([
    { key: 'ORCHESTRATOR', value: 'director' },
    { key: 'RENDERER', value: 'claude' },
  ]);
});
