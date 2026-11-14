import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';
import { buildBlocks } from '../src/renderer/components/chat/model.ts';

function eventsForTurn(events, turn = 'tools-turn') {
  return events.map((event, i) => ({ ...event, seq: i + 1, turn_id: turn, time: new Date(Date.UTC(2026, 10, 15, 0, 0, i)).toISOString() }));
}

test('streamed thoughts show activity immediately and join without breaking whitespace across notices', () => {
  const events = eventsForTurn([
    { kind: 'turn-start', status: 'running' },
    { kind: 'thinking', text_id: 'thought-1', text: 'Checking Code' },
    { kind: 'notice', text: '状态提示' },
    { kind: 'thinking', text_id: 'thought-1', text: 'Buddy\n' },
    { kind: 'thinking', text_id: 'thought-1', text: ' 继续分析' },
  ]);
  const initial = buildBlocks(events.slice(0, 2))[0];
  expect(initial.state).toBe('thinking');
  expect(initial.process).toHaveLength(1);
  const turn = buildBlocks(events)[0];
  const thoughts = turn.process.filter(item => item.type === 'thinking');
  expect(thoughts).toHaveLength(1);
  expect(thoughts[0].event.text).toBe('Checking CodeBuddy\n 继续分析');
  expect(thoughts[0].event.time).toBe(events[1].time);
  expect(buildBlocks(events)[0].process).toEqual(turn.process);
  expect(events[1].text).toBe('Checking Code');
  const prior = eventsForTurn([{ kind: 'thinking', text_id: 'thought-1', text: 'Checking Code' }], 'previous-turn');
  const resumed = buildBlocks([...prior, ...events]);
  expect(resumed[1].process.find(item => item.type === 'thinking').event.text).toBe('Checking CodeBuddy\n 继续分析');
});

test('an ACP second turn displays ongoing thoughts before any tool call, including after reload', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#agent-tool').selectOption('opencode');
  await page.locator('#prompt').fill('简短回复测试');
  await page.locator('#send').click();
  await expect(page.locator('.done-line')).toBeVisible();
  await page.locator('#prompt').fill('长思考挂起');
  await page.locator('#send').click();
  const thinking = page.locator('.shell.thinking');
  await expect(thinking).toBeVisible();
  await expect(thinking).not.toContainText('正在启动 AI');
  await expect(thinking.locator('.thinking-body')).toHaveText('正在核对 CodeBuddy 的第二轮上下文。');
  await expect(thinking.locator('.thinking-row')).toHaveCount(1);
  await expect(thinking.locator('.tool.running')).toHaveCount(0);
  await page.reload();
  await expect(thinking.locator('.thinking-body')).toHaveText('正在核对 CodeBuddy 的第二轮上下文。');
  await expect(page.locator('#messages')).not.toContainText('这是历史，不该出现');
  await page.locator('#cancel-turn').click();
  await expect(page.locator('.pause-line')).toBeVisible();
});

// CodeBuddy 先发空 rawInput 的 tool_call，参数齐了再用同一编号发一次 tool_call。
const calls = eventsForTurn([
  { kind: 'turn-start', status: 'running' },
  { kind: 'tool-call', tool: 'Bash', call_id: 'a', input: {} },
  { kind: 'notice', text: '已自动允许：pwd' },
  { kind: 'tool-call', tool: 'shell', call_id: 'a', input: { command: 'pwd' } },
  { kind: 'tool-call', tool: 'Bash', call_id: 'b', input: {} },
  { kind: 'tool-call', tool: 'shell', call_id: 'b', input: { command: 'pwd' } },
  { kind: 'tool-result', tool: 'shell', call_id: 'a', text: '/project' },
  { kind: 'tool-result', tool: 'shell', call_id: 'b', text: 'denied', is_error: true },
]);

test('tool updates replace their own row while independent calls keep their state and start time', () => {
  const turn = buildBlocks(calls.slice(0, 6))[0];
  const tools = turn.process.filter(item => item.type === 'tool');
  expect(tools).toHaveLength(2);
  expect(tools.map(item => item.call.input)).toEqual([{ command: 'pwd' }, { command: 'pwd' }]);
  expect(tools.map(item => item.call.time)).toEqual([calls[1].time, calls[4].time]);
  expect(tools.map(item => item.call.seq)).toEqual([calls[1].seq, calls[4].seq]);
  expect(turn.process.map(item => item.type)).toEqual(['tool', 'note', 'tool']);
  const partial = buildBlocks(calls.slice(0, 7))[0].process.filter(item => item.type === 'tool');
  expect(partial[0].result.text).toBe('/project');
  expect(partial[1].result).toBeUndefined();
  const complete = buildBlocks(calls)[0].process.filter(item => item.type === 'tool');
  expect(complete).toHaveLength(2);
  expect(complete.every(item => item.result)).toBe(true);
  expect(complete[1].result.is_error).toBe(true);
});

test('late tool details keep the result and matching ids in other turns remain separate', () => {
  const late = { ...calls[3], seq: 9, time: '2026-11-15T00:00:09Z' };
  const next = eventsForTurn([{ kind: 'tool-call', tool: 'shell', call_id: 'a', input: { command: 'ls' } }], 'next-turn');
  const turns = buildBlocks([...calls, late, ...next]);
  const first = turns[0].process.filter(item => item.type === 'tool');
  expect(first).toHaveLength(2);
  expect(first[0].result.text).toBe('/project');
  expect(turns[1].process).toHaveLength(1);
  expect(turns[1].process[0].result).toBeUndefined();
});

test('reopening CodeBuddy history shows one finished row per call without leftover execution spinners', async ({ page, project }) => {
  // 这里只重放历史，不让模型下拉框启动开发机上真正的 CodeBuddy。
  const isolateModels = () => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => String(input).includes('/api/agents/codebuddy/models')
      ? Promise.resolve(new Response(JSON.stringify({ tool: 'codebuddy', models: [] }), { headers: { 'Content-Type': 'application/json' } }))
      : original(input, init);
  };
  await page.addInitScript(isolateModels);
  await page.evaluate(isolateModels);
  const id = 'codebuddy-tools';
  const dir = path.join(project.path, 'production/studio/sessions');
  const events = [...calls, ...eventsForTurn([
    { kind: 'text', text: '命令执行完毕。' },
    { kind: 'turn-end', status: 'succeeded' },
  ]).map((event, i) => ({ ...event, seq: calls.length + i + 1, time: '2026-11-15T00:00:10Z' }))];
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({
    session_id: id, title: 'CodeBuddy 工具状态', kind: 'chat', tool: 'codebuddy',
    created_at: calls[0].time, updated_at: events.at(-1).time, turns: ['tools-turn'],
  }));
  await fs.writeFile(path.join(dir, `${id}.events.jsonl`), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  await openProject(page, project);
  await page.locator('#history').click();
  await page.locator('.history-row', { hasText: 'CodeBuddy 工具状态' }).click();
  for (let pass = 0; pass < 2; pass++) {
    await expect(page.locator('#messages')).toContainText('命令执行完毕');
    await page.locator('.shell > summary').click();
    await expect(page.locator('.tool')).toHaveCount(2);
    await expect(page.locator('.tool.running')).toHaveCount(0);
    await expect(page.locator('.tool.done')).toContainText('pwd');
    await expect(page.locator('.tool.failed')).toContainText('denied');
    if (pass === 0) await page.reload();
  }
});
