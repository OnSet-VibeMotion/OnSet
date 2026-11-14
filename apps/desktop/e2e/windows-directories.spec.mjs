import fs from 'node:fs';
import path from 'node:path';
import { test, expect, api } from './fixtures.mjs';

async function nextFolderDialog(electronApp, selected) {
  await electronApp.evaluate(({ dialog }, directory) => {
    globalThis.__onsetFolderDialog = null;
    dialog.showOpenDialog = async (owner, options) => {
      globalThis.__onsetFolderDialog = { options, parentIsMainWindow: owner.isResizable() };
      return { canceled: directory === null, filePaths: directory === null ? [] : [directory] };
    };
  }, selected);
}

for (const drive of ['D', 'E', 'F']) {
  const root = drive + ':\\';
  test(`Windows uses the system folder picker to save and reopen projects on ${drive}:`, async ({ page, electronApp, sandbox }) => {
    test.skip(process.platform !== 'win32' || !fs.existsSync(root), 'requires this mounted Windows drive');
    const parent = fs.mkdtempSync(path.join(root, 'onset-drive-e2e-'));
    try {
      // Cancel keeps the previous save location, and no custom drive browser opens.
      await expect(page.locator('#home-folder')).toHaveAttribute('title', sandbox.home);
      const original = await page.locator('#home-folder').textContent();
      await nextFolderDialog(electronApp, null);
      await page.locator('#home-folder').click();
      await expect.poll(() => electronApp.evaluate(() => globalThis.__onsetFolderDialog !== null)).toBe(true);
      await expect(page.locator('#home-folder')).toHaveText(original);
      await expect(page.locator('.folder-browser, .directory-drives')).toHaveCount(0);

      await nextFolderDialog(electronApp, parent);
      await page.locator('#home-folder').click();
      await expect(page.locator('#home-folder')).toContainText(parent);
      const nativeDialog = await electronApp.evaluate(() => globalThis.__onsetFolderDialog);
      expect(nativeDialog.options.properties).toContain('openDirectory');
      expect(nativeDialog.options.defaultPath).toBeTruthy();
      expect(nativeDialog.parentIsMainWindow).toBe(true);

      // Create a real project through the dialog, without an AI or network call.
      await page.locator('#open-project-trigger').click();
      await page.locator('#mode-create').click();
      const dialog = page.locator('#project-dialog');
      await nextFolderDialog(electronApp, parent);
      await dialog.locator('#native-create-directory').click();
      await expect(dialog.locator('.native-directory-browser .path')).toHaveText(parent);
      const name = '跨盘保存 测试';
      await page.locator('#new-project-name').fill(name);
      await page.locator('#create-project').click();
      await expect(page.locator('#title')).toHaveText(name);
      const project = path.join(parent, name);
      expect(fs.existsSync(path.join(project, 'frame.md'))).toBe(true);
      expect(fs.existsSync(path.join(project, 'onset.conf'))).toBe(true);
      const registry = await api(page, '/api/projects');
      expect(registry.body.default_parent).toBe(fs.realpathSync(parent));

      // Opening an existing project uses the same native dialog and real backend.
      await page.locator('#open-project-trigger').click();
      await page.locator('#mode-open').click();
      await nextFolderDialog(electronApp, project);
      await dialog.locator('#native-open-directory').click();
      await expect(dialog.locator('.native-directory-browser .path')).toHaveText(project);
      await page.locator('#open-project').click();
      await expect(page.locator('#title')).toHaveText(name);
      await page.screenshot({ path: test.info().outputPath(`drive-${drive}.png`) });
    } finally {
      // Only remove this test's freshly allocated directory on the named volume.
      const absolute = path.resolve(parent);
      if (path.dirname(absolute) !== root || !path.basename(absolute).startsWith('onset-drive-e2e-')) {
        throw new Error('Refusing to remove an unexpected test directory: ' + absolute);
      }
      fs.rmSync(absolute, { recursive: true, force: true });
    }
  });
}
