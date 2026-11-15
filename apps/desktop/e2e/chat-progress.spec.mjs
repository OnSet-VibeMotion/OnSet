import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';
import { buildBlocks } from '../src/renderer/components/chat/model.ts';
import { turnActivity } from '../src/renderer/components/chat/activity.ts';

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

test('automatic compaction reaches the persistent status and survives a page reload', async ({ page, project }, testInfo) => {
  await openProject(page, project);
  await page.locator('#prompt').fill('压缩状态回归');
  await page.locator('#send').click();
  const progress = page.getByRole('region', { name: '当前 AI 进度' });
  await expect(progress).toContainText('正在压缩上下文');
  await expect(progress).toContainText('正在整理历史对话');
  await page.reload();
  await expect(progress).toContainText('正在压缩上下文');
  await page.clock.install();
  await page.clock.setSystemTime(Date.now() + 90000);
  await expect(progress).toContainText('无新消息');
  await expect(progress).toContainText('正在压缩上下文');
  await expect(progress).not.toContainText('等待模型回复');
  await page.screenshot({ path: testInfo.outputPath('compacting-progress.png') });
  await fs.writeFile(path.join(project.path, 'production/studio/compact-done'), '');
  await expect(progress).toContainText('上下文压缩完成，等待模型回复');
  await expect(progress).toContainText('150,000 → 20,000');
  await fs.writeFile(path.join(project.path, 'production/studio/compact-resume'), '');
  await expect(progress).toContainText('正在执行操作');
  await expect(progress).not.toContainText('正在压缩上下文');
  await page.locator('#cancel-turn').click();
  await expect(progress).toHaveCount(0);
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

test('current progress stays above the composer while waiting, survives reload and clears on completion', async ({ page, project, electronApp }, testInfo) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('/sessions/')) window.progressSource = this;
      }
    };
  });
  await openProject(page, project);
  await page.locator('#prompt').fill('进度状态回归');
  await page.locator('#send').click();
  const progress = page.getByRole('region', { name: '当前 AI 进度' });
  await expect(progress).toContainText('正在执行操作');
  await expect(progress).toContainText('scenes/scene-010/prompt.md');
  await fs.writeFile(path.join(project.path, 'production/studio/progress-read-done'), '');
  await expect(progress).toContainText('等待模型回复');
  await expect(progress).toContainText('已完成 2 项操作');
  await expect(progress).toContainText('最近完成：读取');
  await expect(progress).toBeInViewport();
  await page.locator('.shell > summary').click();
  await expect(progress).toBeInViewport();
  await page.reload();
  await expect(progress).toContainText('等待模型回复');
  await page.clock.install();
  await page.clock.setSystemTime(Date.now() + 90000);
  await expect(progress).toContainText('无新消息');
  await expect(progress).toContainText('尚未收到新的模型输出');
  await page.screenshot({ path: testInfo.outputPath('waiting-progress.png') });
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isResizable()).setSize(1000, 700));
  await page.locator('#messages').evaluate(element => { element.scrollTop = 0; });
  await expect(progress).toBeInViewport();
  expect(await progress.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('waiting-progress-narrow.png') });
  // 原生 EventSource 的断线 / 重连通知不能被展示成模型正在思考。
  await page.evaluate(() => window.progressSource.dispatchEvent(new Event('error')));
  await expect(progress).toContainText('进度连接中断，正在重连');
  await page.evaluate(() => window.progressSource.dispatchEvent(new Event('open')));
  await expect(progress).toContainText('等待模型回复');
  await fs.writeFile(path.join(project.path, 'production/studio/progress-finish'), '');
  await expect(progress).toHaveCount(0);
  await expect(page.locator('.done-line')).toBeVisible();
});

test('stopping a turn removes the persistent progress indicator', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#prompt').fill('慢慢来');
  await page.locator('#send').click();
  await expect(page.getByRole('region', { name: '当前 AI 进度' })).toBeVisible();
  await page.locator('#cancel-turn').click();
  await expect(page.getByRole('region', { name: '当前 AI 进度' })).toHaveCount(0);
});
