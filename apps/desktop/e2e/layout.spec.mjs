import { test, expect, openProject } from './fixtures.mjs';

// 对话是主栏，画面面板按需打开：默认收起，步骤、收起栏、菜单都能打开，× 与 Esc 收起，拖动的宽度记住。

async function sendMenu(electronApp, action) {
  await electronApp.evaluate(({ BrowserWindow }, action) => BrowserWindow.getAllWindows()[0].webContents.send('am:menu', action), action);
}

test('the chat is the main column and the picture panel opens on demand', async ({ page, project, electronApp }) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await openProject(page, project);

  // 默认只有对话，右边是收起栏；对话正文限宽居中。
  await expect(page.locator('#panel')).toHaveCount(0);
  await expect(page.locator('.panel-rail')).toBeVisible();
  const log = await page.locator('#messages').evaluate((el) => {
    const style = getComputedStyle(el);
    return { width: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
  });
  expect(log.width).toBeLessThanOrEqual(760);
  await page.screenshot({ path: test.info().outputPath('chat-only.png'), animations: 'disabled' });

  // 点步骤：打开面板并切到那一页。
  await page.locator('[data-tab="scene"]').click();
  await expect(page.locator('#panel')).toBeVisible();
  await expect(page.locator('#panel .panel-title')).toContainText('镜头');
  await expect(page.locator('#panel-toggle')).toHaveAttribute('aria-pressed', 'true');
  // 对话栏不窄于 420px。
  const chatWidth = await page.locator('.pane.chat-main').evaluate((el) => el.getBoundingClientRect().width);
  expect(chatWidth).toBeGreaterThanOrEqual(420);
  await page.screenshot({ path: test.info().outputPath('panel-open.png'), animations: 'disabled' });

  // × 收起；收起栏里点镜头再打开。
  await page.locator('#panel-close').click();
  await expect(page.locator('#panel')).toHaveCount(0);
  await page.locator('.rail-scene[title="scene-001"]').click();
  await expect(page.locator('#panel .panel-sub')).toHaveText('scene-001');

  // Esc 收起（输入框里按不算）。
  await page.locator('#prompt').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#panel')).toBeVisible();
  await page.locator('#panel .panel-title').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#panel')).toHaveCount(0);

  // 菜单「显示或收起画面」（⌘\）。
  await sendMenu(electronApp, { type: 'panel' });
  await expect(page.locator('#panel')).toBeVisible();

  // 拖动分隔条变宽，宽度记住；双击恢复默认。
  const handle = page.locator('.panel-resize');
  const before = await page.locator('#panel').evaluate((el) => el.getBoundingClientRect().width);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const after = await page.locator('#panel').evaluate((el) => el.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before + 80);
  await page.reload();
  await expect(page.locator('#panel')).toBeVisible();
  const reloaded = await page.locator('#panel').evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.abs(reloaded - after)).toBeLessThan(4);
  await page.locator('.panel-resize').dblclick();
  await expect.poll(() => page.locator('#panel').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(after - 80);
});

test('in a narrow window the panel is a drawer over the chat', async ({ page, project, electronApp }) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 760));
  await openProject(page, project);
  await expect(page.locator('.panel-rail')).toBeHidden();
  await page.locator('[data-tab="scene"]').click();
  await expect(page.locator('#panel')).toBeVisible();
  // 对话没有被挤走：输入框还在原处，只是被抽屉和遮罩盖住；点遮罩收起。
  await expect(page.locator('#prompt')).toBeAttached();
  await page.screenshot({ path: test.info().outputPath('drawer.png'), animations: 'disabled' });
  await page.locator('.panel-scrim').click({ position: { x: 20, y: 200 } });
  await expect(page.locator('#panel')).toHaveCount(0);
  await expect(page.locator('#prompt')).toBeVisible();
});
