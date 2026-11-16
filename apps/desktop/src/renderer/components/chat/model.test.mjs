// 一轮里的过程怎么整理：纯函数，不开客户端（原来写在 e2e/chat-tools.spec.mjs 里）。
import { expect, test } from 'vitest';
import { buildBlocks, parseStylePicks, stylePickMessage } from './model.ts';

function eventsForTurn(events, turn = 'tools-turn') {
  return events.map((event, i) => ({ ...event, seq: i + 1, turn_id: turn, time: new Date(Date.UTC(2026, 10, 15, 0, 0, i)).toISOString() }));
}

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

// 风格推荐：只给一段的风格发出的话说「那一段」，不说成整片风格（原来写在 e2e/content.spec.mjs 里）。
const recommended = '推荐两种：\n```film-styles\nlemo-opuscar/impasto 厚涂有分量\nlemo-opuscar/ukiyoe 版画感强\nlemo-opuscar/ink-wash [回忆段，镜头 04–06] 留白像记忆\n```\n```choices\n不用整片风格\n```';

test('film-styles block separates whole-film picks from segment-scoped ones', () => {
  const picks = parseStylePicks(recommended, new Set());
  expect(picks.map(pick => [pick.key, pick.scope, pick.reason])).toEqual([
    ['lemo-opuscar/impasto', '', '厚涂有分量'],
    ['lemo-opuscar/ukiyoe', '', '版画感强'],
    ['lemo-opuscar/ink-wash', '回忆段，镜头 04–06', '留白像记忆'],
  ]);
  expect(picks.every(pick => pick.explicit)).toBe(true);
});

test('a segment-scoped pick is sent as that segment’s style, not the whole film’s', () => {
  const [whole, , scoped] = parseStylePicks(recommended, new Set());
  const sent = stylePickMessage('水墨', scoped);
  expect(sent).toBe('回忆段，镜头 04–06用「水墨」风格（lemo-opuscar/ink-wash），其余镜头不变');
  expect(sent).not.toContain('整片风格');
  expect(stylePickMessage('油画厚涂', whole)).toBe('整片风格用「油画厚涂」（lemo-opuscar/impasto）');
});

test('without a film-styles block, known keys become picks that do not claim the whole film', () => {
  const picks = parseStylePicks('可以试试 lemo-opuscar/impasto，或者 unknown/style。', new Set(['lemo-opuscar/impasto']));
  expect(picks).toEqual([{ key: 'lemo-opuscar/impasto', reason: '', scope: '', explicit: false }]);
  const sent = stylePickMessage('油画厚涂', picks[0]);
  expect(sent).toBe('选「油画厚涂」（lemo-opuscar/impasto）这个风格');
  expect(sent).not.toContain('整片');
});
