import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { usageEmpty } from '../tools';
import {
  KindError,
  KindPlan,
  KindSession,
  KindText,
  KindThinking,
  KindToolCall,
  KindToolResult,
  clip,
  eventJSON,
  maxToolOutput,
  newParser,
  type Event,
  type Kind,
  type Parser,
} from './index';

const testdata = path.join(import.meta.dirname, 'testdata');

function parseFixture(tool: string, name: string): [Event[], Parser] {
  const parser = newParser(tool);
  const lines = fs.readFileSync(path.join(testdata, name + '.jsonl'), 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const events: Event[] = [];
  for (const line of lines) events.push(...parser.parse(line));
  return [events, parser];
}

function kinds(events: Event[], kind: Kind): Event[] {
  return events.filter((event) => event.kind === kind);
}

function lastText(events: Event[]): string {
  const texts = kinds(events, KindText);
  return texts.length === 0 ? '' : (texts[texts.length - 1].text ?? '').trim();
}

describe('agentrun parse', () => {
  it.each(['claude', 'qoder', 'codebuddy'])('tracks concurrent %s background tasks through progress and completion', (tool) => {
    const parser = newParser(tool);
    const task = (subtype: string, fields: object) => parser.parse(JSON.stringify({ type: 'system', subtype, ...fields }));
    const first = task('task_started', { task_id: 'a', description: '检查素材', is_backgrounded: true });
    expect(first).toEqual([{ kind: 'background-tasks', background_tasks: [{ id: 'a', description: '检查素材' }] }]);
    expect(eventJSON(first[0]).background_tasks).toEqual([{ id: 'a', description: '检查素材' }]);
    task('task_started', { task_id: 'b', description: '生成配音' });
    expect(task('task_progress', { task_id: 'a', description: '检查素材', summary: '核对图片尺寸', last_tool_name: 'Read' })[0]).toMatchObject({
      background_tasks: [{ id: 'a', description: '检查素材', activity: '核对图片尺寸' }, { id: 'b', description: '生成配音' }],
    });
    expect(task('task_notification', { task_id: 'a', status: 'completed' })[0]).toMatchObject({ background_tasks: [{ id: 'b' }] });
    const end = task('task_notification', { task_id: 'b', status: 'failed' })[0];
    expect(eventJSON(end).background_tasks).toEqual([]);
  });

  it('handles foreground transitions, ambient tasks, snapshots and resumed task runs', () => {
    const parser = newParser('claude');
    const task = (subtype: string, fields: object) => parser.parse(JSON.stringify({ type: 'system', subtype, ...fields }))[0];
    expect(task('task_started', { task_id: 'a', description: '前台', is_backgrounded: false })).toMatchObject({ background_tasks: [] });
    expect(task('task_progress', { task_id: 'a', description: '前台' })).toMatchObject({ background_tasks: [] });
    expect(task('task_updated', { task_id: 'a', patch: { is_backgrounded: true } })).toMatchObject({ background_tasks: [{ id: 'a' }] });
    expect(task('task_updated', { task_id: 'a', patch: { status: 'killed' } })).toMatchObject({ background_tasks: [] });
    task('task_started', { task_id: 'watch', description: '内部监控', ambient: true });
    expect(task('task_progress', { task_id: 'watch', description: '内部监控' })).toMatchObject({ background_tasks: [] });
    task('task_started', { task_id: 'a', run_id: '02', description: '重新检查' });
    expect(task('task_notification', { task_id: 'a', run_id: '01', status: 'completed' })).toMatchObject({ background_tasks: [{ id: 'a' }] });
    expect(task('background_tasks_changed', { tasks: [{ task_id: 'b', description: '配音' }, { task_id: 'watch', ambient: true }] })).toMatchObject({ background_tasks: [{ id: 'b', description: '配音' }] });
    expect(task('background_tasks_changed', { tasks: [] })).toMatchObject({ background_tasks: [] });
    expect(task('task_started', { task_id: 1 })).toBeUndefined();
    expect(task('background_tasks_changed', { tasks: null })).toBeUndefined();
    expect(task('init', {})).toBeUndefined();
  });

  // 每份 fixture 都是同一个两轮脚本：第一轮记住 PELICAN、创建 note.txt、回复 OK；
  // 第二轮续接后问单词。第二轮答对，说明续接拿到了第一轮的上下文。
  describe('recorded streams', () => {
    const tests = [
      { tool: 'claude', first: 'claude-1', second: 'claude-2', session: 'a3dc268c-4696-4ac3-9e12-b3b8c18ba703', writeTool: 'Write' },
      { tool: 'codex', first: 'codex-1', second: 'codex-2', session: '01a19706-15cc-7c23-92b3-d0008785ee57', writeTool: 'shell' },
      { tool: 'qoder', first: 'qoder-1', second: 'qoder-2', session: 'c43bb3cd-ea41-495e-8fac-2517596a2fd5', writeTool: 'Write' },
      { tool: 'opencode', first: 'opencode-1', second: 'opencode-2', session: 'ses_e68f70edcffeGdFO8OOw9sCE5o', writeTool: 'patch' },
    ];
    for (const test of tests) {
      it(test.tool, () => {
        const [first, parser] = parseFixture(test.tool, test.first);
        const sessions = kinds(first, KindSession);
        // 会话事件应只出现一次且 id 正确。
        expect(sessions).toHaveLength(1);
        expect(sessions[0].session_id).toBe(test.session);
        expect(parser.sessionID()).toBe(test.session);
        // 会话 id 要最先发出，调用方要立刻落盘。
        expect(first[0].kind).toBe(KindSession);
        const found = kinds(first, KindToolCall).some((call) => call.tool === test.writeTool && call.call_id && call.input !== undefined);
        expect(found, `没有译出 ${test.writeTool} 工具调用`).toBe(true);
        expect(kinds(first, KindToolResult).length).toBeGreaterThan(0);
        expect(lastText(first)).toContain('OK');
        const [second, parser2] = parseFixture(test.tool, test.second);
        // 续接后会话 id 不变。
        expect(parser2.sessionID()).toBe(test.session);
        expect(lastText(second)).toBe('PELICAN');
        // 成功的流不应译出错误。
        expect(kinds(second, KindError)).toHaveLength(0);
      });
    }
  });

  it('recorded streams carry usage', () => {
    for (const [tool, name] of Object.entries({ claude: 'claude-1', codex: 'codex-1', qoder: 'qoder-1', opencode: 'opencode-1' })) {
      const [, parser] = parseFixture(tool, name);
      const usage = parser.usage();
      // qoder 按积分计费，token 字段实测全为 0，只能确认读到了用量事件。
      expect(usageEmpty(usage), tool).toBe(false);
      if (tool !== 'qoder') expect((usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0), tool).toBeGreaterThan(0);
    }
  });

  // qoder 在 dont_ask 下拒绝写文件，工具结果带 is_error。
  it('tool result errors survive', () => {
    const [events] = parseFixture('qoder', 'qoder-1');
    const failed = kinds(events, KindToolResult).filter((event) => event.is_error && (event.text ?? '').includes('approval'));
    expect(failed.length).toBeGreaterThan(0);
  });

  // qoder 经 mcp_call 调 MCP 工具（2026-11 实测的流）：要拆成真正的工具名与参数。
  it('qoder mcp_call is unwrapped', () => {
    const parser = newParser('qoder');
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 's',
      message: { content: [{ type: 'tool_use', id: 'call_1', name: 'mcp_call', input: { toolName: 'mcp__onset__studio_step', arguments: { step: 'script' } } }] },
    });
    const [call] = kinds(parser.parse(line), KindToolCall);
    expect(call.tool).toBe('mcp__onset__studio_step');
    expect(call.input).toEqual({ step: 'script' });
    const listing = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call_2', name: 'mcp_list', input: {} }] } });
    expect(kinds(parser.parse(listing), KindToolCall)[0].tool).toBe('mcp_list');
  });

  // qoder 与新版 claude 逐条建任务（编号只在结果里）、逐条改，要攒成完整清单（2026-11 qoder 实测的写法）。
  it('task tools build a plan', () => {
    const call = (id: string, name: string, input: unknown) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    const result = (id: string, text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
    const plans = (parser: Parser, lines: string[]) => lines.flatMap((line) => kinds(parser.parse(line), KindPlan));
    const parser = newParser('qoder');
    const created = plans(parser, [
      call('c1', 'TaskCreate', { subject: '写口播终稿', activeForm: '写口播稿', description: '…' }),
      call('c2', 'TaskCreate', { subject: '生成配音', activeForm: '生成配音中' }),
      result('c1', 'Task #1 created successfully: 写口播终稿'),
      result('c2', 'Task #2 created successfully: 生成配音'),
    ]);
    expect(created.at(-1)?.plan).toEqual([
      { text: '写口播终稿', status: 'pending', id: '1' },
      { text: '生成配音', status: 'pending', id: '2' },
    ]);
    const updated = plans(parser, [call('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' })]);
    expect(updated.at(-1)?.plan?.[0]).toEqual({ text: '写口播稿', status: 'in_progress', id: '1' });

    // 下一轮续接同一个会话：新的解析器接上上一轮的清单，才认得 TaskUpdate 的编号。
    const next = newParser('qoder');
    next.seedPlan(updated.at(-1)?.plan ?? []);
    const resumed = plans(next, [call('u2', 'TaskUpdate', { taskId: '1', status: 'completed' }), call('u3', 'TaskUpdate', { taskId: '2', status: 'in_progress' })]);
    expect(resumed.at(-1)?.plan?.map((item) => item.status)).toEqual(['completed', 'in_progress']);
    // 不认识的编号不出清单；删掉的去掉。
    expect(plans(newParser('qoder'), [call('u4', 'TaskUpdate', { taskId: '9', status: 'completed' })])).toEqual([]);
    expect(plans(next, [call('u5', 'TaskUpdate', { taskId: '1', status: 'deleted' })]).at(-1)?.plan?.map((item) => item.id)).toEqual(['2']);
  });

  // codebuddy 本机未登录，只录到 401：结果事件 is_error 要译成错误。
  it('codebuddy error stream', () => {
    const [events, parser] = parseFixture('codebuddy', 'codebuddy-1');
    expect(parser.sessionID()).toBe('65dd779c-9206-4cc8-8c23-1187b780efc4');
    expect(kinds(events, KindError)).toHaveLength(1);
    // 正文应保留 401 原文。
    expect(lastText(events)).toContain('401');
  });

  it('parser ignores noise', () => {
    const parser = newParser('claude');
    for (const line of ['', 'not json', `{"type":"rate_limit_event"}`, `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]}}`]) {
      expect(parser.parse(line), line).toEqual([]);
    }
    // 未知工具应当报错。
    expect(() => newParser('bad')).toThrow();
  });

  it('codex failure events', () => {
    const parser = newParser('codex');
    const events = [
      ...parser.parse(`{"type":"turn.failed","error":{"message":"boom"}}`),
      ...parser.parse(`{"type":"error","message":"stream closed"}`),
      ...parser.parse(`{"type":"item.completed","item":{"id":"i","type":"command_execution","aggregated_output":"x","exit_code":2}}`),
      ...parser.parse(`{"type":"item.completed","item":{"id":"j","type":"file_change","status":"failed"}}`),
      ...parser.parse(`{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}`),
    ];
    expect(kinds(events, KindError)).toHaveLength(2);
    expect(kinds(events, KindThinking)).toHaveLength(1);
    // 非零退出码与失败的改动都应标错。
    for (const result of kinds(events, KindToolResult)) expect(result.is_error).toBe(true);
  });

  it('opencode error and reasoning', () => {
    const parser = newParser('opencode');
    const events = [
      ...parser.parse(`{"type":"error","sessionID":"ses_1","error":{"data":{"message":"quota"}}}`),
      ...parser.parse(`{"type":"reasoning","sessionID":"ses_1","part":{"text":"think"}}`),
      ...parser.parse(`{"type":"tool_use","sessionID":"ses_1","part":{"id":"c","tool":"bash","state":{"status":"error","error":"denied"}}}`),
    ];
    expect(kinds(events, KindSession)).toHaveLength(1);
    expect(kinds(events, KindError)[0].text).toBe('quota');
    expect(kinds(events, KindThinking)).toHaveLength(1);
    const results = kinds(events, KindToolResult);
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBe(true);
  });

  it('clip keeps UTF-8 boundaries', () => {
    const clipped = clip('镜'.repeat(maxToolOutput));
    expect(clipped.endsWith('（已截断）')).toBe(true);
    expect(clipped.startsWith('镜')).toBe(true);
    // 截断不能切坏 UTF-8。
    expect(clipped).not.toContain('�');
    // 短文本不应改动。
    expect(clip('short')).toBe('short');
  });

  // 三家的待办清单译成同一种 plan 事件，进行中的项用 activeForm。
  it('plans are unified', () => {
    const cases = [
      ['claude', `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"TodoWrite","input":{"todos":[{"content":"写分镜","status":"completed","activeForm":"写分镜中"},{"content":"渲染镜头","status":"in_progress","activeForm":"正在渲染镜头"},{"content":"拼接","status":"pending","activeForm":"拼接中"}]}}]}}`],
      ['codex', `{"type":"item.updated","item":{"id":"i1","type":"todo_list","items":[{"text":"写分镜","completed":true},{"text":"正在渲染镜头","completed":false},{"text":"拼接","completed":false}]}}`],
      ['opencode', `{"type":"tool_use","sessionID":"s","part":{"id":"p1","tool":"todowrite","state":{"status":"completed","input":{"todos":[{"content":"写分镜","status":"completed"},{"content":"正在渲染镜头","status":"in_progress"},{"content":"拼接","status":"pending"}]},"output":"ok"}}}`],
    ];
    for (const [tool, line] of cases) {
      const plans = kinds(newParser(tool).parse(line), KindPlan);
      expect(plans, tool).toHaveLength(1);
      const got = plans[0].plan!;
      expect(got, tool).toHaveLength(3);
      expect(got[0].status).toBe('completed');
      expect(got[1].status).toBe('in_progress');
      expect(got[1].text).toBe('正在渲染镜头');
      expect(got[2].status).toBe('pending');
    }
  });
});
