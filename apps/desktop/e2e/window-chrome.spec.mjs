import { test, expect, petPage } from './fixtures.mjs';

test.describe('Windows Mac-style window chrome', () => {
  test.skip(process.platform !== 'win32', 'Windows 客户端的窗口外观');

  test('uses one themed title bar and keeps the native menu bar hidden', async ({ page, electronApp }) => {
    await expect(page.locator('.window-controls button')).toHaveCount(3);
    await expect(page.locator('#window-app-menu')).toBeVisible();
    const bar = await page.locator('.topbar').boundingBox();
    expect(bar.y).toBe(0);
    expect(bar.height).toBe(60);
    const nativeMenu = () => electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((window) => window.isResizable());
      return { visible: win.isMenuBarVisible(), autoHide: win.isMenuBarAutoHide() };
    });
    expect(await nativeMenu()).toEqual({ visible: false, autoHide: false });
    await page.keyboard.press('Alt');
    expect(await nativeMenu()).toEqual({ visible: false, autoHide: false });
    await page.keyboard.press('Escape');
    // 最小窗口也不能把菜单与设置挤出右侧。
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isResizable()).setSize(1024, 640));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024);
    const menu = await page.locator('#window-app-menu').boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: test.info().outputPath('mac-style-window.png') });
  });

  test('runs close, minimize and maximize through the main-window bridge', async ({ page, electronApp }) => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((window) => window.isResizable());
      const original = { close: win.close, minimize: win.minimize, maximize: win.maximize, unmaximize: win.unmaximize, isMaximized: win.isMaximized };
      globalThis.__windowCommands = [];
      let maximized = false;
      win.close = () => globalThis.__windowCommands.push('close');
      win.minimize = () => globalThis.__windowCommands.push('minimize');
      win.maximize = () => { maximized = true; globalThis.__windowCommands.push('maximize'); };
      win.unmaximize = () => { maximized = false; globalThis.__windowCommands.push('restore'); };
      win.isMaximized = () => maximized;
      globalThis.__restoreChrome = () => Object.assign(win, original);
    });
    try {
      await page.locator('#window-minimize').click();
      await page.locator('#window-maximize').click();
      await page.locator('#window-maximize').click();
      await page.locator('#window-close').click();
      await expect.poll(() => electronApp.evaluate(() => globalThis.__windowCommands)).toEqual(['minimize', 'maximize', 'restore', 'close']);
      const pet = await petPage(electronApp);
      await expect(pet.locator('.window-controls')).toHaveCount(0);
      await pet.evaluate(() => window.onset.windowCommand('close'));
      // 桌宠虽然共用 preload，也不能关掉主窗口。
      expect(await electronApp.evaluate(() => globalThis.__windowCommands)).toEqual(['minimize', 'maximize', 'restore', 'close']);
    } finally {
      await electronApp.evaluate(() => globalThis.__restoreChrome());
    }
  });

  test('opens the original application menu from its compact title-bar button', async ({ page, electronApp }) => {
    await electronApp.evaluate(({ Menu, BrowserWindow }) => {
      const menu = Menu.getApplicationMenu();
      menu.popup = (options) => {
        globalThis.__windowMenu = {
          labels: menu.items.map((item) => item.label),
          main: options.window === BrowserWindow.getAllWindows().find((window) => window.isResizable()),
          x: options.x, y: options.y,
          openShortcut: menu.items.find((item) => item.label === '文件').submenu.items.find((item) => item.label === '打开项目文件夹…').accelerator,
        };
      };
    });
    await page.locator('#window-app-menu').click();
    await expect.poll(() => electronApp.evaluate(() => globalThis.__windowMenu?.labels)).toEqual(['文件', '编辑', '视图', '窗口']);
    const opened = await electronApp.evaluate(() => globalThis.__windowMenu);
    expect(opened.main).toBe(true);
    expect(opened.openShortcut).toBe('CmdOrCtrl+O');
    expect(opened.x).toBeGreaterThanOrEqual(0);
    expect(opened.y).toBeGreaterThanOrEqual(30);
  });
});
