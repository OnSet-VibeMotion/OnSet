// @vitest-environment jsdom
/*
 * 输入框上方常驻的「当前 AI 进度」卡片（ActivityStatus，经 Chat 挂在整个 App 里）：压缩上下文、等模型回复、
 * 重新加载后照旧、断线重连、一轮结束就收起。原来在 e2e/chat-progress.spec.mjs。
 * 时间只换掉 Date（卡片每秒按 Date.now() 刷新计时），其余计时器照常走。
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStudio, turnStart } from './studioHarness';

const progress = () => screen.queryByRole('region', { name: '当前 AI 进度' });
const progressText = () => progress()?.textContent ?? '';

async function send(text: string) {
  const user = userEvent.setup();
  await user.type(document.getElementById('prompt')!, text);
  await user.click(document.getElementById('send')!);
}

/** 让钟往前走 ms：卡片在下一次每秒刷新时按新的时间算「多久没有新消息」。 */
function advanceClock(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
}

describe('ActivityStatus', () => {
  afterEach(() => vi.useRealTimers());

  test('automatic compaction reaches the persistent status and survives a page reload', async () => {
    const studio = createStudio();
    studio.render();
    await screen.findByText('说说要做什么');
    await send('压缩状态回归');
    // Claude 的 system/status compacting 由 agentrun 译成 context-compaction（running）。
    await studio.emit([...turnStart('t1', '压缩状态回归'), { kind: 'context-compaction', turn_id: 't1', text: '正在压缩上下文', compaction: { state: 'running' } }]);
    expect(progressText()).toContain('正在压缩上下文');
    expect(progressText()).toContain('正在整理历史对话');
    studio.remount();
    await waitFor(() => expect(progressText()).toContain('正在压缩上下文'));
    advanceClock(90_000);
    await waitFor(() => expect(progressText()).toContain('无新消息'), { timeout: 3000 });
    expect(progressText()).toContain('正在压缩上下文');
    expect(progressText()).not.toContain('等待模型回复');
    // compact_boundary：压缩成功，带上前后的用量。
    await studio.emit({ kind: 'context-compaction', turn_id: 't1', text: '上下文压缩完成', compaction: { state: 'completed', pre_tokens: 150000, post_tokens: 20000 } });
    expect(progressText()).toContain('上下文压缩完成，等待模型回复');
    expect(progressText()).toContain('150,000 → 20,000');
    // 模型恢复输出、发起新调用：压缩结束。
    await studio.emit({ kind: 'tool-call', turn_id: 't1', tool: 'Read', call_id: 'after-compact', input: { file_path: 'production/scene-plan.md' } });
    expect(progressText()).toContain('正在执行操作');
    expect(progressText()).not.toContain('正在压缩上下文');
    // 停下这一轮：常驻的进度条随之消失。
    await userEvent.setup().click(document.getElementById('cancel-turn')!);
    expect(studio.api.count('POST /api/sessions/s1/cancel')).toBe(1);
    await studio.emit({ kind: 'turn-end', turn_id: 't1', status: 'cancelled' });
    expect(progress()).toBeNull();
    expect(studio.api.unmatched).toEqual([]);
  });

  test('current progress stays above the composer while waiting, survives reload and clears on completion', async () => {
    const studio = createStudio();
    studio.render();
    await screen.findByText('说说要做什么');
    await send('进度状态回归');
    // 后启动的调用先结束：第一条仍在执行。
    await studio.emit([
      ...turnStart('t1', '进度状态回归'),
      { kind: 'tool-call', turn_id: 't1', tool: 'Read', call_id: 'read', input: { file_path: 'scenes/scene-010/prompt.md' } },
      { kind: 'tool-call', turn_id: 't1', tool: 'Read', call_id: 'other', input: { file_path: 'frame.md' } },
      { kind: 'tool-result', turn_id: 't1', tool: 'Read', call_id: 'other', text: 'done' },
    ]);
    expect(progressText()).toContain('正在执行操作');
    expect(progressText()).toContain('scenes/scene-010/prompt.md');
    await studio.emit({ kind: 'tool-result', turn_id: 't1', tool: 'Read', call_id: 'read', text: 'done' });
    expect(progressText()).toContain('等待模型回复');
    expect(progressText()).toContain('已完成 2 项操作');
    expect(progressText()).toContain('最近完成：读取');
    // 卡片在输入框上方、对话之外：展开过程不影响它。
    const card = progress()!;
    expect(card.closest('#messages')).toBeNull();
    expect(card.compareDocumentPosition(document.querySelector('.composer')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.setup().click(document.querySelector('.shell > summary') as HTMLElement);
    expect(progress()).not.toBeNull();

    studio.remount();
    await waitFor(() => expect(progressText()).toContain('等待模型回复'));
    advanceClock(90_000);
    await waitFor(() => expect(progressText()).toContain('无新消息'), { timeout: 3000 });
    // 这一轮已经执行过操作：安静是正常的，不劝用户停止。
    expect(progressText()).not.toContain('点击输入框右下角停止');

    // 原生 EventSource 的断线 / 重连通知不能被展示成模型正在思考。
    const source = studio.source()!;
    act(() => source.onerror?.(new Event('error')));
    expect(progressText()).toContain('进度连接中断，正在重连');
    act(() => source.onopen?.(new Event('open')));
    expect(progressText()).toContain('等待模型回复');

    await studio.emit({ kind: 'turn-end', turn_id: 't1', status: 'succeeded' });
    expect(progress()).toBeNull();
    expect(document.querySelector('.done-line')).not.toBeNull();
    expect(studio.api.unmatched).toEqual([]);
  });
});
