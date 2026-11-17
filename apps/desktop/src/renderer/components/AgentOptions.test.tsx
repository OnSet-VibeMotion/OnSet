// @vitest-environment jsdom
/*
 * 各家工具的调用选项（推理强度、快速模式、上下文长度）：输入框底部的工具选择与设置页共用的下拉框。
 * 可调的项来自后端（/api/agents 的 option_specs），codex 的推理档位按所选模型收窄（/api/agents/codex/models 的 efforts）。
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { formatOptions, labelOf, optionChoices, parseOptions, withOption } from '../agentOptions';
import { mockApi } from '../testing';
import type { AgentChoice, AgentOptionSpec, AgentsResponse } from '../types';
import { AgentOptionsSelect } from './AgentOptionsSelect';
import { AgentPicker } from './AgentPicker';
import { ModelPicker } from './ModelPicker';
import { loadModels } from './ModelSelect';

const effort = (values: string[], extra: Partial<AgentOptionSpec> = {}): AgentOptionSpec => ({
  key: 'effort',
  label: '推理强度',
  hint: '',
  kind: 'choice',
  choices: values.map((value) => ({ value, label: { low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极限（自动分派子任务）' }[value] ?? value })),
  ...extra,
});
const fast: AgentOptionSpec = { key: 'fast', label: '快速模式', hint: '', kind: 'toggle' };
const context: AgentOptionSpec = { key: 'context', label: '上下文长度', hint: '', kind: 'number', presets: [{ value: '200000', label: '200K' }, { value: '1000000', label: '1M' }] };

test('reads and writes the options line like the backend', () => {
  expect(parseOptions('fast=on,effort=high')).toEqual({ fast: 'on', effort: 'high' });
  expect(formatOptions({ fast: 'on', effort: 'high' })).toBe('effort=high,fast=on');
  expect(withOption('effort=high,fast=on', 'fast', '')).toBe('effort=high');
  expect(withOption('', 'context', '200000')).toBe('context=200000');
  expect(labelOf(context, '128000')).toBe('128K');
  expect(labelOf(context, '2000000')).toBe('2M');
  // codex 的档位按模型收窄，模型报了表里没有的新档位也列上；当前值不在里面时照样列出来。
  const spec = effort(['low', 'medium', 'high'], { perModel: true });
  expect(optionChoices(spec, { id: 'm', label: 'm', efforts: ['medium', 'ultra'] }, '').map((c) => c.value)).toEqual(['medium', 'ultra']);
  expect(optionChoices(spec, { id: 'm', label: 'm', efforts: ['medium'] }, 'low').map((c) => c.value)).toEqual(['medium', 'low']);
});

function Harness({ specs, tool, model = '', inherited = '' }: { specs: AgentOptionSpec[]; tool: string; model?: string; inherited?: string }) {
  const [value, setValue] = useState('');
  return (
    <>
      <AgentOptionsSelect tool={tool} specs={specs} value={value} inherited={inherited} model={model} ariaPrefix="编排" compact onChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  );
}

test('draws each option and writes one line', async () => {
  mockApi({ '/api/agents/claude/models': { tool: 'claude', models: [] } });
  const user = userEvent.setup();
  render(<Harness tool="claude" specs={[effort(['low', 'high', 'max']), fast]} inherited="effort=high" />);
  const level = screen.getByLabelText('编排推理强度') as HTMLSelectElement;
  // 跟着设置里的值时写明是什么。
  expect(level.options[0]!.textContent).toBe('推理·跟随设置（高）');
  await user.selectOptions(level, 'max');
  await user.selectOptions(screen.getByLabelText('编排快速模式'), 'on');
  expect(screen.getByTestId('value').textContent).toBe('effort=max,fast=on');
  await user.selectOptions(level, '');
  expect(screen.getByTestId('value').textContent).toBe('fast=on');
});

test('narrows codex efforts by the chosen model and hides fast when the model has no fast tier', async () => {
  mockApi({
    '/api/agents/codex/models': {
      tool: 'codex',
      models: [
        { id: 'sol', label: 'Sol', efforts: ['low', 'medium', 'ultra'], fast: true },
        { id: 'luna', label: 'Luna', efforts: ['low'], fast: false },
      ],
    },
  });
  const specs = [effort(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], { perModel: true }), fast];
  const { rerender } = render(<Harness tool="codex" specs={specs} model="sol" />);
  await waitFor(() => expect([...(screen.getByLabelText('编排推理强度') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'low', 'medium', 'ultra']));
  expect(screen.getByLabelText('编排快速模式')).toBeTruthy();
  rerender(<Harness tool="codex" specs={specs} model="luna" />);
  await waitFor(() => expect(screen.queryByLabelText('编排快速模式')).toBeNull());
});

test('qoder context window takes a preset or a typed number', async () => {
  mockApi({ '/api/agents/qoder-intl/models': { tool: 'qoder-intl', models: [] } });
  const user = userEvent.setup();
  render(<Harness tool="qoder-intl" specs={[context]} />);
  await user.selectOptions(screen.getByLabelText('编排上下文长度'), '1000000');
  expect(screen.getByTestId('value').textContent).toBe('context=1000000');
  await user.selectOptions(screen.getByLabelText('编排上下文长度'), '__custom__');
  const input = screen.getByLabelText('编排上下文长度') as HTMLInputElement;
  await user.clear(input);
  await user.type(input, '384000{Enter}');
  expect(screen.getByTestId('value').textContent).toBe('context=384000');
  expect((screen.getByLabelText('编排上下文长度') as HTMLSelectElement).value).toBe('384000');
});

test('opencode effort waits for a model', () => {
  mockApi({ '/api/agents/opencode/models': { tool: 'opencode', models: [] } });
  render(<Harness tool="opencode" specs={[effort(['high'], { requiresModel: true })]} />);
  const select = screen.getByLabelText('编排推理强度') as HTMLSelectElement;
  expect(select.disabled).toBe(true);
  expect(select.textContent).toContain('先选模型');
});

test('the composer picker opens a popover with models and options', async () => {
  mockApi({
    '/api/agents/claude/models': { tool: 'claude', models: [{ id: 'opus', label: 'Opus', description: '最新的 Opus' }, { id: 'sonnet', label: 'Sonnet', description: '最新的 Sonnet' }] },
    '/api/agents/codex/models': { tool: 'codex', models: [] },
  });
  const agents: AgentsResponse = {
    agents: [
      { id: 'claude', label: 'Claude Code', command: 'claude', installed: true, renderer: true, option_specs: [effort(['low', 'high', 'max']), fast] },
      { id: 'codex', label: 'Codex', command: 'codex', installed: true, renderer: true, option_specs: [effort(['low', 'high'], { perModel: true }), fast] },
    ],
    orchestrator: 'claude',
    renderer: 'claude',
    orchestrator_model: '',
    renderer_model: '',
    orchestrator_options: 'effort=high',
    renderer_options: '',
    global_renderer: 'claude',
  };
  // 模型列表按工具缓存在模块里；上面的用例给 claude 存过一份空的。
  await loadModels('claude', true);
  const seen: AgentChoice[] = [];
  function Picker() {
    const [value, setValue] = useState<AgentChoice>({ tool: 'claude', renderer: 'claude' });
    return (
      <AgentPicker
        agents={agents}
        value={value}
        disabled={false}
        onChange={(next) => {
          seen.push(next);
          setValue(next);
        }}
      />
    );
  }
  const user = userEvent.setup();
  render(<Picker />);
  const trigger = document.getElementById('agent-model')!;
  // 按钮上写着跟着设置的推理强度。
  expect(trigger.textContent).toContain('高');
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '编排模型' });
  expect((await within(dialog).findByRole('option', { name: /Opus/ })).textContent).toContain('最新的 Opus');
  // 推理强度：第一段写明跟着设置，点「最高」写进这个会话。
  const levels = within(dialog).getByRole('radiogroup', { name: '推理强度' });
  expect(within(levels).getByRole('radio', { checked: true }).textContent).toBe('跟随·高');
  await user.click(within(levels).getByRole('radio', { name: '最高' }));
  expect(seen.at(-1)).toMatchObject({ options: 'effort=max' });
  await user.click(within(dialog).getByRole('switch', { name: '快速模式' }));
  expect(seen.at(-1)).toMatchObject({ options: 'effort=max,fast=on' });
  // 搜索后回车选第一个，弹出框关上。
  await user.type(within(dialog).getByLabelText('搜索模型'), 'son{Enter}');
  expect(seen.at(-1)).toMatchObject({ model: 'sonnet' });
  expect(screen.queryByRole('dialog', { name: '编排模型' })).toBeNull();
  expect(trigger.textContent).toContain('Sonnet');
  expect(trigger.textContent).toContain('最高');
  // 列表里没有的模型名照样能用。
  await user.click(trigger);
  await user.type(screen.getByLabelText('搜索模型'), 'claude-opus-5-5[[1m]');
  await user.click(screen.getByRole('option', { name: /使用「claude-opus-5-5\[1m\]」/ }));
  expect(seen.at(-1)).toMatchObject({ model: 'claude-opus-5-5[1m]' });
  // Esc 关上。
  await user.click(trigger);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  // 换了工具：模型与选项都回到默认，设置里给 claude 的推理强度不再算数。
  await user.selectOptions(document.getElementById('agent-tool') as HTMLSelectElement, 'codex');
  expect(seen.at(-1)).toMatchObject({ tool: 'codex', model: '', options: '' });
  await user.click(document.getElementById('agent-model')!);
  expect(within(screen.getByRole('radiogroup', { name: '推理强度' })).getByRole('radio', { checked: true }).textContent).toBe('默认');
});

test('qoder context window takes a preset or a typed number in the popover', async () => {
  mockApi({ '/api/agents/qoder-intl/models': { tool: 'qoder-intl', models: [{ id: 'Auto', label: 'Auto' }] } });
  const user = userEvent.setup();
  function Harness2() {
    const [options, setOptions] = useState('');
    return (
      <>
        <ModelPicker tool="qoder-intl" model="" defaultLabel="默认模型" specs={[context]} options={options} ariaLabel="编排模型" onModel={() => {}} onOptions={setOptions} />
        <output data-testid="value">{options}</output>
      </>
    );
  }
  render(<Harness2 />);
  await user.click(screen.getByRole('button', { name: '编排模型' }));
  await user.click(screen.getByRole('radio', { name: '1M' }));
  expect(screen.getByTestId('value').textContent).toBe('context=1000000');
  await user.click(screen.getByRole('button', { name: '自定义' }));
  await user.type(screen.getByLabelText('上下文长度'), '384000{Enter}');
  expect(screen.getByTestId('value').textContent).toBe('context=384000');
  expect(screen.getByRole('radio', { name: '384K' }).getAttribute('aria-checked')).toBe('true');
});

// Qoder 的模型表带说明、额度倍率、每个模型的推理档位与上下文长度（后端 tools/qodermodels.ts）。
test('qoder models show credits and narrow effort and context to the chosen model', async () => {
  mockApi({
    '/api/agents/qoder-intl/models': {
      tool: 'qoder-intl',
      models: [
        { id: 'Auto', label: 'Auto', description: '智能选择最适合的模型', credit: 0.5, isDefault: true, contextWindows: [200000, 400000, 1000000], defaultContextWindow: 200000 },
        { id: 'Sonus', label: 'Sonus', description: '专为最艰巨的端到端任务而生', credit: 8, efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high', contextWindows: [200000, 1000000], defaultContextWindow: 200000 },
        { id: 'Efficient', label: 'Efficient', credit: 0, creditBefore: 0.3, free: true, efforts: [], contextWindows: [200000] },
        { id: 'Ultimate', label: 'Ultimate', credit: 2, promotion: '错峰2折' },
      ],
    },
  });
  await loadModels('qoder-intl', true);
  const specs: AgentOptionSpec[] = [
    effort(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], { perModel: true }),
    { ...context, perModel: true },
  ];
  function Harness3({ model }: { model: string }) {
    const [options, setOptions] = useState('');
    return <ModelPicker tool="qoder-intl" model={model} defaultLabel="默认模型" specs={specs} options={options} ariaLabel="渲染模型" onModel={() => {}} onOptions={setOptions} />;
  }
  const user = userEvent.setup();
  const { rerender } = render(<Harness3 model="Sonus" />);
  await user.click(screen.getByRole('button', { name: '渲染模型' }));
  const sonus = await screen.findByRole('option', { name: /Sonus/ });
  expect(sonus.textContent).toContain('专为最艰巨的端到端任务而生');
  expect(sonus.textContent).toContain('8.00x 额度');
  const efficient = screen.getByRole('option', { name: /Efficient/ });
  expect(efficient.textContent).toContain('免费');
  expect(efficient.querySelector('s')?.textContent).toBe('0.30x');
  expect(screen.getByRole('option', { name: /Ultimate/ }).textContent).toContain('错峰2折');
  expect(screen.getByRole('option', { name: /默认模型/ }).textContent).toContain('工具默认 Auto');
  // 推理强度只列 Sonus 有的档位，第一段写明它默认用哪一档。
  const levels = within(screen.getByRole('radiogroup', { name: '推理强度' })).getAllByRole('radio').map((b) => b.textContent);
  expect(levels).toEqual(['默认·高', '不推理', '低', '高', '最高']);
  // 上下文长度只列它支持的，不给「自定义」。
  const windows = screen.getByRole('radiogroup', { name: '上下文长度' });
  expect(within(windows).getAllByRole('radio').map((b) => b.textContent)).toEqual(['默认·200K', '200K', '1M']);
  expect(within(windows).queryByRole('button', { name: '自定义' })).toBeNull();
  rerender(<Harness3 model="Efficient" />);
  // Efficient 不推理：没有推理强度这一行；上下文只有一档。
  expect(screen.queryByRole('radiogroup', { name: '推理强度' })).toBeNull();
  expect(within(screen.getByRole('radiogroup', { name: '上下文长度' })).getAllByRole('radio').map((b) => b.textContent)).toEqual(['默认', '200K']);
});

test('default model capabilities apply before an explicit model is chosen', async () => {
  mockApi({ '/api/agents/mcode/models': { tool: 'mcode', models: [{ id: 'default', label: 'Default', isDefault: true, efforts: [], fast: false }] } });
  await loadModels('mcode', true);
  const specs = [effort(['low', 'high'], { perModel: true }), fast];
  const { unmount } = render(<Harness tool="mcode" specs={specs} />);
  await waitFor(() => expect(screen.queryByLabelText('编排推理强度')).toBeNull());
  expect(screen.queryByLabelText('编排快速模式')).toBeNull();
  unmount();
  render(<ModelPicker tool="mcode" model="" defaultLabel="默认模型" specs={specs} options="" ariaLabel="模型" onModel={() => {}} onOptions={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: '模型' }));
  expect(screen.queryByRole('radiogroup', { name: '推理强度' })).toBeNull();
  expect(screen.queryByRole('switch', { name: '快速模式' })).toBeNull();
});

test('inherited fast mode can be disabled and restored even on a model without fast mode', async () => {
  mockApi({ '/api/agents/mcode/models': { tool: 'mcode', models: [{ id: 'default', label: 'Default', isDefault: true, fast: false }] } });
  await loadModels('mcode', true);
  const { unmount } = render(<Harness tool="mcode" specs={[fast]} inherited="fast=on" />);
  await userEvent.selectOptions(screen.getByLabelText('编排快速模式'), 'off');
  expect(screen.getByTestId('value').textContent).toBe('fast=off');
  await userEvent.selectOptions(screen.getByLabelText('编排快速模式'), '');
  expect(screen.getByTestId('value').textContent).toBe('');
  unmount();
  function Picker() {
    const [options, setOptions] = useState('');
    return <><ModelPicker tool="mcode" model="" defaultLabel="默认模型" specs={[fast]} options={options} inheritedOptions="fast=on" ariaLabel="模型" onModel={() => {}} onOptions={setOptions} /><output data-testid="value">{options}</output></>;
  }
  render(<Picker />);
  await userEvent.click(screen.getByRole('button', { name: '模型' }));
  await userEvent.click(screen.getByRole('switch', { name: '快速模式' }));
  expect(screen.getByTestId('value').textContent).toBe('fast=off');
  await userEvent.click(screen.getByRole('button', { name: '快速模式跟随设置' }));
  expect(screen.getByTestId('value').textContent).toBe('');
  expect(screen.getByRole('switch', { name: '快速模式' }).getAttribute('aria-checked')).toBe('true');
});


test('disabling an open model picker closes it and prevents further edits', async () => {
  mockApi({ '/api/agents/claude/models': { tool: 'claude', models: [] } });
  const props = { tool: 'claude', model: '', defaultLabel: '默认', specs: [fast], options: '', ariaLabel: '模型', onModel: () => {}, onOptions: () => {} };
  const { rerender } = render(<ModelPicker {...props} />);
  await userEvent.click(screen.getByRole('button', { name: '模型' }));
  expect(screen.getByRole('switch')).toBeTruthy();
  rerender(<ModelPicker {...props} disabled />);
  expect(screen.queryByRole('dialog')).toBeNull();
  rerender(<ModelPicker {...props} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '模型' }));
  expect(screen.getByRole('switch')).toBeTruthy();
});


test('waits for session options to save before allowing the next change', async () => {
  mockApi({ '/api/agents/claude/models': { tool: 'claude', models: [] } });
  const agents: AgentsResponse = { agents: [{ id: 'claude', label: 'Claude', command: 'claude', installed: true, renderer: true, option_specs: [effort(['low', 'high']), fast] }], orchestrator: 'claude', renderer: 'claude', global_renderer: 'claude', orchestrator_model: '', renderer_model: '' };
  let complete!: () => void;
  const seen: AgentChoice[] = [];
  function Picker() {
    const [value, setValue] = useState<AgentChoice>({ tool: 'claude', renderer: 'claude' });
    return <AgentPicker agents={agents} value={value} disabled={false} onChange={async next => {
      seen.push(next);
      await new Promise<void>(resolve => { complete = resolve; });
      setValue(next);
    }} />;
  }
  render(<Picker />);
  await userEvent.click(document.getElementById('agent-model')!);
  await userEvent.click(screen.getByRole('radio', { name: '高' }));
  expect((document.getElementById('agent-model') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => complete());
  await userEvent.click(document.getElementById('agent-model')!);
  await userEvent.click(screen.getByRole('switch', { name: '快速模式' }));
  expect(seen.at(-1)?.options).toBe('effort=high,fast=on');
  await act(async () => complete());
});
