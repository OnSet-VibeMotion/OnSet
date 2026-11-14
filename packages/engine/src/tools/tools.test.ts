import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { onsetToolsServer, extractUserMessages, orchestratorInvocation, presetSessionID, projectRulesFilename, rendererEnv, rendererInvocation } from './index';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onset-tools-'));
}

describe('tools', () => {
  describe('renderer invocation safe by default', () => {
    const tests: [string, string[]][] = [
      ['codex', ['codex', '--ask-for-approval', 'never', 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--json', 'prompt']],
      ['claude', ['claude', '-p', '--permission-mode', 'acceptEdits', '--settings', `{"permissions":{"additionalDirectories":[],"allow":[],"deny":["Bash(onset:*)","Read(**/.env)","Read(**/.env.*)"]}}`, '--verbose', '--output-format', 'stream-json', '--prompt-suggestions', 'false', 'prompt']],
      // dont_ask 连镜头目录里写文件都拒（2026-11 实测渲染器一个 index.html 都写不出来）：与 claude 同一套放行规则。
      ['qoder', ['qoderclicn', '-p', 'prompt', '--permission-mode', 'accept_edits', '--setting-sources', 'project,local', '--settings', `{"permissions":{"additionalDirectories":[],"allow":[],"deny":["Bash(onset:*)","Read(**/.env)","Read(**/.env.*)"]},"mcp":{"lazyLoad":false}}`, '--output-format', 'stream-json']],
      ['codebuddy', ['codebuddy', '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits', 'prompt']],
      ['opencode', ['opencode', 'run', '--standalone', '--format', 'json', 'prompt']],
    ];
    for (const [tool, want] of tests) {
      it(tool, () => {
        expect(rendererInvocation(tool, 'prompt', false, {})).toEqual(want);
      });
    }
  });

  // qoder 渲染器要能读技能目录、跑 ls / ffprobe、在镜头目录写文件，读不到 .env（规则写进 --settings，实测 qoder 认）。
  it('qoder renderer gets the same access rules as claude', () => {
    const argv = rendererInvocation('qoder', 'prompt', false, { commands: ['ls', 'ffprobe'], readDirs: ['/proj/.agents/skills'] });
    expect(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'accept_edits']);
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)', 'Bash(ffprobe:*)', 'Read(//proj/.agents/skills/**)']);
    expect(settings.permissions.additionalDirectories).toEqual(['/proj/.agents/skills']);
    expect(settings.permissions.deny).toContain('Read(**/.env)');
    expect(argv).not.toContain('dont_ask');
    // 不读用户级设置（用户级技能、钩子）：镜头的技能由 scene.run 链进镜头目录（安全与不安全模式都一样）。
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('project,local');
    const unsafe = rendererInvocation('qoder', 'prompt', true, {});
    expect(unsafe[unsafe.indexOf('--setting-sources') + 1]).toBe('project,local');
  });

  it('renderer invocation unsafe is explicit', () => {
    expect(rendererInvocation('codex', 'prompt', true, {})).toEqual([
      'codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', 'prompt',
    ]);
  });

  it('extract user messages', () => {
    const line = `{"type":"item.completed","item":{"type":"agent_message","text":"ignore\\n[[USER_MESSAGE]]完成"}}`;
    expect(extractUserMessages('codex', line)).toEqual(['完成']);
  });

  it('unknown tool fails closed', () => {
    expect(() => rendererInvocation('unknown', 'prompt', false, {})).toThrow();
  });

  it('orchestrator invocation uses safe workspace mode', () => {
    const { argv, stdin } = orchestratorInvocation('codex', { workdir: '/work', prompt: 'prompt' });
    expect(argv).toEqual([
      'codex', '--ask-for-approval', 'never', '-c', 'sandbox_workspace_write.network_access=true', 'exec',
      '--skip-git-repo-check', '--cd', '/work', '--sandbox', 'workspace-write', '--json', '-',
    ]);
    expect(stdin).toBe('prompt');
  });

  // 编排工具调用的 onset 要写用户级记忆库，codex 的 workspace-write 沙箱只放行工作目录，
  // 记忆库要用 --add-dir 加进去；不存在的目录不传。
  it('codex sandbox adds writable memory dir', () => {
    const memory = tempDir();
    const { argv } = orchestratorInvocation('codex', {
      workdir: '/work', prompt: 'p', access: { writableDirs: [memory, path.join(memory, 'missing')] },
    });
    const joined = argv.join(' ');
    expect(joined).toContain('--sandbox workspace-write --add-dir ' + memory + ' --json');
    expect(joined).not.toContain('missing');
  });

  it('orchestrator invocation unsafe skips git check', () => {
    const { argv, stdin } = orchestratorInvocation('codex', { workdir: '/work', prompt: 'prompt', unsafe: true });
    expect(argv).toEqual(['codex', 'exec', '--skip-git-repo-check', '--cd', '/work', '--dangerously-bypass-approvals-and-sandbox', '--json', '-']);
    expect(stdin).toBe('prompt');
  });

  it('codex resume keeps prompt on stdin', () => {
    const { argv, stdin } = orchestratorInvocation('codex', { workdir: '/work', prompt: 'next', sessionID: 't1', resume: true });
    expect(argv.slice(-4)).toEqual(['--json', 'resume', 't1', '-']);
    expect(stdin).toBe('next');
  });

  describe('all orchestrator invocations', () => {
    for (const tool of ['codex', 'claude', 'qoder', 'codebuddy', 'opencode']) {
      for (const unsafe of [false, true]) {
        it(`${tool}-${unsafe ? 'unsafe' : 'safe'}`, () => {
          const { argv, stdin } = orchestratorInvocation(tool, { workdir: '/work', prompt: 'prompt', unsafe });
          expect(argv.length).toBeGreaterThan(0);
          expect(argv[0]).not.toBe('');
          const joined = argv.join(' ');
          // 编排调用必须输出结构化流。
          expect(joined).toContain('json');
          // opencode 2.x 已去掉 --dir。
          expect(joined).not.toContain('--dir');
          // prompt 要传进去。
          expect(stdin === 'prompt' || argv[argv.length - 1] === 'prompt' || joined.includes(' prompt ')).toBe(true);
        });
      }
    }
    it('rejects unknown tool', () => {
      expect(() => orchestratorInvocation('bad', { workdir: '/work', prompt: 'prompt' })).toThrow();
    });
  });

  it('orchestrator session arguments', () => {
    const tests: [string, boolean, string[]][] = [
      ['claude', false, ['--session-id', 's1']],
      ['claude', true, ['--resume', 's1']],
      ['codebuddy', false, ['--session-id', 's1']],
      ['codebuddy', true, ['--resume', 's1']],
      ['qoder', false, ['--session-id', 's1']],
      ['qoder', true, ['-r', 's1']],
      ['opencode', true, ['-s', 's1']],
    ];
    for (const [tool, resume, want] of tests) {
      const { argv } = orchestratorInvocation(tool, { workdir: '/work', prompt: 'p', sessionID: 's1', resume });
      expect(argv.join(' '), `${tool} resume=${resume}`).toContain(want.join(' '));
    }
    for (const tool of ['codex', 'opencode']) {
      // 会话 id 只能从输出流读。
      expect(presetSessionID(tool)).toBe(false);
      expect(() => orchestratorInvocation(tool, { prompt: 'p', sessionID: 's1' })).toThrow();
    }
    // 续接缺 id 应当报错。
    expect(() => orchestratorInvocation('claude', { prompt: 'p', resume: true })).toThrow();
  });

  it('orchestrator safe mode allows listed commands', () => {
    const access = { commands: ['onset', 'ffprobe'] };
    const { argv } = orchestratorInvocation('qoder', { prompt: 'p', access });
    const joined = argv.join(' ');
    for (const want of ['--permission-mode accept_edits', '--allowed-tools Bash(onset:*)', '--allowed-tools Bash(ffprobe:*)']) {
      expect(joined).toContain(want);
    }
    // dont_ask 连写文件都拒，不能用于编排。
    expect(joined).not.toContain('dont_ask');
    for (const tool of ['claude', 'codebuddy']) {
      const { argv } = orchestratorInvocation(tool, { prompt: 'p', access });
      const settings = argv[argv.indexOf('--settings') + 1];
      expect(settings).toContain(`"Bash(onset:*)"`);
      expect(settings).toContain(`"Read(**/.env)"`);
    }
  });

  it('extract messages for every stream shape', () => {
    const tests: Record<string, string> = {
      claude: `{"type":"assistant","message":{"content":[{"type":"text","text":"[[USER_MESSAGE]]claude"}]}}`,
      qoder: `{"type":"assistant","message":{"content":[{"type":"text","text":"[[USER_MESSAGE]]qoder"}]}}`,
      codebuddy: `{"type":"assistant","message":{"content":[{"type":"text","text":"[[USER_MESSAGE]]codebuddy"}]}}`,
      opencode: `{"type":"text","part":{"text":"[[USER_MESSAGE]]opencode"}}`,
    };
    for (const [tool, line] of Object.entries(tests)) expect(extractUserMessages(tool, line)).toEqual([tool]);
    expect(extractUserMessages('codex', 'not-json')).toEqual([]);
  });

  // 文件名写错不会报错，只会让项目规则静默失效，所以逐个工具钉死。
  describe('project rules filename per tool', () => {
    const tests: Record<string, string> = {
      codex: 'AGENTS.md',
      qoder: 'AGENTS.md',
      opencode: 'AGENTS.md',
      claude: 'CLAUDE.md',
      codebuddy: 'CODEBUDDY.md',
    };
    for (const [tool, want] of Object.entries(tests)) {
      it(tool, () => expect(projectRulesFilename(tool)).toBe(want));
    }
  });

  it('project rules filename rejects unknown tool', () => {
    expect(() => projectRulesFilename('cursor')).toThrow();
  });

  // claude 在 acceptEdits 下不能跑 Bash：实测渲染器执行不了
  // npx hyperframes render/snapshot，镜头根本渲染不出来。安全模式要用 --settings
  // 显式放行这几条命令、开放技能目录读取，并继续挡住 .env。
  it('claude renderer safe mode grants minimal commands', () => {
    const access = { commands: ['npx --yes hyperframes@0.8.14', 'ffprobe'], readDirs: ['/proj/.agents/skills'] };
    const got = rendererInvocation('claude', 'prompt', false, access);
    // 提示词必须是最后一个参数。
    expect(got[got.length - 1]).toBe('prompt');
    const index = got.lastIndexOf('--settings');
    expect(index >= 0 && index + 1 < got.length).toBe(true);
    const settings = JSON.parse(got[index + 1]) as { permissions: { allow: string[]; deny: string[]; additionalDirectories: string[] } };
    expect(settings.permissions.allow).toEqual(['Bash(npx --yes hyperframes@0.8.14:*)', 'Bash(ffprobe:*)', 'Read(//proj/.agents/skills/**)']);
    expect(settings.permissions.additionalDirectories).toEqual(['/proj/.agents/skills']);
    // 技能目录只读：读放行、改一律拒绝。
    expect(settings.permissions.deny).toEqual(['Bash(onset:*)', 'Read(**/.env)', 'Read(**/.env.*)', 'Edit(//proj/.agents/skills/**)', 'Write(//proj/.agents/skills/**)']);
  });

  // onset 只经工具服务调用：渲染器与编排工具在每家都挂上 onset 的 MCP 服务，claude 系放行整个服务。
  describe('onset tools server', () => {
    const server = onsetToolsServer('/app/bin/onset', 'renderer', '/proj/scenes/s1', { ONSET_BROWSER: '/b', OPENAI_API_KEY: 'secret', PATH: '/usr/bin' });

    it('passes only onset settings to the server, never credentials', () => {
      expect(server).toEqual({
        name: 'onset',
        command: '/app/bin/onset',
        args: ['studio', 'tools-mcp', '--profile', 'renderer', '--workdir', '/proj/scenes/s1'],
        env: { ONSET_BROWSER: '/b', PATH: '/usr/bin' },
      });
    });

    it('attaches to the claude renderer without swallowing the prompt', () => {
      const got = rendererInvocation('claude', 'prompt', false, { commands: ['ls'], toolsServer: server });
      expect(got.at(-1)).toBe('prompt');
      const at = got.indexOf('--mcp-config');
      expect(JSON.parse(got[at + 1]).mcpServers.onset.args).toContain('renderer');
      expect(got[at + 2].startsWith('--')).toBe(true);
      const settings = JSON.parse(got[got.indexOf('--settings') + 1]);
      expect(settings.permissions.allow).toContain('mcp__onset');
    });

    it('attaches to codex, qoder, codebuddy and opencode renderers', () => {
      const codex = rendererInvocation('codex', 'prompt', false, { toolsServer: server });
      expect(codex).toContain('mcp_servers.onset.command="/app/bin/onset"');
      expect(codex.at(-1)).toBe('prompt');
      const qoder = rendererInvocation('qoder', 'prompt', false, { toolsServer: server });
      expect(qoder.slice(qoder.indexOf('--allowed-tools'), qoder.indexOf('--allowed-tools') + 2)).toEqual(['--allowed-tools', 'mcp__onset']);
      const qoderSettings = JSON.parse(qoder[qoder.indexOf('--settings') + 1]);
      expect(qoderSettings.mcp).toEqual({ lazyLoad: false });
      expect(qoderSettings.permissions.allow).toContain('mcp__onset');
      expect(rendererInvocation('codebuddy', 'prompt', false, { toolsServer: server })).toContain('--mcp-config');
      const env = rendererEnv('opencode', { toolsServer: server }, { OPENCODE_CONFIG_CONTENT: '{"model":"x"}' });
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({ model: 'x', mcp: { onset: { type: 'local', command: ['/app/bin/onset', 'studio', 'tools-mcp', '--profile', 'renderer', '--workdir', '/proj/scenes/s1'], enabled: true, environment: server.env } } });
    });

    // qoder 缺省懒加载 MCP，审批工具不进工具表，--permission-prompt-tool 就找不到它（2026-11 实测）。
    it('keeps qoder from lazy-loading the approval and tools servers', () => {
      const permissionPrompt = { command: '/app/onset', args: ['studio', 'permission-mcp'], server: 'onset_studio' };
      const { argv } = orchestratorInvocation('qoder', { prompt: 'hello', permissionPrompt, toolsServer: server });
      expect(JSON.parse(argv[argv.indexOf('--settings') + 1])).toEqual({ mcp: { lazyLoad: false } });
      expect(argv.indexOf('--settings')).toBeLessThan(argv.indexOf('--mcp-config'));
      expect(argv[argv.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__onset_studio__ask');
      // 没有任何 MCP 服务时不加。
      expect(orchestratorInvocation('qoder', { prompt: 'hello' }).argv).not.toContain('--settings');
    });

    it('sits next to the approval server for the claude orchestrator', () => {
      const permissionPrompt = { command: '/app/onset', args: ['studio', 'permission-mcp'], server: 'onset_studio' };
      const { argv } = orchestratorInvocation('claude', { prompt: 'hello', workdir: '/p', permissionPrompt, toolsServer: server });
      const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
      expect(Object.keys(config.mcpServers)).toEqual(['onset_studio', 'onset']);
      expect(JSON.parse(argv[argv.indexOf('--settings') + 1]).permissions.allow).toContain('mcp__onset');
      expect(argv.at(-1)).toBe('hello');
      // 没有审批服务（不安全模式）也挂上工具服务，提示词照样是最后一个。
      const unsafe = orchestratorInvocation('claude', { prompt: 'hello', unsafe: true, toolsServer: server }).argv;
      expect(unsafe).toContain('--mcp-config');
      expect(unsafe.at(-1)).toBe('hello');
      expect(orchestratorInvocation('codex', { prompt: 'p', workdir: '/p', toolsServer: server }).argv).toContain('mcp_servers.onset.command="/app/bin/onset"');
    });
  });

  // 不安全模式已经跳过全部权限检查，不需要也不应该再叠一层 settings。
  it('claude renderer unsafe mode skips settings', () => {
    expect(rendererInvocation('claude', 'prompt', true, { commands: ['ls'] })).not.toContain('--settings');
  });

  // 客户端里 claude 遇到白名单外的调用时交给 onset studio permission-mcp 去问用户；--mcp-config 后面紧跟选项，
  // 不会把提示词当成第二份配置吞进去。不安全模式、其他工具、没给审批服务时都不加。
  it('routes claude permission prompts to the studio approver', () => {
    const permissionPrompt = { command: '/app/onset', args: ['studio', 'permission-mcp'], server: 'onset_studio' };
    const { argv } = orchestratorInvocation('claude', { prompt: 'hello', workdir: '/p', permissionPrompt });
    const at = argv.indexOf('--mcp-config');
    expect(at).toBeGreaterThan(0);
    expect(JSON.parse(argv[at + 1])).toEqual({ mcpServers: { onset_studio: { command: '/app/onset', args: ['studio', 'permission-mcp'] } } });
    expect(argv.slice(at + 2, at + 6)).toEqual(['--permission-prompt-tool', 'mcp__onset_studio__ask', '--permission-prompts', 'host']);
    expect(argv[argv.length - 1]).toBe('hello');
    expect(orchestratorInvocation('claude', { prompt: 'hello', unsafe: true, permissionPrompt }).argv).not.toContain('--mcp-config');
    expect(orchestratorInvocation('codebuddy', { prompt: 'hello', permissionPrompt }).argv).not.toContain('--mcp-config');
    // qoder 认同一个（帮助里没列的）参数，没有 --permission-prompts。
    const qoder = orchestratorInvocation('qoder', { prompt: 'hello', permissionPrompt }).argv;
    const q = qoder.indexOf('--mcp-config');
    expect(q).toBeGreaterThan(0);
    expect(qoder.slice(q + 2, q + 4)).toEqual(['--permission-prompt-tool', 'mcp__onset_studio__ask']);
    expect(qoder).not.toContain('--permission-prompts');
    expect(orchestratorInvocation('qoder', { prompt: 'hello', unsafe: true, permissionPrompt }).argv).not.toContain('--mcp-config');
    expect(orchestratorInvocation('claude', { prompt: 'hello' }).argv).not.toContain('--permission-prompts');
  });
});
