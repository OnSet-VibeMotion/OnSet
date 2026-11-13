import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 顶栏按项目的流程声明排（/api/state 的 flow），不按片型写死：卡点项目第一步是节拍、不列口播稿；
// 有流程记录的项目改过制作说明时，路线页照实说。

test('the top bar follows the flow of the project', async ({ page, project }) => {
  fs.writeFileSync(path.join(project.path, 'beat.yaml'), 'schema: 1\n');
  await openProject(page, project);
  const steps = page.locator('nav.steps [data-tab]');
  await expect(steps.first()).toHaveAttribute('data-tab', 'beat');
  await expect(steps).toHaveCount(5);
  await expect(page.locator('nav.steps [data-tab="script"]')).toHaveCount(0);
  await expect(page.locator('nav.more-pages [data-tab="script"]')).toHaveCount(0);
  await expect(page.locator('nav.more-pages [data-tab="beat"]')).toHaveCount(0);
});

test('a speech project lists the script first and hides the beat page', async ({ page, project }) => {
  await openProject(page, project);
  await expect(page.locator('nav.steps [data-tab]').first()).toHaveAttribute('data-tab', 'script');
  await expect(page.locator('[data-tab="beat"]')).toHaveCount(0);
});

test('the route page says when the project uses its own edited production prompt', async ({ page, project }) => {
  const prompt = path.join(project.path, 'PROMPT-PRODUCTION.md');
  fs.writeFileSync(prompt, '原样\n');
  const digest = (await import('node:crypto')).createHash('sha256').update('原样\n').digest('hex');
  fs.writeFileSync(
    path.join(project.path, 'article-to-motion.flow.json'),
    JSON.stringify({ version: 1, production: { id: 'speech', compose: 1, canvas: 'vertical-3x4', prompt_sha256: digest }, stations: [] }, null, 2) + '\n',
  );
  // 新建时记下的摘要对不上：用户改过（没改过时不显示，见 studio/flowview.test.ts）。
  fs.writeFileSync(prompt, '我改过了\n');
  await openProject(page, project);
  await page.locator('#progress-open').click();
  await expect(page.locator('#progress-page')).toBeVisible();
  await expect(page.locator('#progress-custom-prompt')).toHaveText('这个项目用的是自己改过的制作说明');
});
