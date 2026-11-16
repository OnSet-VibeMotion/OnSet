import { test, expect, openProject } from './fixtures.mjs';

// CodeBuddy 历史重放的工具行整理由 src/renderer/components/chat/model.test.mjs 覆盖；
// 完成 / 失败两种工具行的样式在 chat-scroll.spec.mjs 的种子里顺带查。

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
