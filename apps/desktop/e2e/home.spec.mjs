import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject, api } from './fixtures.mjs';

// 从 internal/studio/ui/e2e/studio.spec.mjs 迁来：首页一句话新建项目。

test('starts a new video from the home page', async ({ page, project, sandbox }) => {
  // 先打开一个项目，让「保存到」默认落在测试用的临时 HOME 里，再回到首页。
  await openProject(page, project);
  await page.locator('.brand').click();
  await expect(page.locator('.home-hero h1')).toContainText('今天想做一条');
  await expect(page.locator('.rail-row', { hasText: project.name })).toBeVisible();

  await page.locator('.template-card', { hasText: '横屏讲解' }).click();
  await expect(page.locator('#home-canvas')).toContainText('16:9');
  // 整片风格菜单：默认不用整片风格，列出风格库的风格，可以搜索。
  await expect(page.locator('#home-style')).toContainText('不用整片风格');
  await page.locator('#home-style').click();
  await expect(page.locator('.film-styles .fs-item.none')).toBeVisible();
  await page.locator('.film-styles .fs-search').fill('油画');
  await expect(page.locator('.film-styles .fs-item[data-style="lemo-opuscar/impasto"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#film-style-dialog')).toHaveCount(0);
  await expect(page.locator('#home-style')).toContainText('不用整片风格');
  // 弹窗里单击只是选中，确认才生效；再选回「不用整片风格」。
  await page.locator('#home-style').click();
  await page.locator('#film-style-dialog .fs-item[data-style="lemo-opuscar/impasto"]').click();
  await expect(page.locator('#film-style-dialog')).toBeVisible();
  await page.locator('#film-style-confirm').click();
  await expect(page.locator('#home-style')).toContainText('油画');
  await page.locator('#home-style').click();
  await page.locator('#film-style-dialog .fs-item.none').dblclick();
  await expect(page.locator('#home-style')).toContainText('不用整片风格');

  await page.locator('#home-prompt').fill('首页端到端测试，讲讲复利');
  await page.locator('#home-send').click();

  // 开机画面：先由编排工具起片名（假 claude 回「首页端到端测试的片子」），场记板写着它；时间线上六段片段依次完成
  // （没选整片风格时那一段标「不用」），最后打板进项目。
  await expect(page.locator('.creation .slate')).toContainText('首页端到端测试的片子');
  await expect(page.locator('.creation .clip')).toHaveCount(6);
  await expect(page.locator('.creation .clip', { hasText: '整片风格' })).toContainText('不用');
  await expect(page.locator('.creation')).toHaveCount(0, { timeout: 15_000 });

  // 建好项目、开始制作后直接进到新项目，对话里是整片制作这一轮。
  await expect(page.locator('#title')).toContainText('首页端到端测试的片子');
  await expect(page.locator('#session-title')).toContainText('整片制作');
  await expect(page.locator('.message.user').first()).toContainText('首页端到端测试，讲讲复利');
  const projects = await api(page, '/api/projects');
  const created = projects.body.projects.find((p) => p.name.startsWith('首页端到端测试的片子-'));
  expect(created).toBeTruthy();
  // 新项目落在临时 HOME 里，不会写到用户真实目录。
  expect(created.path.startsWith(sandbox.home + path.sep)).toBe(true);
  await expect.poll(async () => (await fs.readFile(path.join(created.path, 'frame.md'), 'utf8')).includes('1920')).toBe(true);
});

async function dropPaths(page, files) {
  const box = await page.locator('.home .input-card').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files, dragOperationsMask: 1 };
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', { type, x: box.x + 30, y: box.y + 30, data });
    }
  } finally {
    await cdp.detach();
  }
}

test('home imports dropped folders as references, preserves nested files', async ({ page, project, sandbox }, testInfo) => {
  await openProject(page, project);
  await page.locator('.brand').click();
  const folder = path.join(sandbox.home, '参考 素材');
  await fs.mkdir(path.join(folder, '子目录'), { recursive: true });
  await fs.mkdir(path.join(folder, '空目录'));
  await fs.writeFile(path.join(folder, '讲稿.md'), '# 根讲稿');
  await fs.writeFile(path.join(folder, 'empty.txt'), '');
  await fs.writeFile(path.join(folder, '子目录', '讲稿.md'), '# 子讲稿');
  // Chromium's native drag path supplies real FileSystemEntry objects for a directory.
  await dropPaths(page, [folder]);
  await expect(page.locator('.home-tray')).toContainText('文件夹');
  await expect(page.locator('.home-tray')).toContainText('参考 素材');
  await expect(page.locator('.home-tray')).toContainText('3 个文件');
  await page.locator('.composer-card').screenshot({ path: testInfo.outputPath('home-folder-reference.png') });
  await page.locator('#home-prompt').fill('参考这些素材制作视频');
  await page.locator('#home-send').click();
  await expect(page.locator('.creation')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.user-extra').first()).toContainText('文件夹「参考 素材」');
  const projects = await api(page, '/api/projects');
  const created = projects.body.projects.find((p) => p.path !== project.path);
  expect(created).toBeTruthy();
  const uploads = path.join(created.path, 'production/studio/uploads');
  const [imported] = await fs.readdir(uploads);
  expect(await fs.readFile(path.join(uploads, imported, '讲稿.md'), 'utf8')).toBe('# 根讲稿');
  expect(await fs.readFile(path.join(uploads, imported, '子目录/讲稿.md'), 'utf8')).toBe('# 子讲稿');
  expect((await fs.stat(path.join(uploads, imported, '空目录'))).isDirectory()).toBe(true);
  expect((await fs.stat(path.join(uploads, imported, 'empty.txt'))).size).toBe(0);
});

test('home keeps regular file uploads and removes pending folder references', async ({ page, project, sandbox }) => {
  await openProject(page, project);
  await page.locator('.brand').click();
  const folder = path.join(sandbox.home, '空素材');
  await fs.mkdir(folder);
  await dropPaths(page, [folder]);
  await expect(page.locator('.home-tray')).toContainText('文件夹');
  await page.locator('.home-tray button[aria-label="移除"]').click();
  await expect(page.locator('.home-tray')).toHaveCount(0);
  await page.locator('.home input[type="file"]').setInputFiles({ name: '文章.md', mimeType: 'text/markdown', buffer: Buffer.from('# 上传文章') });
  await expect(page.locator('.home-tray')).toContainText('文章.md');
  await page.locator('#home-prompt').fill('做成视频');
  await page.locator('#home-send').click();
  await expect(page.locator('.creation')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.user-extra').first()).toContainText('文章.md');
  const projects = await api(page, '/api/projects');
  const created = projects.body.projects.find((p) => p.path !== project.path);
  const uploads = path.join(created.path, 'production/studio/uploads');
  const imported = await fs.readdir(uploads);
  expect(imported).toHaveLength(1);
  expect(await fs.readFile(path.join(uploads, imported[0]), 'utf8')).toBe('# 上传文章');
});

test('home reads every directory batch and keeps the composer usable after a failed drop', async ({ page, project, sandbox }) => {
  await openProject(page, project);
  await page.locator('.brand').click();
  const folder = path.join(sandbox.home, '批量素材');
  await fs.mkdir(folder);
  await Promise.all(Array.from({ length: 105 }, (_, index) => fs.writeFile(path.join(folder, `素材-${index}.txt`), 'text')));
  await dropPaths(page, [folder]);
  await expect(page.getByRole('list', { name: '引用素材' })).toContainText('105 个文件');
  await expect(page.locator('#home-send')).toBeEnabled();
  await fs.writeFile(path.join(folder, '.env'), 'SECRET=test');
  await dropPaths(page, [folder]);
  await expect(page.locator('.home')).toContainText('.env 不能上传');
  await expect(page.locator('.home-tray li')).toHaveCount(1);
  await expect(page.locator('#home-send')).toBeEnabled();
});
