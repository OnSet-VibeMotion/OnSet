import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, petPage } from './fixtures.mjs';

// 编排工具（claude）在客户端里遇到白名单外的命令时，经 am studio permission-mcp 在输入框上方弹卡片问用户。
// 假 claude 的「要批准」真的启动 --mcp-config 里的审批服务，请求 npm install three。

test('asks before running a command outside the allowlist and remembers "always"', async ({ page, project, electronApp }) => {
  await openProject(page, project);

  await page.locator('#prompt').fill('要批准：装一下 three');
  await page.locator('#prompt').press('Enter');
  const card = page.locator('.permission-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.permission-command')).toHaveText('npm install three');
  await expect(card).toContainText('安装 three.js');
  // 桌宠里的场记小人走到台前举着场记板等你：气泡与卡片说的是同一件事。
  const pet = await petPage(electronApp);
  await expect(pet.locator('#crew')).toHaveAttribute('data-mood', 'waiting');
  await expect(pet.locator('#crew .pet-line')).toHaveText('等你批准');
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

// opencode 在客户端里走 ACP：它的审批请求经同一条收件目录弹卡片。假 opencode 请求 npm install three。
test('asks for an ACP orchestrator too', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#agent-tool').selectOption('opencode');
  await page.locator('#prompt').fill('装一下依赖');
  await page.locator('#prompt').press('Enter');
  const card = page.locator('.permission-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.permission-command')).toHaveText('npm install three');
  await card.locator('button', { hasText: '允许' }).first().click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.message.assistant').last()).toContainText('装好了');

  await page.locator('#prompt').fill('再装一次');
  await page.locator('#prompt').press('Enter');
  await expect(card).toBeVisible();
  await card.locator('button', { hasText: '拒绝' }).click();
  await expect(page.locator('#messages')).toContainText('你拒绝了一条调用');
});

// 「以后都不用问」：打开全局的自动批准，眼前这条放行；之后的请求不再弹卡片，对话里留一行「已自动允许」。
test('"never ask again" turns on auto-approve for every later request', async ({ page, project, sandbox }) => {
  await openProject(page, project);
  await page.locator('#prompt').fill('要批准：装一下 three');
  await page.locator('#prompt').press('Enter');
  const card = page.locator('.permission-card');
  await expect(card).toBeVisible();
  await card.locator('button', { hasText: '以后都不用问' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.message.assistant').last()).toContainText('behavior:allow');
  expect(fs.readFileSync(sandbox.settings, 'utf8')).toContain('AUTO_APPROVE=on');

  await page.locator('#prompt').fill('要批准：再装一次');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('.message.assistant').last()).toContainText('behavior:allow', { timeout: 10_000 });
  await expect(page.locator('.permission-card')).toHaveCount(0);
  await expect(page.locator('#messages')).toContainText('已自动允许：npm install three');

  // 设置页里能看到、也能关掉。
  await page.locator('#settings-trigger').click();
  await expect(page.locator('.settings-row[data-key="AUTO_APPROVE"]').getByLabel('全局自动批准')).toHaveValue('on');
});
