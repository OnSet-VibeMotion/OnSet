import fs from 'node:fs';
import { test, expect, openProject } from './fixtures.mjs';

// 客户端独有的部分：原生菜单、完成通知与 Dock 角标（拖文件进输入框在 chat.spec.mjs 的上传用例里）。

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

/** 记下主进程弹出的通知与设置的角标；focused 决定主进程看到的「前台窗口」。 */
async function recordNativeCalls(electronApp, focused) {
  await electronApp.evaluate(({ app, BrowserWindow, Notification }, focused) => {
    const record = (globalThis.__amE2E = { notes: [], badges: [] });
    const win = BrowserWindow.getAllWindows().find((w) => w.isResizable());
    BrowserWindow.getFocusedWindow = () => (focused ? win : null);
    Notification.prototype.show = function () {
      record.notes.push({ title: this.title, body: this.body });
    };
    const setBadgeCount = app.setBadgeCount.bind(app);
    app.setBadgeCount = (count) => {
      record.badges.push(count);
      return setBadgeCount(count);
    };
  }, focused);
}

const nativeCalls = (electronApp) => electronApp.evaluate(() => globalThis.__amE2E);

test('notifies when a turn ends in the background, not when the window is in front', async ({ electronApp, page, project }) => {
  await openProject(page, project);
  await recordNativeCalls(electronApp, false);
  await page.locator('#prompt').fill('把镜头提示词改成 after');
  await page.locator('#send').click();
  await expect(page.locator('.done-line').last()).toContainText('已完成');
  await expect.poll(async () => (await nativeCalls(electronApp)).notes).toContainEqual({ title: '这一轮做完了', body: project.name });

  // 窗口在前台时再做一轮：不弹通知。
  await recordNativeCalls(electronApp, true);
  await page.locator('#prompt').fill('把镜头提示词改成 after');
  await page.locator('#send').click();
  await expect(page.locator('.done-line')).toHaveCount(2);
  await expect(page.locator('.done-line').last()).toContainText('已完成');
  // 给 IPC 一点时间到达主进程，再确认没弹。
  await page.waitForTimeout(500);
  expect((await nativeCalls(electronApp)).notes).toEqual([]);
});

test('shows running tasks on the Dock badge and notifies when they finish', async ({ electronApp, page, project }) => {
  await openProject(page, project);
  await recordNativeCalls(electronApp, false);
  // 镜头页「⋯」里的「校验」：一个经私有 onset shim 运行的写任务。点步骤打开画面面板。
  await page.locator('[data-tab="scene"]').click();
  await page.locator('.scene-menu summary').click();
  await page.locator('.scene-menu-body').getByRole('button', { name: '校验', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(electronApp)).badges.some((n) => n >= 1)).toBe(true);
  await expect.poll(async () => (await nativeCalls(electronApp)).notes.map((n) => n.title), { timeout: 20_000 }).toContainEqual(
    expect.stringMatching(/^任务(完成|失败)$/),
  );
  await expect.poll(async () => (await nativeCalls(electronApp)).badges.at(-1)).toBe(0);
  // 渲染器经 preload 设的角标落到了应用上。
  expect(await electronApp.evaluate(({ app }) => app.getBadgeCount())).toBe(0);
});
