import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import * as agentrun from '@am/engine/agentrun';
import * as director from '@am/engine/director';
import * as studioview from '@am/engine/studioview';
import * as tools from '@am/engine/tools';
import { amTools, parseRequest, runBuiltinAgent } from './command';
import { newGate } from './gate';
import { StreamWriter } from './stream';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-agent-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 把输出行交给 agentrun 按 director 解析，拿到统一事件与用量，等于客户端看到的样子。 */
function parse(lines: string[]) {
  const parser = agentrun.newParser('director');
  const events = lines.flatMap((l) => parser.parse(l));
  return { events, usage: parser.usage(), session: parser.sessionID(), model: lines.map((l) => tools.detectModel('director', l)).find((m) => m !== '') ?? '' };
}

describe('StreamWriter', () => {
  it('writes claude-like stream-json that agentrun reads as the director tool', () => {
    const lines: string[] = [];
    const w = new StreamWriter((l) => lines.push(l));
    w.init('s-1', 'deepseek/deepseek-v4-pro');
    w.event({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想一想' },
          { type: 'text', text: '先看稿子' },
          { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.md' } },
        ],
        usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 50, cost: { total: 0.01 } },
        stopReason: 'toolUse',
      },
    });
    w.event({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '正文' }], isError: false } });
    w.event({ type: 'message_update', message: { role: 'assistant' } });
    w.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '好了' }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } } } });
    w.result('');
    const { events, usage, session, model } = parse(lines);
    expect(session).toBe('s-1');
    expect(model).toBe('deepseek/deepseek-v4-pro');
    expect(events.map((e) => [e.kind, e.text ?? e.tool ?? e.session_id])).toEqual([
      ['session', 's-1'],
      ['thinking', '想一想'],
      ['text', '先看稿子'],
      ['tool-call', 'read'],
      ['tool-result', '正文'],
      ['text', '好了'],
    ]);
    // 统一口径：输入含缓存命中与写入。
    expect(usage.input_tokens).toBe(100 + 300 + 50 + 10);
    expect(usage.cached_input_tokens).toBe(300);
    expect(usage.output_tokens).toBe(25);
    expect(usage.turns).toBe(2);
    expect(usage.cost_usd).toBeCloseTo(0.012);
  });

  it('marks the run failed when the model service errors', () => {
    const lines: string[] = [];
    const w = new StreamWriter((l) => lines.push(l));
    w.init('s-2', 'm');
    w.event({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 bad key' } });
    expect(w.error()).toBe('401 bad key');
    w.result(w.error());
    const { events } = parse(lines);
    expect(events.at(-1)).toMatchObject({ kind: 'error', text: '401 bad key' });
  });
});

describe('gate', () => {
  const base = () => ({ workdir: tmp, unsafe: false, commands: ['ls', 'git status'], writableDirs: [], amTools: new Set(['scene_run']), inbox: '', pollInterval: 10 });

  it('allows whitelisted commands, project files and am tools; refuses .env and the rest outside the client', async () => {
    const gate = newGate(base());
    expect(await gate('bash', { command: 'ls -la' }, undefined)).toBeNull();
    expect(await gate('bash', { command: 'git status' }, undefined)).toBeNull();
    expect(await gate('bash', { command: 'ls; rm -rf /' }, undefined)).toMatch(/安全模式/);
    expect(await gate('bash', { command: 'rm -rf scenes' }, undefined)).toMatch(/安全模式/);
    expect(await gate('read', { path: 'production/script.md' }, undefined)).toBeNull();
    expect(await gate('write', { path: path.join(tmp, 'x', 'y.md') }, undefined)).toBeNull();
    expect(await gate('grep', { pattern: 'a' }, undefined)).toBeNull();
    expect(await gate('read', { path: '.env' }, undefined)).toMatch(/凭据/);
    expect(await gate('edit', { path: 'sub/.env.local' }, undefined)).toMatch(/凭据/);
    expect(await gate('read', { path: '.env.example' }, undefined)).toBeNull();
    expect(await gate('read', { path: '../outside.txt' }, undefined)).toMatch(/安全模式/);
    expect(await gate('read', { path: '/etc/passwd' }, undefined)).toMatch(/安全模式/);
    expect(await gate('scene_run', { scene: 'scenes/scene-001' }, undefined)).toBeNull();
    expect(await newGate({ ...base(), unsafe: true })('bash', { command: 'rm -rf /' }, undefined)).toBeNull();
  });

  it('asks the user through the turn inbox and remembers "always" for the rest of the turn', async () => {
    const inbox = path.join(tmp, 'inbox');
    const gate = newGate({ ...base(), inbox });
    const answer = async (decision: studioview.PermissionDecision) => {
      for (;;) {
        const pending = studioview.listPermissionRequests(inbox).filter((r) => !r.answered);
        if (pending.length > 0) {
          studioview.writePermissionResponse(inbox, pending[0]!.request.id, { decision });
          return pending[0]!.request;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const [deny, asked] = await Promise.all([gate('bash', { command: 'npm install foo' }, undefined), answer('deny')]);
    expect(deny).toMatch(/用户拒绝/);
    expect(asked).toMatchObject({ tool_name: 'Bash', command: 'npm install foo', suggestion: 'npm install' });
    const [always] = await Promise.all([gate('bash', { command: 'npm install foo' }, undefined), answer('always')]);
    expect(always).toBeNull();
    // 同一轮里不再问。
    expect(await gate('bash', { command: 'npm install bar' }, undefined)).toBeNull();
  });
});

describe('parseRequest', () => {
  it('rejects malformed requests', () => {
    expect(() => parseRequest('nope')).toThrow(/JSON/);
    expect(() => parseRequest('{"prompt":"x","agent_dir":"d"}')).toThrow(/workdir/);
    expect(() => parseRequest('{"workdir":"w","prompt":"x","agent_dir":"d","resume":true}')).toThrow(/session_id/);
    expect(parseRequest('{"workdir":"w","prompt":"x","agent_dir":"d","commands":["ls",3]}').commands).toEqual(['ls']);
  });
});

describe('amTools', () => {
  it('exposes the orchestrator ops without the job tools or wait_seconds', () => {
    const { tools: list } = amTools();
    const names = list.map((t) => t.name);
    expect(names).toContain('scene_run');
    expect(names).toContain('tool_help');
    expect(names).not.toContain('job_wait');
    for (const t of list) expect(JSON.stringify(t.parameters)).not.toContain('wait_seconds');
  });
});

describe('runBuiltinAgent', () => {
  it('runs a turn with pi, gates tools, keeps the session in the app data dir and resumes it', async () => {
    const workdir = path.join(tmp, 'proj');
    const agentDir = path.join(tmp, 'agent');
    fs.mkdirSync(path.join(workdir, '.agents', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(workdir, '.agents', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n正文\n');
    fs.writeFileSync(path.join(workdir, 'AGENTS.md'), '项目规则：只用中文。\n');
    fs.writeFileSync(path.join(workdir, 'a.txt'), 'hello\n');
    fs.writeFileSync(path.join(workdir, '.env'), 'SECRET=1\n');
    // 上级目录里的 CLAUDE.md 不能被读进来。
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '不该出现的规则\n');

    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm1' }] });
    let systemPrompt = '';
    let seenMessages = 0;
    faux.setResponses([
      (context) => {
        // 系统提示词在上下文的消息里（pi 的 system 消息），整个序列化后查内容即可。
        systemPrompt = JSON.stringify(context);
        return fauxAssistantMessage([fauxText('先读文件'), fauxToolCall('read', { path: 'a.txt' }), fauxToolCall('read', { path: '.env' })], { stopReason: 'toolUse' });
      },
      fauxAssistantMessage([fauxToolCall('bash', { command: 'rm -rf /' }), fauxToolCall('tool_help', { tool: 'scene_run' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('做完了'),
      (context) => {
        seenMessages = context.messages.length;
        return fauxAssistantMessage('接着上次');
      },
    ]);
    const setupModels = async (runtime: unknown) => {
      const r = runtime as { registerNativeProvider(p: unknown): void; setRuntimeApiKey(p: string, k: string): Promise<void> };
      r.registerNativeProvider(faux.provider);
      await r.setRuntimeApiKey('faux', 'x');
      return 'faux/m1';
    };
    const req: director.Request = { workdir, prompt: '读一下 a.txt', agent_dir: agentDir, commands: ['ls'], writable_dirs: [] };
    const lines: string[] = [];
    const result = await runBuiltinAgent(req, (l) => lines.push(l), undefined, { setupModels, env: {} });
    expect(result).toEqual({ ok: true });

    const { events, session, model } = parse(lines);
    expect(model).toBe('faux/m1');
    expect(session).not.toBe('');
    const results = events.filter((e) => e.kind === 'tool-result');
    expect(results.map((e) => e.is_error === true)).toEqual([false, true, true, false]);
    expect(results[0]!.text).toBe('hello\n');
    expect(results[1]!.text).toContain('.env 里是凭据');
    expect(results[2]!.text).toContain('安全模式下不允许命令 rm -rf /');
    expect(results[3]!.text).toContain('scene_run');
    expect(events.filter((e) => e.kind === 'text').map((e) => e.text)).toEqual(['先读文件', '做完了']);

    expect(systemPrompt).toContain('项目规则：只用中文');
    expect(systemPrompt).toContain('demo');
    expect(systemPrompt).not.toContain('不该出现的规则');
    expect(systemPrompt).not.toContain('pi documentation');

    // 会话落在应用数据目录（agent_dir/sessions/<按项目路径编码>/），项目里不留任何会话文件。
    const sessionFiles = (dir: string): string[] =>
      fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((n) => n.endsWith('.jsonl')) : [];
    const stored = sessionFiles(director.sessionsDir(agentDir));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain(session);
    expect(sessionFiles(workdir)).toEqual([]);
    expect(fs.existsSync(path.join(workdir, 'production'))).toBe(false);

    // 项目挪了位置照样能续接，带着上一轮的对话。
    const moved = path.join(tmp, 'moved');
    fs.renameSync(workdir, moved);
    const again: string[] = [];
    const resumed = await runBuiltinAgent({ ...req, workdir: moved, prompt: '继续', session_id: session, resume: true }, (l) => again.push(l), undefined, { setupModels, env: {} });
    expect(resumed).toEqual({ ok: true });
    expect(parse(again).session).toBe(session);
    expect(seenMessages).toBeGreaterThan(4);
  });

  it('fails clearly when no provider has a key', async () => {
    const req: director.Request = { workdir: tmp, prompt: 'x', agent_dir: path.join(tmp, 'agent') };
    await expect(runBuiltinAgent(req, () => {}, undefined, { env: {} })).rejects.toThrow(director.NoModelMessage);
  });
});
