import fs from 'node:fs';
import { test, expect } from './fixtures.mjs';

// 客户端独有的部分：原生菜单（拖文件进输入框在 chat.spec.mjs 的上传用例里）。
// 完成通知与 Dock 角标界面这一侧发了什么在 src/renderer/components/chat/DesktopNotify.test.tsx。

/** 按菜单路径点原生菜单项（走 menu.ts 里真实的 click）。 */
async function clickMenu(electronApp, top, label) {
  await electronApp.evaluate(({ Menu }, { top, label }) => {
    const menu = Menu.getApplicationMenu();
    const item = menu?.items.find((i) => i.label === top)?.submenu?.items.find((i) => i.label === label);
    if (!item) throw new Error(`菜单里没有 ${top} → ${label}`);
    item.click();
  }, { top, label });
}

/** 直接向窗口发 onset:menu，与菜单项发的是同一条消息。 */
async function sendMenu(electronApp, action) {
  await electronApp.evaluate(({ BrowserWindow }, action) => BrowserWindow.getAllWindows().find((w) => w.isResizable()).webContents.send('onset:menu', action), action);
}

test('native menu opens a folder, switches steps and goes home', async ({ electronApp, page, project, sandbox }) => {
  // 没有登记过的项目：首页。
  await expect(page.locator('.home-hero h1')).toContainText('今天想做一条');

  // 「打开项目文件夹…」：系统对话框换成直接返回项目路径，菜单把路径发给界面，界面经 /api/projects/open 打开。
  await electronApp.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, project.path);
  await clickMenu(electronApp, '文件', '打开项目文件夹…');
  await expect(page.locator('#title')).toHaveText(project.name);
  await expect(page.locator('.rail-scene[title="scene-001"]')).toBeVisible();
  // 打开的项目登记进了临时的项目登记，而不是用户真实的那份。
  await expect.poll(() => {
    if (!fs.existsSync(sandbox.registry)) return false;
    const registry = JSON.parse(fs.readFileSync(sandbox.registry, 'utf8'));
    return registry.projects?.some((entry) => entry.path === project.path) ?? false;
  }).toBe(true);

  // ⌘1–⌘5：五个步骤。
  await clickMenu(electronApp, '视图', '发布');
  await expect(page.locator('[data-tab="publish"]')).toHaveClass(/on/);
  await sendMenu(electronApp, { type: 'step', index: 0 });
  await expect(page.locator('[data-tab="script"]')).toHaveClass(/on/);

  // 首页：⌘0。
  await clickMenu(electronApp, '视图', '首页');
  await expect(page.locator('.home-hero h1')).toBeVisible();
  await expect(page.locator('[data-tab="script"]')).toHaveCount(0);

  // 在首页按步骤：回到项目的那一步。
  await sendMenu(electronApp, { type: 'step', index: 2 });
  await expect(page.locator('.home-hero h1')).toHaveCount(0);
  await expect(page.locator('[data-tab="scene"]')).toHaveClass(/on/);

  // 新建项目：⌘N 回首页。
  await clickMenu(electronApp, '文件', '新建项目');
  await expect(page.locator('.home-hero h1')).toBeVisible();

  // onset:menu open 直接带路径。
  await sendMenu(electronApp, { type: 'open', path: project.path });
  await expect(page.locator('.home-hero h1')).toHaveCount(0);
  await expect(page.locator('#title')).toHaveText(project.name);
});
