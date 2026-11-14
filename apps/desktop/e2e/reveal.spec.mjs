import path from 'node:path';
import { test, expect, openProject, openPage } from './fixtures.mjs';

// 在 Finder 中显示：顶栏、原生菜单、镜头「⋯」菜单、右键菜单、首页最近项目。
// 测试里不能真的弹 Finder，把主进程的 shell.openPath / showItemInFolder 换成记录。

async function stubShell(electronApp) {
  await electronApp.evaluate(({ shell }) => {
    globalThis.__revealed = [];
    shell.openPath = async (p) => {
      globalThis.__revealed.push(['open', p]);
      return '';
    };
    shell.showItemInFolder = (p) => {
      globalThis.__revealed.push(['select', p]);
    };
  });
}

const revealed = (electronApp) => electronApp.evaluate(() => globalThis.__revealed.splice(0));

test('shows the project, a scene and files in Finder', async ({ page, project, electronApp }) => {
  await stubShell(electronApp);
  await openProject(page, project);
  const sceneDir = path.join(project.path, 'scenes', 'scene-001');

  // 顶栏的文件夹按钮：打开项目文件夹。
  await page.locator('#reveal-project').click();
  await expect.poll(() => revealed(electronApp)).toEqual([['open', project.path]]);

  // 菜单「在 Finder 中显示项目」（⌥⌘R）。
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isResizable()).webContents.send('onset:menu', { type: 'reveal' }));
  await expect.poll(() => revealed(electronApp)).toEqual([['open', project.path]]);

  // 镜头还没出片：选中镜头目录。
  await page.locator('[data-tab="scene"]').click();
  await page.locator('.scene-menu summary').click();
  await page.locator('#reveal-scene').click();
  await expect.poll(() => revealed(electronApp)).toEqual([['select', sceneDir]]);

  // 右键文件：选中那个文件。
  await openPage(page, 'file');
  const row = page.locator('[data-ctx-file="notes.md"]').first();
  await row.click({ button: 'right' });
  await page.locator('.ctx-menu button', { hasText: '在 Finder 中显示' }).click();
  await expect.poll(() => revealed(electronApp)).toEqual([['select', path.join(project.path, 'notes.md')]]);

  // 文件页工具栏。
  await row.click();
  await page.locator('#reveal-file').click();
  await expect.poll(() => revealed(electronApp)).toEqual([['select', path.join(project.path, 'notes.md')]]);
});

test('opens a recent project folder from home', async ({ page, project, electronApp }) => {
  await stubShell(electronApp);
  await openProject(page, project);
  await page.locator('.brand').click();
  const row = page.locator('.rail-row', { hasText: project.name });
  await row.hover();
  await row.locator('.rail-reveal').click();
  await expect.poll(() => revealed(electronApp)).toEqual([['open', project.path]]);
});
