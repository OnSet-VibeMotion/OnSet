// @vitest-environment jsdom
/// <reference types="node" />
/*
 * 模型服务表单里的模型目录（原 e2e/settings.spec.mjs「a large custom model catalogue…」）：
 * 「读取模型列表」问后端，上百个模型放进页面内的列表，能点选、筛选、键盘选，也能手填目录外的名字。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { mockApi } from '../testing';
import type { AgentServicesResponse } from '../types';
import { DirectorServices } from './DirectorServices';

const services: AgentServicesResponse = {
  presets: [{ id: 'deepseek', label: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', vision: false, key_url: 'https://platform.deepseek.com/api_keys' }],
  services: [],
  active: '',
  storage: { encrypted: true },
};

test('a large custom model catalogue can be picked, filtered or selected by keyboard', async () => {
  const user = userEvent.setup();
  const models = Array.from({ length: 97 }, (_, i) => `provider/model-${String(i).padStart(3, '0')}`);
  const api = mockApi({
    '/api/agent-services': services,
    'POST /api/agent-services/models': { models },
  });
  render(<DirectorServices version={0} />);
  const form = await screen.findByRole('form', { name: '添加模型服务' });
  await user.click(form.querySelector('[data-preset=""]')!);
  await user.type(within(form).getByLabelText('Base URL'), 'http://127.0.0.1:9/v1');
  await user.click(within(form).getByRole('button', { name: '读取模型列表' }));
  // 问的是表单里这套服务（还没存，key 为空时后端用 id 那套存下的）。
  expect(api.calls.find((c) => c.path === '/api/agent-services/models')?.body).toEqual({ id: '', protocol: 'openai', base_url: 'http://127.0.0.1:9/v1', key: '' });

  const list = await within(form).findByRole('listbox', { name: '可选模型' });
  expect(within(list).getAllByRole('option')).toHaveLength(97);
  expect(form.textContent).toContain('读到 97 个模型');
  const input = within(form).getByRole('combobox', { name: '模型' }) as HTMLInputElement;

  // 列表限高、可滚动：jsdom 不排版，只核对样式表里的规则（原 e2e 量的是 clientHeight ≤ 240 与滚轮滚动）。
  // vitest 不处理样式表（?raw 拿到空串），直接读文件。
  const css = readFileSync(join(import.meta.dirname, '../service-model-picker.css'), 'utf8');
  const rule = /\.service-model-options\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(rule).toMatch(/max-height:\s*min\(240px/);
  expect(rule).toMatch(/overflow-y:\s*scroll/);

  // 点最后一个：填进输入框，列表收起。
  await user.click(within(list).getByRole('option', { name: models[96] }));
  expect(input.value).toBe(models[96]);
  expect(within(form).queryByRole('listbox')).toBeNull();

  // 再展开，按名字筛到一个，用方向键与回车选它。
  await user.click(within(form).getByRole('button', { name: '展开模型列表' }));
  expect(within(within(form).getByRole('listbox')).getAllByRole('option')).toHaveLength(97);
  await user.clear(input);
  await user.type(input, 'model-096');
  await waitFor(() => expect(within(within(form).getByRole('listbox')).getAllByRole('option')).toHaveLength(1));
  await user.keyboard('{ArrowDown}{Enter}');
  expect(input.value).toBe(models[96]);
  expect(within(form).queryByRole('listbox')).toBeNull();

  // 目录外的名字照样能用：没有匹配时说明一句，Esc 只收起列表、不清掉输入。
  await user.clear(input);
  await user.type(input, 'my-private-model');
  expect(within(form).getByText('没有匹配的模型，可以直接使用输入的名称')).toBeTruthy();
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  let reachedWindow = false;
  const onWindow = () => (reachedWindow = true);
  window.addEventListener('keydown', onWindow);
  input.dispatchEvent(escape);
  window.removeEventListener('keydown', onWindow);
  // 不冒到外层：设置弹窗与画面面板不会跟着这一下 Esc 关掉。
  expect(reachedWindow).toBe(false);
  await waitFor(() => expect(within(form).queryByRole('listbox')).toBeNull());
  expect(input.value).toBe('my-private-model');
  expect(within(form).getByRole('button', { name: '展开模型列表' })).toBeTruthy();
});
