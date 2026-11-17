// @vitest-environment jsdom
/*
 * 设置页里「制作人」的模型服务与首页工具菜单（原 e2e/settings.spec.mjs 的 Producer 一例）。
 * 渲染整个 App（没有打开项目，落在首页），后端是一张按真实接口形状写的假表：
 * 存下的模型服务决定 /api/agents 里制作人能不能选（同 studio/agents.ts），全局设置的写入记在 POST 请求体里。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test } from 'vitest';
import { MachineSettings } from './Settings';
import { App } from '../app';
import { mockApi, type MockRequest } from '../testing';
import type { AgentInfo, AgentService, AgentServicePreset, AgentServicesResponse, AgentsResponse, SettingRow, SettingsResponse, SetupStatus } from '../types';

const presets: AgentServicePreset[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', vision: false, key_url: 'https://platform.deepseek.com/api_keys' },
  { id: 'anthropic', label: 'Anthropic（Claude）', protocol: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', vision: true, key_url: 'https://console.anthropic.com/settings/keys' },
];

const toolOptions = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'director', label: '制作人' },
];

/** 假后端：模型服务、全局设置与工具列表互相联动，和 studio/agentservices.ts、settings.ts、agents.ts 一样。 */
function backend() {
  const services: AgentService[] = [];
  let active = '';
  const global: Record<string, string> = {};
  const agentsResponse = (): AgentsResponse => {
    const ready = active !== '';
    const director: AgentInfo = { id: 'director', label: '制作人', command: 'onset studio agent', installed: ready, renderer: true, ...(ready ? {} : { hint: '先在设置里配置一个模型服务' }) };
    return {
      agents: [
        {
          id: 'claude', label: 'Claude Code', command: 'claude', installed: true, renderer: true, install_url: 'https://code.claude.com/docs/en/setup',
          option_specs: [
            { key: 'effort', label: '推理强度', hint: '', kind: 'choice', choices: [{ value: 'low', label: '低' }, { value: 'high', label: '高' }] },
            { key: 'fast', label: '快速模式', hint: '', kind: 'toggle' },
          ],
        },
        { id: 'codex', label: 'Codex', command: 'codex', installed: true, renderer: true, install_url: 'https://developers.openai.com/codex/cli' },
        director,
      ],
      orchestrator: global.ORCHESTRATOR || 'claude',
      renderer: global.RENDERER || 'claude',
      orchestrator_model: global.ORCHESTRATOR_MODEL ?? '',
      renderer_model: global.RENDERER_MODEL ?? '',
      global_renderer: global.RENDERER || 'claude',
    };
  };
  const row = (key: string, label: string, options: SettingRow['options'], def: string, modelOf?: string, optionsOf?: string): SettingRow => ({
    key, label, hint: '', options, default: def, global: global[key] ?? '', project: '', effective: global[key] || def, source: global[key] ? 'global' : 'default', ...(modelOf ? { model_of: modelOf } : {}), ...(optionsOf ? { options_of: optionsOf } : {}),
  });
  const settings = (): SettingsResponse => ({
    file: '/tmp/onset/settings.conf',
    has_project: false,
    machine: [],
    rows: [
      row('ORCHESTRATOR', '对话助手', toolOptions, 'claude'),
      row('ORCHESTRATOR_MODEL', '对话助手的模型', [], '', 'ORCHESTRATOR'),
      row('ORCHESTRATOR_OPTIONS', '对话助手的选项', [], '', undefined, 'ORCHESTRATOR'),
      row('RENDERER', '画镜头的工具', toolOptions, 'claude'),
      row('RENDERER_MODEL', '画镜头的模型', [], '', 'RENDERER'),
    ],
  });
  const servicesResponse = (): AgentServicesResponse => ({ presets, services: [...services], active, storage: { encrypted: true } });
  const setup: SetupStatus = { ready: true, items: [], command: '' };
  const api = mockApi({
    '/api/projects': { projects: [], current_project_id: '', summaries: {}, default_parent: '' },
    '/api/agents': () => agentsResponse(),
    '/api/setup': setup,
    '/api/styles': { canvases: [], modes: [] },
    '/api/settings': () => settings(),
    'POST /api/settings/global': (req: MockRequest) => {
      const { key, value } = req.body as { key: string; value: string };
      global[key] = value;
      return { ok: true };
    },
    '/api/agent-services': () => servicesResponse(),
    'POST /api/agent-services': (req: MockRequest) => {
      const body = req.body as Omit<AgentService, 'has_key'> & { key?: string };
      const service: AgentService = { id: `svc-${services.length + 1}`, name: body.name, preset: body.preset, protocol: body.protocol, base_url: body.base_url.replace(/\/+$/, ''), model: body.model, vision: body.vision, has_key: !!body.key };
      services.push(service);
      if (!active) active = service.id;
      return servicesResponse();
    },
    'DELETE /api/agent-services/svc-1': () => {
      services.splice(0, 1);
      active = services[0]?.id ?? '';
      return servicesResponse();
    },
    '/api/agent-services/vision': () => ({ model: '', service: services[0]?.name ?? '', vision: services[0] ? services[0].vision : null }),
    // 制作人的模型由在用的那套服务自己报（studio/agents.ts 问服务的 /models）。
    '/api/agents/director/models': () => ({ tool: 'director', models: [{ id: 'custom-render-model', label: 'custom-render-model' }, { id: 'custom-other-model', label: 'custom-other-model' }] }),
    '/api/agents/claude/models': { tool: 'claude', models: [{ id: 'sonnet', label: 'sonnet' }] },
    '/api/stations': { stations: [], problems: [] },
  });
  return { api, global };
}

beforeEach(() => {
  localStorage.clear();
  // 已经走过引导：没有项目时也不自动弹出。
  localStorage.setItem('onset.onboarding.done', '1');
});

test('selects the Producer, lists models from the custom service, and keeps the home tool menu in step', async () => {
  const user = userEvent.setup();
  const { api, global } = backend();
  render(<App />);

  // 还没有模型服务：首页的工具菜单里制作人不能选。
  const homeTool = await screen.findByRole('button', { name: /Claude Code/ });
  expect(homeTool.id).toBe('home-tool');
  await user.click(homeTool);
  expect((screen.getByRole('menuitemradio', { name: /^制作人/ }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(homeTool);

  await user.click(screen.getByRole('button', { name: '设置' }));
  const dialog = await screen.findByRole('dialog', { name: '设置' });
  const form = await within(dialog).findByRole('form', { name: '添加模型服务' });
  await user.click(form.querySelector('[data-preset=""]')!);
  await user.type(within(form).getByLabelText('名称'), '自定义渲染服务');
  await user.type(within(form).getByLabelText('Base URL'), 'http://127.0.0.1:9/v1');
  await user.type(within(form).getByLabelText('API key'), 'sk-refresh-test');
  await user.type(within(form).getByRole('combobox', { name: '模型' }), 'custom-render-model');
  await user.click(within(form).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(dialog.querySelector('.agent-service-list li')?.textContent).toContain('自定义渲染服务'));
  // 存下的是表单里填的那套，key 只随这一次请求交给后端。
  expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/agent-services')?.body).toMatchObject({
    name: '自定义渲染服务', protocol: 'openai', base_url: 'http://127.0.0.1:9/v1', model: 'custom-render-model', key: 'sk-refresh-test',
  });

  // 存下服务后首页菜单立刻能选制作人，不用重开。
  await user.click(within(dialog).getByRole('button', { name: '关闭' }));
  await user.click(homeTool);
  await waitFor(() => expect((screen.getByRole('menuitemradio', { name: /^制作人/ }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('menuitemradio', { name: /^制作人/ }));
  expect(homeTool.textContent).toContain('制作人');

  await user.click(screen.getByRole('button', { name: '设置' }));
  const reopened = await screen.findByRole('dialog', { name: '设置' });
  const renderer = (await within(reopened).findByLabelText('全局画镜头的工具')) as HTMLSelectElement;
  expect(renderer.querySelector('option[value="director"]')?.textContent).toBe('制作人');
  await user.selectOptions(renderer, 'director');
  await waitFor(() => expect(global.RENDERER).toBe('director'));
  // 画镜头的模型换成从自定义服务读到的那几个。
  await waitFor(() => expect(within(reopened).getByLabelText('全局画镜头的模型').querySelector('option[value="custom-other-model"]')).not.toBeNull());
  await user.selectOptions(within(reopened).getByLabelText('全局画镜头的模型'), 'custom-other-model');
  await waitFor(() => expect(global.RENDERER_MODEL).toBe('custom-other-model'));
  expect(api.calls.filter((c) => c.path === '/api/settings/global').map((c) => c.body)).toEqual([
    { key: 'RENDERER', value: 'director' },
    { key: 'RENDERER_MODEL', value: 'custom-other-model' },
  ]);

  // 删掉服务：首页菜单里的制作人跟着变回不能选。
  const section = reopened.querySelector('section.agent-services') as HTMLElement;
  await user.click(within(section).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(section.querySelectorAll('.agent-service-list li')).toHaveLength(0));
  await user.click(within(reopened).getByRole('button', { name: '关闭' }));
  await user.click(homeTool);
  await waitFor(() => expect((screen.getByRole('menuitemradio', { name: /^制作人/ }) as HTMLButtonElement).disabled).toBe(true));
  expect(homeTool.textContent).not.toContain('制作人');
});

// 调用选项跟着工具走：claude 有推理强度与快速模式，选了就写成一行 effort=high,fast=on 存进全局设置。
test('sets the orchestrator options for the chosen tool', async () => {
  const { global } = backend();
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: '设置' }));
  const dialog = await screen.findByRole('dialog', { name: '设置' });
  const level = (await within(dialog).findByLabelText('全局推理强度')) as HTMLSelectElement;
  expect(level.options[0]!.textContent).toBe('推理强度：默认');
  await user.selectOptions(level, 'high');
  await waitFor(() => expect(global.ORCHESTRATOR_OPTIONS).toBe('effort=high'));
  await user.selectOptions(await within(dialog).findByLabelText('全局快速模式'), 'on');
  await waitFor(() => expect(global.ORCHESTRATOR_OPTIONS).toBe('effort=high,fast=on'));
  // 换成没有可调选项的工具（这张假表里的 codex 没给 option_specs）时照实说。
  await user.selectOptions(within(dialog).getByLabelText('全局对话助手'), 'codex');
  await waitFor(() => expect((within(dialog).getByLabelText('全局对话助手的选项') as HTMLSelectElement).textContent).toContain('没有可调的选项'));
});


test('preserves a newer machine-setting draft while an earlier save finishes', async () => {
  let finish!: (value: unknown) => void;
  mockApi({ 'POST /api/settings/global': () => new Promise(resolve => { finish = resolve; }) });
  render(<MachineSettings rows={[{ key: 'NETWORK_PROXY', label: '代理', hint: '', placeholder: '', value: '', overridden: false }]} onSaved={() => {}} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'https://first.example' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.change(input, { target: { value: 'https://second.example' } });
  await act(async () => finish({ ok: true }));
  expect((input as HTMLInputElement).value).toBe('https://second.example');
});
