import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

async function openLongProcess(page, project, longProcess = false) {
  const id = 'scroll-session';
  const time = '2026-01-01T00:00:00Z';
  const events = [
    { kind: 'user', text: '检查项目' },
    { kind: 'turn-start', status: 'running' },
    ...(longProcess ? [{ kind: 'text', text: Array.from({ length: 30 }, (_, i) => `正在检查第 ${i + 1} 项。`).join('\n\n') }] : []),
    { kind: 'thinking', text: Array.from({ length: 60 }, (_, i) => `思考第 ${i + 1} 步。`).join('\n\n') },
    { kind: 'tool-call', tool: 'Read', call_id: 'read', input: { file_path: 'notes.md' } },
    { kind: 'tool-result', tool: 'Read', call_id: 'read', text: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行检查结果。`).join('\n') },
    { kind: 'text', text: '检查完成，这是最新回复。' },
    { kind: 'turn-end', status: 'succeeded' },
  ].map((event, i) => ({ ...event, seq: i + 1, turn_id: 'scroll-turn', time }));
  const dir = path.join(project.path, 'production/studio/sessions');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({
    session_id: id, title: '滚动测试', kind: 'chat', tool: 'claude',
    created_at: time, updated_at: time, turns: ['scroll-turn'],
  }));
  await fs.writeFile(path.join(dir, `${id}.events.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await openProject(page, project);
  await page.locator('#history').click();
  await page.locator('.history-row', { hasText: '滚动测试' }).click();
  await expect(page.locator('.message.assistant')).toContainText('这是最新回复');
  await page.locator('.shell > summary').click();
}

test('updates the latest button when expanding and collapsing changes the scroll range', async ({ page, project }) => {
  await openLongProcess(page, project, true);
  const messages = page.locator('#messages');
  const jump = page.getByRole('button', { name: '回到最新' });
  await expect.poll(() => messages.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(500);
  await expect(jump).toBeVisible();
  // 在顶部收起过程：scrollTop 一直是 0，不会有 scroll 事件来纠正按钮。
  await messages.evaluate(el => { el.scrollTop = 0; });
  await page.locator('.shell > summary').click();
  await expect.poll(() => messages.evaluate(el => el.scrollHeight - el.clientHeight)).toBe(0);
  await expect(jump).toBeHidden();
});

for (const kind of ['thinking', 'tool']) {
  test(`can scroll and return to the latest reply over expanded ${kind}`, async ({ page, project }) => {
    await openLongProcess(page, project);
    const detail = page.locator(kind === 'thinking' ? '.thinking-row' : '.tool.done');
    await detail.locator(':scope > summary').click();
    const body = detail.locator(kind === 'thinking' ? '.thinking-body' : '.terminal');
    const messages = page.locator('#messages');
    await messages.evaluate(el => { el.scrollTop = 0; });
    await body.hover({ position: { x: 30, y: 30 } });
    const before = await messages.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => messages.evaluate(el => el.scrollTop)).toBeGreaterThan(before + 100);
    const jump = page.getByRole('button', { name: '回到最新' });
    await expect(jump).toBeVisible();
    await jump.click();
    await expect.poll(() => messages.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(8);
    await expect(jump).toBeHidden();
    await expect(page.locator('.done-line')).toBeInViewport();
  });
}
