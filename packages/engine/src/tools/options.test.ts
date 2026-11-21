import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveService } from '../director';
import {
  agentOptionSpecs,
  claudeOptionSettings,
  codexOptionOverrides,
  effectiveOptions,
  formatAgentOptions,
  mergeAgentOptions,
  opencodeModel,
  optionArgs,
  parseAgentOptions,
  validateAgentOptions,
  validOptionsText,
} from './options';
import { orchestratorInvocation, rendererInvocation, rendererLaunch, ValidTools } from './tools';
import { parseModelList } from './modellist';

describe('agent options', () => {
  it('every tool declares its options', () => {
    for (const tool of ValidTools) expect(agentOptionSpecs(tool).length, tool).toBeGreaterThan(0);
    expect(agentOptionSpecs('claude').map((s) => s.key)).toEqual(['effort', 'repair_effort', 'simple_effort', 'fast']);
    expect(agentOptionSpecs('codex').map((s) => s.key)).toEqual(['effort', 'repair_effort', 'simple_effort', 'fast']);
    expect(agentOptionSpecs('qoder').map((s) => s.key)).toEqual(['effort', 'repair_effort', 'simple_effort', 'context']);
    expect(agentOptionSpecs('qoder-intl').map((s) => s.key)).toEqual(['effort', 'repair_effort', 'simple_effort', 'context']);
    expect(agentOptionSpecs('mcode').map((s) => s.key)).toEqual(['effort', 'repair_effort', 'simple_effort']);
    expect(agentOptionSpecs('agy').map((s) => s.key)).toEqual(['effort', 'repair_effort', 'simple_effort']);
  });

  it('reads and writes one line', () => {
    expect(parseAgentOptions('fast=on,effort=high')).toEqual({ fast: 'on', effort: 'high' });
    expect(parseAgentOptions('broken,=x,effort=high')).toEqual({ effort: 'high' });
    expect(formatAgentOptions({ fast: 'on', effort: 'high', context: '' })).toBe('effort=high,fast=on');
    expect(validOptionsText('')).toBe(true);
    expect(validOptionsText('effort=high,fast=on')).toBe(true);
    expect(validOptionsText('effort=high fast=on')).toBe(false);
    expect(validOptionsText('effort="x"')).toBe(false);
  });

  // 会话里选的盖在设置上，可以用 fast=off 关掉设置里打开的快速模式。
  it('merges session options over settings key by key', () => {
    expect(mergeAgentOptions('effort=high,fast=on', 'fast=off')).toBe('effort=high,fast=off');
    expect(mergeAgentOptions('', 'effort=low')).toBe('effort=low');
  });

  it('validates per tool', () => {
    expect(validateAgentOptions('claude', 'effort=xhigh,fast=on')).toBe('');
    expect(validateAgentOptions('claude', 'effort=ultra')).toContain('推理强度');
    expect(validateAgentOptions('claude', 'context=200000')).toContain('没有选项');
    expect(validateAgentOptions('qoder-intl', 'context=200000,effort=ultracode')).toBe('');
    expect(validateAgentOptions('qoder', 'context=0')).toContain('正整数');
    // codex 的档位随模型变，新档位不该被拦。
    expect(validateAgentOptions('codex', 'effort=ultra')).toBe('');
    expect(validateAgentOptions('codex', 'effort=Ultra')).toContain('写法');
    expect(validateAgentOptions('codex', 'fast=yes')).toContain('on 或 off');
  });

  // 换了工具带过来的、写错的项，调用时一律不传。
  it('drops options the tool does not understand', () => {
    expect(effectiveOptions('codebuddy', 'effort=high,fast=on,context=1000')).toEqual({ effort: 'high' });
    expect(effectiveOptions('claude', 'effort=minimal')).toEqual({});
  });

  it('turns options into each CLI argument', () => {
    expect(optionArgs('claude', { effort: 'max', fast: 'on' })).toEqual(['--effort', 'max']);
    expect(claudeOptionSettings({ fast: 'on' })).toEqual({ fastMode: true });
    expect(claudeOptionSettings({ fast: 'off' })).toEqual({});
    expect(codexOptionOverrides({ effort: 'xhigh', fast: 'on' })).toEqual(['-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="priority"']);
    expect(optionArgs('qoder-intl', { effort: 'high', context: '200000' })).toEqual(['--reasoning-effort', 'high', '--context-window', '200000']);
    expect(optionArgs('codebuddy', { effort: 'minimal' })).toEqual(['--effort', 'minimal']);
    expect(opencodeModel('p/m', { effort: 'high' })).toBe('p/m#high');
    expect(opencodeModel('', { effort: 'high' })).toBe('');
    expect(opencodeModel('p/m#max', { effort: 'high' })).toBe('p/m#max');
  });

  it('orchestrator invocations carry the options', () => {
    const claude = orchestratorInvocation('claude', { prompt: 'p', options: { effort: 'high', fast: 'on' } }).argv;
    expect(claude.slice(claude.indexOf('--effort'), claude.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
    expect(JSON.parse(claude[claude.indexOf('--settings') + 1]).fastMode).toBe(true);
    expect(JSON.parse(claude[claude.indexOf('--settings') + 1]).permissions.deny).toContain('Bash(onset:*)');
    const unsafe = orchestratorInvocation('claude', { prompt: 'p', unsafe: true, options: { fast: 'on' } }).argv;
    expect(unsafe.slice(unsafe.indexOf('--dangerously-skip-permissions'), unsafe.indexOf('--dangerously-skip-permissions') + 3)).toEqual(['--dangerously-skip-permissions', '--settings', '{"fastMode":true}']);
    const codex = orchestratorInvocation('codex', { prompt: 'p', workdir: '/w', options: { effort: 'low', fast: 'on' } }).argv;
    expect(codex).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="low"', '-c', 'service_tier="priority"']));
    expect(codex.indexOf('service_tier="priority"')).toBeLessThan(codex.indexOf('exec'));
    expect(orchestratorInvocation('qoder', { prompt: 'p', options: { context: '1000000' } }).argv).toEqual(expect.arrayContaining(['--context-window', '1000000']));
    expect(orchestratorInvocation('opencode', { prompt: 'p', model: 'p/m', options: { effort: 'high' } }).argv).toEqual(expect.arrayContaining(['-m', 'p/m#high']));
    const director = JSON.parse(orchestratorInvocation('director', { prompt: 'p', workdir: '/w', agentDir: '/a', options: { effort: 'low' } }).stdin);
    expect(director.thinking).toBe('low');
    expect(director.compact_at).toBe(96_000);
    const directorOff = JSON.parse(orchestratorInvocation('director', { prompt: 'p', workdir: '/w', agentDir: '/a', options: { compact_at: 'off' } }).stdin);
    expect(directorOff.compact_at).toBeUndefined();
    const directorCustom = JSON.parse(orchestratorInvocation('director', { prompt: 'p', workdir: '/w', agentDir: '/a', options: { compact_at: '128000' } }).stdin);
    expect(directorCustom.compact_at).toBe(128_000);
  });

  // 用户选的推理强度盖过 Windows 上的缺省。
  it('a chosen codex effort wins over the Windows default', () => {
    const argv = orchestratorInvocation('codex', { prompt: 'p', workdir: '/w', options: { effort: 'max' } }, { ONSET_WINDOWS_ORCHESTRATOR_EFFORT: 'low' }).argv;
    expect(argv.filter((a) => a.startsWith('model_reasoning_effort='))).toEqual(['model_reasoning_effort="max"']);
  });

  it('renderer invocations carry the options', () => {
    const claude = rendererInvocation('claude', 'p', false, {}, '', null, { effort: 'xhigh', fast: 'on' });
    expect(claude).toEqual(expect.arrayContaining(['--effort', 'xhigh']));
    expect(JSON.parse(claude[claude.indexOf('--settings') + 1]).fastMode).toBe(true);
    expect(rendererInvocation('codex', 'p', false, {}, '', null, { effort: 'high' })).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="high"']));
    const qoder = rendererInvocation('qoder-intl', 'p', false, {}, 'Auto', null, { effort: 'low', context: '200000' });
    expect(qoder).toEqual(expect.arrayContaining(['-m', 'Auto', '--reasoning-effort', 'low', '--context-window', '200000']));
    expect(rendererInvocation('codebuddy', 'p', false, {}, '', null, { effort: 'max' })).toEqual(expect.arrayContaining(['--effort', 'max']));
    // 不给选项时命令行与以前逐字相同。
    expect(rendererInvocation('claude', 'p', false, {})).toEqual(rendererInvocation('claude', 'p', false, {}, '', null, {}));
    expect(rendererInvocation('claude', 'p', false, {}).join(' ')).not.toContain('fastMode');
    // 全渲染器均支持 repair_effort 与 simple_effort 分级降档。
    expect(rendererInvocation('claude', 'p', false, {}, '', null, { effort: 'high', repair_effort: 'low', simple_effort: 'medium' }, 'repair')).toEqual(expect.arrayContaining(['--effort', 'low']));
    expect(rendererInvocation('claude', 'p', false, {}, '', null, { effort: 'high', repair_effort: 'low', simple_effort: 'medium' }, 'simple')).toEqual(expect.arrayContaining(['--effort', 'medium']));
    expect(rendererInvocation('codex', 'p', false, {}, '', null, { effort: 'high', repair_effort: 'low' }, 'repair')).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="low"']));
    expect(rendererInvocation('qoder', 'p', false, {}, '', null, { effort: 'high', simple_effort: 'low' }, 'simple')).toEqual(expect.arrayContaining(['--reasoning-effort', 'low']));
  });

  it('the director renderer gets the thinking level through stdin', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-options-'));
    try {
      saveService(agentDir, { name: 'custom', protocol: 'openai', base_url: 'https://relay.invalid/v1', model: 'm', vision: true, key: 'sk-x' });
      const launch = rendererLaunch('director', 'p', false, {}, '', null, '/w', { ONSET_AGENT_DIR: agentDir }, { effort: 'high' });
      expect(JSON.parse(launch.stdin)).toMatchObject({ thinking: 'high', compact_at: 64_000 });
      const launchOff = rendererLaunch('director', 'p', false, {}, '', null, '/w', { ONSET_AGENT_DIR: agentDir }, { compact_at: 'off' });
      expect(JSON.parse(launchOff.stdin).compact_at).toBeUndefined();
      expect(validateAgentOptions('director', 'compact_at=off')).toBe('');
      expect(agentOptionSpecs('director').find((s) => s.key === 'compact_at')?.rendererOnly).toBeFalsy();
      const settings = { effort: 'high', repair_effort: 'medium', compact_at: '64000' };
      const render = rendererLaunch('director', 'p', false, {}, '', null, '/w', { ONSET_AGENT_DIR: agentDir }, settings);
      const repair = rendererLaunch('director', 'p', false, {}, '', null, '/w', { ONSET_AGENT_DIR: agentDir }, settings, 'repair');
      expect(JSON.parse(render.stdin)).toMatchObject({ thinking: 'high', compact_at: 64000 });
      expect(JSON.parse(repair.stdin)).toMatchObject({ thinking: 'medium', compact_at: 64000 });
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('codex model list carries each model efforts and fast tier', () => {
    const models = parseModelList(
      'codex',
      JSON.stringify({
        models: [
          { slug: 'a', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], service_tiers: [{ id: 'priority', name: 'Fast' }] },
          { slug: 'b', visibility: 'list', service_tiers: [] },
          { slug: 'c', visibility: 'list' },
        ],
      }),
    );
    expect(models).toEqual([
      { id: 'a', label: 'a', efforts: ['low', 'ultra'], fast: true },
      { id: 'b', label: 'b', fast: false },
      { id: 'c', label: 'c' },
    ]);
  });
});
