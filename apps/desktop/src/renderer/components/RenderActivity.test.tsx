// @vitest-environment jsdom
/// <reference types="node" />
/*
 * 对话里的渲染卡片（原 e2e/render-activity.spec.mjs「keeps render cards collapsible when many scenes and long commands fill the chat」）：
 * 好几个镜头同时渲染、每个都有一长串很长的命令时，列表与每张卡片都能收起展开，收起的卡片照样跟着新步骤更新。
 * 后端（/api/scenes/{id}/activity）换成假的：每个镜头的过程按 studio/activity.ts 的形状给出，测试里随时改。
 *
 * jsdom 不排版：「展开后过程只在自己的区域滚动、输入框仍在窗口里、窄窗口不出横向滚动」量不了，
 * 这里只核对 render-activity.css 里管这几件事的规则还在。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../testing';
import type { ActivityStep, Scene, SceneActivity } from '../types';
import { RenderWatch } from './RenderActivity';

const command = '"C:\\Program Files\\WindowsApps\\OpenAI.CodexPrimaryRuntime\\powershell\\pwsh.exe" -Command ' + 'inspect-long-render-path '.repeat(20);

const ids = Array.from({ length: 9 }, (_, i) => `scene-${String(i + 1).padStart(3, '0')}`);

function scene(id: string): Scene {
  return { id, directory: `scenes/${id}`, exists: false, stale: false, attempts: 0, rendering: true, rendering_since: '2026-11-17T00:00:00.000Z' };
}

/** 每个镜头 24 次跑完的长命令，与 e2e 写进渲染日志的一样（后端译成步骤后的形状）。 */
function bashSteps(): ActivityStep[] {
  return Array.from({ length: 24 }, () => ({ kind: 'tool', tool: 'Bash', input: { command }, state: 'done', output: 'done' }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

test('keeps render cards collapsible when many scenes and long commands fill the chat', async () => {
  const started = new Date(Date.now() - 30_000).toISOString();
  const activities = new Map<string, SceneActivity>(
    ids.map((id) => [id, { scene_id: id, rendering: true, renderer: 'claude', model: 'claude-test', started_at: started, updated_at: new Date().toISOString(), step_count: 24, steps: bashSteps() }]),
  );
  const routes: Record<string, unknown> = {};
  for (const id of ids) routes[`/api/scenes/${id}/activity`] = () => activities.get(id);
  const api = mockApi(routes);
  const onView = vi.fn();
  const { container } = render(<RenderWatch scenes={ids.map(scene)} onView={onView} />);

  const watch = container.querySelector<HTMLElement>('.render-watch')!;
  expect(watch).toBeTruthy();
  await waitFor(() => expect(watch.querySelectorAll('.render-card')).toHaveLength(9));
  expect(watch.querySelector('.render-watch-count')!.textContent).toBe('9 个进行中');
  const card = () => watch.querySelector<HTMLElement>('[data-render-scene="scene-001"]')!;
  const header = () => card().querySelector<HTMLButtonElement>('.ra-head')!;
  // 阶段与等待状态怎么说在 render-progress.test.mjs；这里只看卡片把它接上了。
  await waitFor(() => expect(card().querySelector('.ra-status')!.textContent).toBe('等模型回复'));
  expect(card().querySelector('.ra-elapsed')!.textContent).toContain('累计');

  // 某个镜头渲染结束（后端改报 rendering: false）：它的卡片退场，计数跟着变；结束的镜头不再轮询。
  for (const id of ['scene-008', 'scene-009']) activities.set(id, { ...activities.get(id)!, rendering: false, outcome: 'succeeded' });
  await act(() => vi.advanceTimersByTimeAsync(2100));
  await waitFor(() => expect(watch.querySelector('.render-watch-count')!.textContent).toBe('7 个进行中'));
  expect(watch.querySelectorAll('.render-card')).toHaveLength(7);
  const finishedPolls = api.count('/api/scenes/scene-008/activity');
  await act(() => vi.advanceTimersByTimeAsync(4100));
  expect(api.count('/api/scenes/scene-008/activity')).toBe(finishedPolls);

  // 整个列表能收起再展开（收起时列表带 collapsed，样式里藏起来）。
  const list = watch.querySelector('.render-watch-list')!;
  fireEvent.click(within(watch).getByRole('button', { name: '收起列表' }));
  expect(list.classList.contains('collapsed')).toBe(true);
  expect(within(watch).getByRole('button', { name: '展开列表' }).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(within(watch).getByRole('button', { name: '展开列表' }));
  expect(list.classList.contains('collapsed')).toBe(false);

  // 展开一张卡片：24 步全在，长命令只显示第一行（不撑出一大块）。
  fireEvent.click(header());
  expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(card().querySelectorAll('.ra-step')).toHaveLength(24);
  expect(card().querySelector('.ra-foot')!.textContent).toContain('共 24 步 · claude-test');
  // 收起：过程不再画出来。
  fireEvent.click(header());
  expect(header().getAttribute('aria-expanded')).toBe('false');
  expect(card().querySelectorAll('.ra-steps')).toHaveLength(0);

  // 展开着时新步骤进来，下一次轮询就接上。
  fireEvent.click(header());
  const first = activities.get('scene-001')!;
  first.steps = [...first.steps, { kind: 'text', text: '新步骤已完成' }];
  first.step_count = first.steps.length;
  await act(() => vi.advanceTimersByTimeAsync(2100));
  await waitFor(() => expect(card().querySelectorAll('.ra-step')).toHaveLength(25));

  // 收起的卡片照样更新标题里的那一行，并且保持收起。
  fireEvent.click(header());
  expect(header().getAttribute('aria-expanded')).toBe('false');
  first.steps = [...first.steps, { kind: 'text', text: '收起后继续更新' }];
  first.step_count = first.steps.length;
  await act(() => vi.advanceTimersByTimeAsync(2100));
  await waitFor(() => expect(header().querySelector('.ra-current')!.textContent).toBe('收起后继续更新'));
  expect(header().getAttribute('aria-expanded')).toBe('false');

  // 别的卡片各自展开收起，互不牵连。
  const last = watch.querySelector<HTMLButtonElement>('[data-render-scene="scene-007"] .ra-head')!;
  fireEvent.click(last);
  expect(last.getAttribute('aria-expanded')).toBe('true');
  expect(header().getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(last);
  expect(last.getAttribute('aria-expanded')).toBe('false');

  // 再展开是 26 步；卡片头是按钮，键盘（空格）也能收起。
  fireEvent.click(header());
  expect(card().querySelectorAll('.ra-step')).toHaveLength(26);
  header().focus();
  await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).keyboard(' ');
  expect(header().getAttribute('aria-expanded')).toBe('false');

  // 打开镜头交给对话的 onView。
  fireEvent.click(header());
  fireEvent.click(within(card()).getByRole('button', { name: '打开镜头' }));
  expect(onView).toHaveBeenCalledWith({ page: 'scene', target: 'scene-001' });
  expect(api.unmatched).toEqual([]);
  expect(screen.queryByText('正在启动渲染器…')).toBeNull();
});

test('the render list keeps its own scroll area and hides when collapsed', () => {
  // 排版只在真窗口里量得出来（原 e2e：列表高度不超过窗口一半、输入框不被挤出、窄窗口不横向滚动），这里守住对应的样式。
  const css = readFileSync(join(import.meta.dirname, '../render-activity.css'), 'utf8');
  const rule = (selector: string) => new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css)?.[1] ?? '';
  expect(rule('.render-watch')).toMatch(/max-height:\s*min\(360px,\s*45vh\)/);
  expect(rule('.render-watch')).toMatch(/overflow:\s*hidden/);
  expect(rule('.render-watch-list')).toMatch(/overflow-y:\s*auto/);
  expect(rule('.render-watch-list.collapsed')).toMatch(/display:\s*none/);
});
