import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

async function openLongProcess(page, project) {
  const id = 'scroll-session';
  const time = '2026-01-01T00:00:00Z';
  const events = [
    { kind: 'user', text: '检查项目' },
    { kind: 'turn-start', status: 'running' },
    { kind: 'text', text: Array.from({ length: 30 }, (_, i) => `正在检查第 ${i + 1} 项。`).join('\n\n') },
    { kind: 'thinking', text: Array.from({ length: 60 }, (_, i) => `思考第 ${i + 1} 步。`).join('\n\n') },
    { kind: 'tool-call', tool: 'Read', call_id: 'read', input: { file_path: 'notes.md' } },
    { kind: 'tool-result', tool: 'Read', call_id: 'read', text: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行检查结果。`).join('\n') },
    // 一次被拒的命令：历史里要显示成失败，而不是一直在转。
    { kind: 'tool-call', tool: 'Bash', call_id: 'denied', input: { command: 'pwd' } },
    { kind: 'tool-result', tool: 'Bash', call_id: 'denied', text: 'denied', is_error: true },
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

// 鼠标停在展开的思考、工具输出上也能滚动整段对话，并能回到最新回复：滚轮落在嵌套的可滚动块上时
// 由谁接住是真实浏览器的排版与滚动链，jsdom 测不了。展开、收起时「回到最新」跟着滚动范围变、历史里被拒的命令
// 显示成失败，在 src/renderer/components/Chat.test.tsx。
test('scrolls the conversation with the wheel over expanded thinking and tool output', async ({ page, project }) => {
  await openLongProcess(page, project);
  const messages = page.locator('#messages');
  const jump = page.getByRole('button', { name: '回到最新' });
  for (const kind of ['thinking', 'tool']) {
    const detail = page.locator(kind === 'thinking' ? '.thinking-row' : '.tool.done');
    await detail.locator(':scope > summary').click();
    const body = detail.locator(kind === 'thinking' ? '.thinking-body' : '.terminal');
    await messages.evaluate(el => { el.scrollTop = 0; });
    await body.hover({ position: { x: 30, y: 30 } });
    const before = await messages.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => messages.evaluate(el => el.scrollTop), `${kind}`).toBeGreaterThan(before + 100);
    await expect(jump).toBeVisible();
    await jump.click();
    await expect.poll(() => messages.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(8);
    await expect(jump).toBeHidden();
    await expect(page.locator('.done-line')).toBeInViewport();
    // 收起这一项，下一项与原来单独测时一样从同样的高度开始。
    await detail.locator(':scope > summary').click();
  }
});
