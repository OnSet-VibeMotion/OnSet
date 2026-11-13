import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 编排工具（claude）在客户端里遇到白名单外的命令时，经 am studio permission-mcp 在输入框上方弹卡片问用户。
// 假 claude 的「要批准」真的启动 --mcp-config 里的审批服务，请求 npm install three。

test('asks before running a command outside the allowlist and remembers "always"', async ({ page, project }) => {
  await openProject(page, project);

  await page.locator('#prompt').fill('要批准：装一下 three');
  await page.locator('#prompt').press('Enter');
  const card = page.locator('.permission-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.permission-command')).toHaveText('npm install three');
  await expect(card).toContainText('安装 three.js');
  await card.locator('button', { hasText: '以后都允许' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.message.assistant').last()).toContainText('behavior:allow');
  const saved = JSON.parse(fs.readFileSync(path.join(project.path, 'production', 'studio', 'permissions.json'), 'utf8'));
  expect(saved.allowed_commands).toEqual(['npm install']);

  // 记下的前缀不再问，直接放行。
  await page.locator('#prompt').fill('要批准：再装一次');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('.message.assistant').last()).toContainText('behavior:allow', { timeout: 10_000 });
  await expect(page.locator('.permission-card')).toHaveCount(0);
});

test('a denied command is reported back to the orchestrator', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#prompt').fill('要批准：装一下 three');
  await page.locator('#prompt').press('Enter');
  const card = page.locator('.permission-card');
  await expect(card).toBeVisible();
  await card.locator('button', { hasText: '拒绝' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.message.assistant').last()).toContainText('behavior:deny');
  await expect(page.locator('.message.assistant').last()).toContainText('用户拒绝了');
});
