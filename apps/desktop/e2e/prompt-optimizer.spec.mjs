import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 提示词优化：输入框的「润色」与分镜页的「检查画面描述」。假 claude（fake-bin/claude）认出两份优化器提示词，回固定的 JSON。

test('polishes the draft into the input box without sending it', async ({ page, project }) => {
  await openProject(page, project);
  const prompt = page.locator('#prompt');
  await prompt.fill('@scene-001 太乱了');
  await page.locator('#polish').click();
  await expect(page.locator('#polish-text')).toHaveText('@scene-001 画面元素太多、看不出重点：保留主物件，去掉次要的装饰，其余镜头不动。');
  await expect(page.locator('#polish-card')).toContainText('写明了改哪一方面、不动哪里');
  // 点之前输入框不动。
  await expect(prompt).toHaveValue('@scene-001 太乱了');
  await page.locator('#polish-use').click();
  await expect(page.locator('#polish-card')).toHaveCount(0);
  await expect(prompt).toHaveValue(/^@scene-001 画面元素太多/);
  // 只替换，不发送；能换回原话。
  await expect(page.locator('.message.user')).toHaveCount(0);
  await page.locator('#polish-undo').click();
  await expect(prompt).toHaveValue('@scene-001 太乱了');

  // 已经清楚的话：说不用改，没有「用这版」。
  await prompt.fill('这句已经很清楚了');
  await page.locator('#polish').click();
  await expect(page.locator('#polish-card')).toContainText('不用改');
  await expect(page.locator('#polish-use')).toHaveCount(0);

  // 花的钱记进项目的账本。
  const ledger = await fs.readFile(path.join(project.path, 'production', 'usage', 'orchestrator.jsonl'), 'utf8');
  expect(ledger.trim().split('\n').map((l) => JSON.parse(l).source)).toEqual(['polish', 'polish']);
});

test('checks a scene description on the storyboard and applies the rewrite only after confirmation', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('[data-tab="storyboard"]').click();
  await page.locator('#storyboard [data-check="scene-001"]').click();
  const result = page.locator('#storyboard [data-check-result="scene-001"]');
  await expect(result).toContainText('建议小改');
  await expect(result).toContainText('没写主体在画面里的位置');
  await expect(result.locator('.pc-scores li')).toHaveCount(5);
  // 检查只出草稿，不动 prompt.md。
  expect(await fs.readFile(project.promptFile, 'utf8')).toBe('before\n');
  await result.locator('.pc-diff-toggle').click();
  await expect(result.locator('.pc-diff .add')).toContainText('门在画面中央');

  await result.locator('[data-apply="scene-001"]').click();
  await expect.poll(() => fs.readFile(project.promptFile, 'utf8')).toBe('before\n门在画面中央，缓缓推开。\n');
  // 采用后草稿删掉，卡片回到「检查画面描述」。
  await expect(page.locator('#storyboard [data-check="scene-001"]')).toBeVisible();
});

test('refuses to apply a rewrite once prompt.md changed after the check', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('[data-tab="storyboard"]').click();
  await page.locator('#storyboard [data-check="scene-001"]').click();
  const result = page.locator('#storyboard [data-check-result="scene-001"]');
  await expect(result).toContainText('建议小改');
  // 检查之后有人改了 prompt.md：后端拒绝采用。
  await fs.writeFile(project.promptFile, '手改过\n');
  const status = await page.evaluate(async () => (await fetch('/api/prompt-checks/scene-001/apply', { method: 'POST' })).status);
  expect(status).toBe(409);
  expect(await fs.readFile(project.promptFile, 'utf8')).toBe('手改过\n');
  // 重新读分镜后照实说结果过期了，不给「采用」。
  await page.locator('[data-tab="scene"]').click();
  await page.locator('[data-tab="storyboard"]').click();
  await expect(result).toContainText('检查之后改过了');
  await expect(result.locator('[data-apply="scene-001"]')).toHaveCount(0);
});
