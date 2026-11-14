import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { interactiveInvocation } from '../tools';
import { ACPTranslator, CodebuddyUsage, acpOutcome, acpPermissionTool, acpUsage, runACP } from './acp';
import { codexDecision, codexItemEvents, runCodexApp } from './codexapp';
import { commandAllowed, unwrapShell, type PermissionAnswer } from './interactive';
import { KindError, KindPlan, KindSession, KindText, KindThinking, KindToolCall, KindToolResult, KindUsage, type Event } from './parse';
import type { Spec } from './run';

const testdata = path.join(__dirname, 'testdata');

/** 用假编排工具（node 脚本）跑一轮，记下事件与审批请求。 */
async function fakeRun(kind: 'acp' | 'codex', prompt: string, answer: PermissionAnswer, extra: Partial<Spec> = {}, signal?: AbortSignal, env: Record<string, string> = {}) {
  const events: Event[] = [];
  const asked: Array<{ toolName: string; input: unknown }> = [];
  const raw: string[] = [];
  const spec: Spec = {
    tool: kind === 'acp' ? 'opencode' : 'codex',
    workdir: fs.mkdtempSync(path.join(os.tmpdir(), 'onset-fake-agent-')),
    prompt,
    access: { commands: ['ls'], writableDirs: ['/tmp/onset-memory'] },
    lookPath: () => process.execPath,
    raw: { write: (line: string) => raw.push(line) },
    ask: async (toolName, input) => {
      asked.push({ toolName, input });
      return answer;
    },
    ...extra,
  };
  const script = path.join(testdata, kind === 'acp' ? 'fake-acp.mjs' : 'fake-codex-app.mjs');
  const env2 = { ...(process.env as Record<string, string>), ...env };
  const run = kind === 'acp' ? runACP : runCodexApp;
  const outcome = await run(spec, (e) => events.push(e), signal, ['node', script], env2);
  return { outcome, events, asked, raw };
}

const kinds = (events: Event[]) => events.map((e) => e.kind);

describe('interactive orchestrators', () => {
  it('unwraps shell wrappers and matches the allowlist', () => {
    expect(unwrapShell("/bin/zsh -lc 'npm install three'")).toBe('npm install three');
    expect(unwrapShell('bash -c "ls -la"')).toBe('ls -la');
    expect(unwrapShell('ls')).toBe('ls');
    expect(commandAllowed("/bin/zsh -lc 'ls -la'", ['ls'])).toBe(true);
    expect(commandAllowed('lsof', ['ls'])).toBe(false);
    expect(commandAllowed('ls | sh', ['ls']), '带管道的整条命令不能凭第一个词放行').toBe(false);
  });

  // 只有客户端里、安全模式下才换协议；claude、qoder 照旧走审批 MCP。
  it('picks the interactive protocol per tool', () => {
    expect(interactiveInvocation('codex', {})?.argv).toEqual(['codex', 'app-server']);
    expect(interactiveInvocation('codebuddy', { access: { commands: ['onset'] } })?.argv.slice(0, 4)).toEqual(['codebuddy', '--acp', '--permission-mode', 'acceptEdits']);
    const oc = interactiveInvocation('opencode', {}, { OPENCODE_CONFIG_CONTENT: '{"model":"x/y","permission":{"edit":"allow"}}' })!;
    expect(oc.argv).toEqual(['opencode', 'acp']);
    expect(JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT), '保留用户自己的配置，只把 bash 设成 ask').toEqual({ model: 'x/y', permission: { edit: 'allow', bash: 'ask' } });
    expect(interactiveInvocation('codex', { unsafe: true })).toBeNull();
    expect(interactiveInvocation('claude', {})).toBeNull();
    expect(interactiveInvocation('qoder', {})).toBeNull();
  });

  it('translates ACP updates, permissions and usage', () => {
    expect(acpPermissionTool({ kind: 'execute', title: 'Show version', rawInput: { command: 'brew --version' } })).toEqual({
      toolName: 'Bash',
      input: { command: 'brew --version', description: 'Show version' },
    });
    expect(acpPermissionTool({ kind: 'edit', title: 'Edit a.txt', rawInput: { path: 'a.txt' } })).toEqual({ toolName: 'Edit a.txt', input: { path: 'a.txt' } });
    const options = [
      { optionId: 'o', kind: 'allow_once' },
      { optionId: 'a', kind: 'allow_always' },
      { optionId: 'r', kind: 'reject_once' },
    ];
    expect(acpOutcome(options, { decision: 'always' }), '「以后都允许」由客户端记，不让对方写进它的配置').toEqual({ outcome: { outcome: 'selected', optionId: 'o' } });
    expect(acpOutcome(options, { decision: 'expired' })).toEqual({ outcome: { outcome: 'selected', optionId: 'r' } });
    expect(acpOutcome([], { decision: 'allow' })).toEqual({ outcome: { outcome: 'cancelled' } });

    const events: Event[] = [];
    const t = new ACPTranslator((e) => events.push(e));
    t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你' } });
    t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } });
    t.update({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
    t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'failed', rawOutput: { output: 'boom' } });
    t.update({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'weird' }] });
    t.flush();
    expect(events).toEqual([
      { kind: KindText, text: '你好' },
      { kind: KindToolCall, tool: 'shell', call_id: 'x', input: { command: 'ls' } },
      { kind: KindToolResult, tool: 'shell', call_id: 'x', text: 'boom', is_error: true },
      { kind: KindPlan, plan: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }] },
    ]);
    expect(acpUsage({ inputTokens: 6, outputTokens: 135, cachedReadTokens: 22544, cachedWriteTokens: 26519 })).toMatchObject({
      input_tokens: 49069,
      cached_input_tokens: 22544,
      output_tokens: 135,
      basis: 'total-input',
    });
    expect(acpUsage({})).toBeNull();

    const cb = new CodebuddyUsage();
    const meta = (id: string, prompt: number) => ({ _meta: { 'codebuddy.ai/messageId': id, usage: { prompt_tokens: prompt, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } } } });
    cb.add({ _meta: { 'codebuddy.ai/requestId': 'r' } });
    cb.add(meta('m1', 100));
    cb.add(meta('m1', 100));
    cb.add(meta('m2', 50));
    expect(cb.total(), '同一条消息推好几次只算一次').toMatchObject({ input_tokens: 150, output_tokens: 20, cached_input_tokens: 10, turns: 2 });
  });

  it('translates codex app-server items', () => {
    expect(codexItemEvents('started', { type: 'commandExecution', id: 'c', command: "/bin/bash -lc 'ls'" })).toEqual([{ kind: KindToolCall, tool: 'shell', call_id: 'c', input: { command: 'ls' } }]);
    expect(codexItemEvents('completed', { type: 'commandExecution', id: 'c', aggregatedOutput: 'x', exitCode: 2 })[0]).toMatchObject({ kind: KindToolResult, is_error: true });
    expect(codexItemEvents('completed', { type: 'reasoning', id: 'r', summary: ['想'], content: [] })).toEqual([{ kind: KindThinking, text: '想' }]);
    expect(codexItemEvents('started', { type: 'agentMessage', id: 'a', text: 'x' })).toEqual([]);
    expect(codexDecision({ decision: 'always' })).toBe('accept');
    expect(codexDecision({ decision: 'deny' }), '拒绝用 decline：codex 接着这一轮换做法').toBe('decline');
  });

  // 一整轮 ACP：建会话、攒正文、问审批、发工具结果与用量；不是 JSON 的行忽略。
  it('runs an ACP turn and asks before commands outside the allowlist', async () => {
    const { outcome, events, asked } = await fakeRun('acp', '装一下', { decision: 'allow' });
    expect(outcome.error).toBeNull();
    expect(outcome.result).toMatchObject({ sessionID: 'ses_fake', model: 'fake/model-1', started: true, produced: true });
    expect(asked).toEqual([{ toolName: 'Bash', input: { command: 'npm install three', description: undefined } }]);
    expect(kinds(events)).toEqual([KindSession, KindThinking, KindText, KindPlan, KindToolCall, KindToolResult, KindText, KindUsage, 'done']);
    expect(events.find((e) => e.kind === KindThinking)!.text).toBe('想一想');
    expect(events.find((e) => e.kind === KindUsage)!.usage).toMatchObject({ input_tokens: 130, cached_input_tokens: 100, output_tokens: 5 });
  });

  // 白名单里的命令不问；拒绝后对方结束这一轮时，对话里说明为什么停了。
  it('skips asking for allowlisted commands and explains a stop after a denial', async () => {
    const allowed = await fakeRun('acp', '装一下', { decision: 'deny' }, { access: { commands: ['npm install'] } });
    expect(allowed.asked, '白名单里的命令不该来问').toEqual([]);
    expect(kinds(allowed.events)).toContain(KindToolResult);
    const denied = await fakeRun('acp', '装一下', { decision: 'deny' });
    expect(denied.outcome.error).toBeNull();
    expect(denied.events.find((e) => e.kind === KindError)?.text).toContain('你拒绝了一条调用');
  });

  // 续接：会话照旧，对方重放的历史不当成这一轮的事件。
  it('resumes an ACP session without replaying history', async () => {
    const { outcome, events } = await fakeRun('acp', '再来', { decision: 'allow' }, { sessionID: 'ses_old', resume: true });
    expect(outcome.result.sessionID).toBe('ses_old');
    expect(events.some((e) => e.text === '这是历史，不该出现')).toBe(false);
  });

  // 停止：发 session/cancel，等在审批上的一轮也能结束。
  it('cancels an ACP turn', async () => {
    const controller = new AbortController();
    const pending = fakeRun('acp', '挂起', { decision: 'allow' }, { ask: () => new Promise(() => {}) }, controller.signal);
    setTimeout(() => controller.abort(new Error('用户停止')), 300);
    const result = await pending;
    expect(result.outcome.error?.message).toContain('用户停止');
    expect(kinds(result.events)[kinds(result.events).length - 1]).toBe('done');
  });

  // 一整轮 codex app-server：审批策略、沙箱与可写目录随 thread/start 给出；命令去掉 shell 包装再问；
  // 用量扣掉这一轮之前的累计。
  it('runs a codex app-server turn', async () => {
    const { outcome, events, asked, raw } = await fakeRun('codex', '装一下', { decision: 'allow' });
    expect(outcome.error).toBeNull();
    expect(outcome.result).toMatchObject({ sessionID: 'thr_fake', model: 'gpt-fake' });
    expect(asked).toEqual([{ toolName: 'Bash', input: { command: 'npm install three', description: undefined } }]);
    expect(kinds(events)).toEqual([KindSession, KindText, KindPlan, KindToolCall, KindToolResult, KindUsage, 'done']);
    expect(events.find((e) => e.kind === KindUsage)!.usage).toMatchObject({ input_tokens: 80, cached_input_tokens: 60, output_tokens: 8 });
    const start = raw.find((line) => line.includes('"thread/start"'))!;
    expect(JSON.parse(start.slice(2)).params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: { 'sandbox_workspace_write.network_access': true, 'sandbox_workspace_write.writable_roots': ['/tmp/onset-memory'] },
    });
  });

  it('reports a failed codex turn', async () => {
    const { outcome, events } = await fakeRun('codex', '装一下', { decision: 'deny' }, {}, undefined, { FAKE_TURN_FAIL: '1' });
    expect(outcome.error?.message).toBe('模型请求失败');
    expect(events.find((e) => e.kind === KindError)?.text).toBe('模型请求失败');
  });

  it.skipIf(process.platform !== 'win32')('preserves an actual Windows agent process failure', async () => {
    const { outcome } = await fakeRun('codex', '装一下', { decision: 'deny' }, {}, undefined, { FAKE_EXIT_BEFORE_TURN: '1' });
    expect(outcome.result.exitCode).toBe(23);
    expect(outcome.error?.message).toContain('编排工具退出码 23：');
    expect(outcome.error?.message).toContain('agent startup failed');
  });
});
