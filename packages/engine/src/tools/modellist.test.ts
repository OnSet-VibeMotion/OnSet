import { describe, expect, it } from 'vitest';
import { interactiveInvocation, modelArgs, modelListCommand, orchestratorInvocation, parseModelList, rendererInvocation, ValidRenderers, ValidTools } from './index';

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
    // 导演的模型、会话与白名单都在 stdin 的请求里，不进命令行（ps 里谁都看得见）。
    const director = orchestratorInvocation('director', { workdir: '/w', prompt: 'p', sessionID: 's', resume: true, model: 'deepseek/deepseek-v4-pro', access: { commands: ['ls'] }, agentDir: '/a' });
    expect(director.argv.slice(-2)).toEqual(['studio', 'agent']);
    expect(JSON.parse(director.stdin)).toEqual({ workdir: '/w', prompt: 'p', session_id: 's', resume: true, model: 'deepseek/deepseek-v4-pro', commands: ['ls'], agent_dir: '/a' });
  });

  it('keeps the Director out of the renderer seat', () => {
    expect(ValidTools.has('director')).toBe(true);
    expect(ValidRenderers.has('director')).toBe(false);
    expect(() => rendererInvocation('director', 'p', false, { commands: [] })).toThrow(/只能做编排/);
  });

  it('reads the model lists the tools print', () => {
    for (const tool of ValidTools) modelListCommand(tool);
    expect(parseModelList('codex', JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] }))).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
    ]);
    expect(parseModelList('codex', 'not json')).toEqual([]);
    expect(parseModelList('qoder', 'MODEL\nAuto\nQwen3.8-Max\n\n').map((m) => m.id)).toEqual(['Auto', 'Qwen3.8-Max']);
    const help = '  --model <model>   Model for the current session. Please provide the model ID. Currently supported: (hy4free, glm-5.3,\n   kimi-k3.1-pro)\n';
    expect(parseModelList('codebuddy', help).map((m) => m.id)).toEqual(['hy4free', 'glm-5.3', 'kimi-k3.1-pro']);
    expect(parseModelList('opencode', 'a/b\nwarning: something\nc/d#high\n').map((m) => m.id)).toEqual(['a/b', 'c/d#high']);
    expect(parseModelList('claude', '').map((m) => m.id)).toContain('opus');
    expect(parseModelList('director', 'deepseek/deepseek-v4-pro\nmoonshotai-cn/kimi-k3\n').map((m) => m.id)).toEqual(['deepseek/deepseek-v4-pro', 'moonshotai-cn/kimi-k3']);
    expect(modelListCommand('director')!.slice(-3)).toEqual(['studio', 'agent', '--list-models']);
  });
});
