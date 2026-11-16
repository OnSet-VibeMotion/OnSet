import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject, api } from './fixtures.mjs';

// 从 internal/studio/ui/e2e/studio.spec.mjs 迁来：首页一句话新建项目。
// 拖进文件夹、批量读取、.env 拦截与上传请求在 src/renderer/components/Home.test.tsx。

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
