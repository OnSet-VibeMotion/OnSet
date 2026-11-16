// 进度卡片怎么说、什么时候显示：纯函数，不开客户端（原来写在 e2e/chat-progress.spec.mjs 里）。
import { expect, test } from 'vitest';
import { buildBlocks } from './model.ts';
import { showProgressCard, suggestStop, turnActivity, waitingOnRender } from './activity.ts';

const start = Date.parse('2026-11-15T00:00:00Z');
function activity(rows, now = start + 70000, asks = []) {
  const events = [{ kind: 'turn-start' }, ...rows].map((event, seq) => ({
    seq, turn_id: 'current', time: new Date(start + seq * 1000).toISOString(), ...event,
  }));
  const turn = buildBlocks(events).find(block => block.kind === 'turn');
  return turnActivity(turn, events, asks, now);
}
const read = { kind: 'tool-call', call_id: 'read', tool: 'Read', input: { file_path: 'scenes/scene-010/prompt.md' } };
const done = { kind: 'tool-result', call_id: 'read', text: 'done' };

test('compaction stays visible during silence and only confirmed boundaries say completed', () => {
  const compact = { kind: 'context-compaction', compaction: { state: 'running' }, text: '正在压缩上下文' };
  expect(activity([read, done, compact, { kind: 'notice', text: '状态更新' }], start + 180000)).toMatchObject({
    phase: 'compacting', label: '正在压缩上下文', since: new Date(start + 3000).toISOString(), quiet: true,
  });
  const completed = { ...compact, compaction: { state: 'completed', pre_tokens: 150000, post_tokens: 20000 } };
  expect(activity([compact, completed])).toMatchObject({ phase: 'waiting', label: '上下文压缩完成，等待模型回复' });
  expect(activity([compact, completed]).detail).toContain('150,000 → 20,000');
  expect(activity([compact, { ...compact, compaction: { state: 'ended' } }]).label).toBe('等待模型回复');
  for (const [state, label] of [['failed', '上下文压缩失败'], ['cancelled', '上下文压缩已取消']]) {
    const ended = { ...compact, compaction: { state } };
    expect(activity([compact, ended]).label).toContain(label);
    expect(activity([compact, ended, read]).phase).toBe('tool');
  }
  expect(activity([compact, read]).phase).toBe('tool');
  expect(activity([compact, { kind: 'turn-end', status: 'cancelled' }])).toBeNull();
});

test('completed tools transition to model waiting with an honest last-update time', () => {
  expect(activity([read, done])).toMatchObject({ phase: 'waiting', label: '等待模型回复', completed: 1, failed: 0, quiet: true,
    since: new Date(start + 2000).toISOString(), lastUpdate: new Date(start + 2000).toISOString() });
  expect(activity([read, done]).detail).toContain('scenes/scene-010/prompt.md');
  expect(activity([read, done, { kind: 'queued', text: '补充要求' }]).lastUpdate).toBe(new Date(start + 2000).toISOString());
});

test('a parallel tool finishing does not hide the earlier running operation', () => {
  const state = activity([read, { ...read, call_id: 'other' }, { ...done, call_id: 'other' }]);
  expect(state).toMatchObject({ phase: 'tool', label: '正在执行操作', active: 1, completed: 1 });
  expect(state.detail).toContain('读取');
});

test('approval, background work and streamed output have distinct progress states', () => {
  expect(activity([]).phase).toBe('starting');
  expect(activity([read], undefined, [{ id: 'approval' }]).phase).toBe('permission');
  expect(activity([{ kind: 'background-tasks', background_tasks: [{ id: 'bg', description: '生成配音' }] }]).phase).toBe('background');
  expect(activity([{ kind: 'thinking', text: 'checking', text_id: 't' }], start + 2000).phase).toBe('thinking');
  expect(activity([{ kind: 'text', text: '正在整理' }], start + 2000).phase).toBe('replying');
  expect(activity([{ kind: 'thinking', text: 'checking' }]).phase).toBe('waiting');
  expect(activity([read, { ...done, is_error: true }])).toMatchObject({ completed: 0, failed: 1 });
  for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted']) {
    expect(activity([read, { kind: 'turn-end', status }])).toBeNull();
  }
});

test('waiting on scene rendering leaves progress to the render board', () => {
  const turnOf = (rows) => {
    const events = [{ kind: 'turn-start' }, ...rows].map((event, seq) => ({ seq, turn_id: 'current', time: new Date(start + seq * 1000).toISOString(), ...event }));
    const turn = buildBlocks(events).find(block => block.kind === 'turn');
    return { turn, state: turnActivity(turn, events, [], start + 70000) };
  };
  const call = (id, tool, input = {}) => ({ kind: 'tool-call', call_id: id, tool, input });
  // 等渲染跑完：MCP 前缀、制作人的裸操作名、等渲染任务的 job_wait 都算；有镜头在渲染时不显示这张卡片。
  for (const tool of ['mcp__onset__scene_run_all', 'scene_run', 'mcp__onset__job_wait', 'onset.scene_seams']) {
    const { turn, state } = turnOf([call('r', tool)]);
    expect(state.phase).toBe('tool');
    expect(waitingOnRender(state, turn, 2)).toBe(true);
    // 「镜头制作」卡片还没出来（还没有镜头在渲染）时照常显示。
    expect(waitingOnRender(state, turn, 0)).toBe(false);
  }
  // 同时还有别的操作没跑完、或在等别的操作：照常显示。
  const mixed = turnOf([call('r', 'mcp__onset__scene_run_all'), read]);
  expect(waitingOnRender(mixed.state, mixed.turn, 2)).toBe(false);
  const other = turnOf([call('c', 'mcp__onset__concat')]);
  expect(waitingOnRender(other.state, other.turn, 2)).toBe(false);
  // 等批准不是在等渲染。
  const events = [{ kind: 'turn-start' }, call('r', 'scene_run')].map((event, seq) => ({ seq, turn_id: 'current', time: new Date(start + seq * 1000).toISOString(), ...event }));
  const turn = buildBlocks(events).find(block => block.kind === 'turn');
  expect(waitingOnRender(turnActivity(turn, events, [{ id: 'approval' }], start + 70000), turn, 2)).toBe(false);
});

test('quiet stretches during a running job never suggest stopping', () => {
  // 操作跑完后模型还没回话、或操作还在跑：照实说多久无新消息，不劝用户停。
  expect(suggestStop(activity([read, done], start + 180000))).toBe(false);
  expect(suggestStop(activity([read], start + 180000))).toBe(false);
  expect(suggestStop(activity([read, { ...done, is_error: true }], start + 180000))).toBe(false);
  // 提交后一直没有任何输出、也没执行过操作：才提一句可以停止。
  expect(suggestStop(activity([], start + 180000))).toBe(true);
  expect(suggestStop(activity([], start + 2000))).toBe(false);
});

test('the progress card comes back while the connection is reconnecting, even when waiting on renders', () => {
  const events = [{ kind: 'turn-start' }, { kind: 'tool-call', call_id: 'r', tool: 'mcp__onset__scene_run_all', input: {} }].map((event, seq) => ({ seq, turn_id: 'current', time: new Date(start + seq * 1000).toISOString(), ...event }));
  const turn = buildBlocks(events).find(block => block.kind === 'turn');
  const state = turnActivity(turn, events, [], start + 70000);
  expect(showProgressCard(state, turn, 2, false)).toBe(false);
  // 连接断了：卡片照常出来，说清「正在重连」。
  expect(showProgressCard(state, turn, 2, true)).toBe(true);
  expect(showProgressCard(null, turn, 2, true)).toBe(false);
});
