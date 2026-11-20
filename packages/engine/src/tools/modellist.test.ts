import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveService } from '../director';
import { interactiveInvocation, mcodeModelOptions, modelArgs, modelListCommand, orchestratorInvocation, parseModelList, rendererInvocation, rendererLaunch, ValidRenderers, ValidTools } from './index';

describe('model choice', () => {
  // 每家指定模型的参数不同，写错了不报错、只是悄悄用回默认模型（2026-11 各家 --help 实测）。
  it('passes the model with each tool’s own flag', () => {
    const access = { commands: [], readDirs: [] };
    expect(rendererInvocation('claude', 'p', false, access, 'opus')).toEqual(expect.arrayContaining(['--model', 'opus']));
    expect(rendererInvocation('codebuddy', 'p', false, access, 'glm-5.3')).toEqual(expect.arrayContaining(['--model', 'glm-5.3']));
    expect(rendererInvocation('qoder', 'p', false, access, 'Qwen3.8-Max')).toEqual(expect.arrayContaining(['-m', 'Qwen3.8-Max']));
    expect(rendererInvocation('opencode', 'p', false, access, 'github-copilot/claude-opus-5.5')).toEqual(expect.arrayContaining(['-m', 'github-copilot/claude-opus-5.5']));
    expect(rendererInvocation('codex', 'p', false, access, 'gpt-6.1-sol')).toEqual(expect.arrayContaining(['-c', 'model="gpt-6.1-sol"']));
    for (const tool of ValidRenderers) {
      if (tool === 'director') continue; // 自带制作人的模型经 stdin 传递。
      expect(modelArgs(tool, '')).toEqual([]);
      // 加模型只多出模型参数，其余（提示词的位置、权限参数）不变。
      const without = rendererInvocation(tool, 'p', false, access, '');
      const withModel = rendererInvocation(tool, 'p', false, access, 'm');
      expect(withModel.filter((a) => !modelArgs(tool, 'm').includes(a)), tool).toEqual(without);
      expect(withModel.length - without.length, tool).toBe(2);
    }
  });

  it('keeps the model on resume and in the interactive protocols', () => {
    const resumed = orchestratorInvocation('codex', { workdir: '/w', prompt: 'p', sessionID: 's', resume: true, model: 'gpt-6-luna' }).argv;
    expect(resumed.slice(0, 3)).toEqual(['codex', '-c', 'model="gpt-6-luna"']);
    expect(orchestratorInvocation('claude', { workdir: '/w', prompt: 'p', sessionID: 's', resume: true, model: 'opus' }).argv).toEqual(expect.arrayContaining(['--model', 'opus', '--resume', 's']));
    expect(orchestratorInvocation('opencode', { workdir: '/w', prompt: 'p', model: 'a/b' }).argv).toEqual(expect.arrayContaining(['-m', 'a/b']));
    expect(interactiveInvocation('codebuddy', { model: 'glm-5.3' })!.argv).toEqual(expect.arrayContaining(['--model', 'glm-5.3']));
    const opencode = interactiveInvocation('opencode', { model: 'a/b' }, { OPENCODE_CONFIG_CONTENT: '{"theme":"x"}' })!;
    expect(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT!)).toEqual({ theme: 'x', model: 'a/b', permission: { bash: 'ask' } });
    // 制作人的模型、会话与白名单都在 stdin 的请求里，不进命令行（ps 里谁都看得见）。
    // 在用的模型服务连同 API key 也在请求里：父进程读出（客户端里解密）交下去，制作人不读磁盘上的凭据。
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-director-req-'));
    try {
      const id = saveService(agentDir, { name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', vision: false, key: 'sk-1' });
      const director = orchestratorInvocation('director', { workdir: '/w', prompt: 'p', sessionID: 's', resume: true, model: 'deepseek-v4-flash', access: { commands: ['ls'] }, agentDir });
      expect(director.argv.slice(-2)).toEqual(['studio', 'agent']);
      expect(director.argv.join(' ')).not.toContain('sk-1');
      expect(JSON.stringify(director.env ?? {})).not.toContain('sk-1');
      expect(JSON.parse(director.stdin)).toEqual({
        workdir: '/w',
        prompt: 'p',
        session_id: 's',
        resume: true,
        model: 'deepseek-v4-flash',
        compact_at: 96_000,
        commands: ['ls'],
        agent_dir: agentDir,
        service: { id, name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', vision: false, key: 'sk-1' },
      });
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('runs the Producer as a renderer with the service and model only on stdin', () => {
    expect(ValidTools.has('director')).toBe(true);
    expect(ValidRenderers.has('director')).toBe(true);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-renderer-request-'));
    try {
      saveService(agentDir, { name: 'custom', protocol: 'openai', base_url: 'https://relay.invalid/v1', model: 'custom-model', vision: true, key: 'sk-renderer-secret' });
      const launch = rendererLaunch('director', 'scene prompt', false, { commands: ['ls'], readDirs: ['/skills'], unfiltered: true }, 'other-model', { id: 'previous', resume: true }, '/scene', { ONSET_AGENT_DIR: agentDir });
      expect(launch.argv.slice(-2)).toEqual(['studio', 'agent']);
      expect(launch.argv.join(' ')).not.toContain('sk-renderer-secret');
      expect(JSON.stringify(launch.env)).not.toContain('sk-renderer-secret');
      expect(JSON.parse(launch.stdin)).toMatchObject({ profile: 'renderer', workdir: '/scene', prompt: 'scene prompt', model: 'other-model', session_id: 'previous', resume: true, unsafe: true, read_dirs: ['/skills'], service: { model: 'custom-model', key: 'sk-renderer-secret' } });
      expect(JSON.parse(launch.stdin).agent_dir).not.toBe(agentDir);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('reads the model lists the tools print', () => {
    for (const tool of ValidTools) modelListCommand(tool);
    expect(parseModelList('codex', JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] }))).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
    ]);
    expect(parseModelList('codex', 'not json')).toEqual([]);
    expect(parseModelList('codex', JSON.stringify({ models: [
      { slug: 'no-reasoning', supported_reasoning_levels: [] },
      { slug: 'unknown' },
    ] }))).toEqual([{ id: 'no-reasoning', label: 'no-reasoning', efforts: [] }, { id: 'unknown', label: 'unknown' }]);
    expect(parseModelList('qoder', 'MODEL\nAuto\nQwen3.8-Max\n\n').map((m) => m.id)).toEqual(['Auto', 'Qwen3.8-Max']);
    expect(modelListCommand('qoder-intl')).toEqual(['qodercli', '--list-models']);
    expect(parseModelList('qoder-intl', 'MODEL\nAuto\nUltimate\n').map((m) => m.id)).toEqual(['Auto', 'Ultimate']);
    const help = '  --model <model>   Model for the current session. Please provide the model ID. Currently supported: (hy4free, glm-5.3,\n   kimi-k3.1-pro)\n';
    expect(parseModelList('codebuddy', help).map((m) => m.id)).toEqual(['hy4free', 'glm-5.3', 'kimi-k3.1-pro']);
    expect(parseModelList('opencode', 'a/b\nwarning: something\nc/d#high\n').map((m) => m.id)).toEqual(['a/b', 'c/d#high']);
    expect(parseModelList('claude', '').map((m) => m.id)).toContain('opus');
    // 制作人不跑命令：客户端后端直接问模型服务（studio/agents.ts）。
    expect(modelListCommand('director')).toBeNull();
  });

  // MiniMax Code 0.6.12 实测：exec 只有三档权限、没有 MCP 参数；客户端里编排一律走 ACP（安全与否在会话里切权限模式）。
  it('runs MiniMax Code with exec and ACP', () => {
    const access = { commands: [], readDirs: [] };
    expect(rendererInvocation('mcode', 'p', false, access, 'minimax/MiniMax-M3', null, { effort: 'high' })).toEqual(['mcode', 'exec', '--cwd', '.', '--permission', 'smart', '--model', 'minimax/MiniMax-M3', '--effort', 'high', '--output-format', 'stream-json', 'p']);
    expect(rendererInvocation('mcode', 'p', false, { ...access, unfiltered: true }, '', { id: 'mvs_1', resume: true })).toEqual(['mcode', 'exec', '--cwd', '.', '--permission', 'full', '--session', 'mvs_1', '--output-format', 'stream-json', 'p']);
    const orchestrator = orchestratorInvocation('mcode', { workdir: '/w', prompt: 'long prompt', sessionID: 'mvs_2', resume: true, unsafe: true });
    expect(orchestrator.argv).toEqual(['mcode', 'exec', '--cwd', '/w', '--permission', 'full', '--output-format', 'stream-json', '--session', 'mvs_2', '--input', '-']);
    expect(orchestrator.stdin).toBe('long prompt');
    expect(() => orchestratorInvocation('mcode', { workdir: '/w', prompt: 'p', sessionID: 'preset' })).toThrow('不支持预先指定会话 id');
    expect(interactiveInvocation('mcode', { unsafe: false })).toEqual({ protocol: 'acp', argv: ['mcode', 'acp'], env: {} });
    expect(interactiveInvocation('mcode', { unsafe: true })).toEqual({ protocol: 'acp', argv: ['mcode', 'acp'], env: {} });
    expect(modelListCommand('mcode')).toEqual(['mcode', 'acp']);
  });

  it('reads the MiniMax Code models from the ACP session options', () => {
    const configOptions = [
      { id: 'permissionMode', currentValue: 'bypassPermissions', options: [] },
      {
        id: 'model',
        currentValue: 'm:minimax:MiniMax-M3.1-Flash:v:thinking',
        options: [
          { value: 'm:minimax:MiniMax-M3.1-Flash:v:', name: 'M3.1-Flash' },
          { value: 'm:minimax:MiniMax-M3.1-Flash:v:thinking', name: 'M3.1-Flash · thinking' },
          { value: 'm:minimax:MiniMax-M3:v:', name: 'M3' },
          { value: 'm:minimax:MiniMax-M3:v:thinking', name: 'M3 · thinking' },
        ],
      },
    ];
    const efforts = new Map([['minimax/MiniMax-M3.1-Flash', ['low', 'high']], ['minimax/MiniMax-M3', []]]);
    expect(mcodeModelOptions(configOptions, efforts)).toEqual([
      { id: 'minimax/MiniMax-M3.1-Flash', label: 'M3.1-Flash', isDefault: true, efforts: ['low', 'high'] },
      { id: 'minimax/MiniMax-M3', label: 'M3', efforts: [] },
    ]);
  });

  // Antigravity CLI 1.5.13 实测：headless 走 -p + --conversation，客户端走 agy acp，模型表跑 agy models。
  it('runs Antigravity CLI with headless print, ACP and agy models', () => {
    const access = { commands: ['ls'], readDirs: ['/skills'] };
    const safe = rendererInvocation('agy', 'p', false, access, 'gemini-3.8-flash', null, { effort: 'low' });
    expect(safe.slice(0, 5)).toEqual(['agy', '-p', 'p', '--mode', 'accept-edits']);
    expect(safe).toEqual(expect.arrayContaining(['--model', 'gemini-3.8-flash', '--effort', 'low', '--output-format', 'stream-json']));
    const settings = JSON.parse(safe[safe.indexOf('--settings') + 1]);
    expect(settings.toolPermission).toBe('request-review');
    expect(settings.permissions.allow).toEqual(['command(ls)', 'read_file(/skills)']);
    expect(settings.permissions.deny).toEqual(['command(onset)', 'read_file(.env)', 'write_file(/skills)']);
    expect(rendererInvocation('agy', 'p', false, { ...access, unfiltered: true }, '', { id: 'conv-1', resume: true })).toEqual([
      'agy', '-p', 'p', '--dangerously-skip-permissions', '--conversation', 'conv-1', '--output-format', 'stream-json',
    ]);
    const orch = orchestratorInvocation('agy', { workdir: '/w', prompt: 'hello', sessionID: 'conv-2', resume: true, unsafe: true });
    expect(orch.argv).toEqual(['agy', '-p', 'hello', '--dangerously-skip-permissions', '--conversation', 'conv-2', '--output-format', 'stream-json']);
    expect(() => orchestratorInvocation('agy', { workdir: '/w', prompt: 'p', sessionID: 'preset' })).toThrow('不支持预先指定会话 id');
    expect(interactiveInvocation('agy', { unsafe: false })).toEqual({ protocol: 'acp', argv: ['agy', 'acp'], env: {} });
    expect(interactiveInvocation('agy', { unsafe: true })).toEqual({ protocol: 'acp', argv: ['agy', 'acp', '--dangerously-skip-permissions'], env: {} });
    expect(modelListCommand('agy')).toEqual(['agy', 'models']);
    const raw = [
      '\r⠋ Fetching available models...\rgemini-4-neon-high             Gemini 4 Neon (High)',
      'gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)',
      'gemini-4-neon-medium           Gemini 4 Neon (Medium)',
      'gemini-4-neon-low              Gemini 4 Neon (Low)',
      'gemini-pro-orchestrator-neon   Orchestrator (Neon)',
      'gpt-oss-120b-medium            GPT-OSS 120B (Medium)',
    ].join('\n');
    expect(parseModelList('agy', raw)).toEqual([
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', efforts: [] },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', efforts: [] },
    ]);
  });
});
