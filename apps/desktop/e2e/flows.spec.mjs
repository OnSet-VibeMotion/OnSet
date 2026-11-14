import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 顶栏按项目的流程声明排（/api/state 的 flow），不按片型写死：卡点项目第一步是节拍、不列口播稿。
// 流程只来自锁文件里新建时记下的那一段；没有记录的目录排不出路线，照实说。

/** 把 fixture 项目记成另一个流程（或去掉记录）。 */
function recordFlow(project, id) {
  const lock = path.join(project.path, 'onset.flow.json');
  if (id === '') fs.rmSync(lock);
  else fs.writeFileSync(lock, JSON.stringify({ version: 1, production: { id, canvas: 'vertical-3x4' } }, null, 2) + '\n');
}

test('the top bar follows the flow of the project', async ({ page, project }) => {
  fs.writeFileSync(path.join(project.path, 'beat.yaml'), 'schema: 1\n');
  recordFlow(project, 'beat');
  await openProject(page, project);
  const steps = page.locator('nav.steps .step:not(.route-step)');
  await expect(steps.first()).toHaveAttribute('data-tab', 'beat');
  await expect(steps).toHaveCount(5);
  await expect(page.locator('nav.steps [data-tab="script"]')).toHaveCount(0);
  // 用不上的口播稿页不在「页面」菜单里，节拍是步骤，也不重复列。
  await page.locator('#page-menu-trigger').click();
  await expect(page.locator('.page-menu-list [data-tab]').first()).toBeVisible();
  await expect(page.locator('.page-menu-list [data-tab="script"]')).toHaveCount(0);
  await expect(page.locator('.page-menu-list [data-tab="beat"]')).toHaveCount(0);
});

test('a speech project lists the script first and hides the beat page', async ({ page, project }) => {
  await openProject(page, project);
  await expect(page.locator('nav.steps .step:not(.route-step)').first()).toHaveAttribute('data-tab', 'script');
  await expect(page.locator('[data-tab="beat"]')).toHaveCount(0);
});

test('a directory without a flow record says so on the route page', async ({ page, project }) => {
  // beat.yaml 不再决定流程：没有记录就是没有记录。
  fs.writeFileSync(path.join(project.path, 'beat.yaml'), 'schema: 1\n');
  recordFlow(project, '');
  await openProject(page, project);
  await page.locator('#progress-open').click();
  await expect(page.locator('#progress-flow-error')).toContainText('这个目录没有流程记录');
  await expect(page.locator('#progress-flow-error')).toContainText('不是用这一版片场新建的项目');
});

test('confirming the storyboard of a beat project records the beat storyboard gate', async ({ page, project }) => {
  fs.writeFileSync(path.join(project.path, 'beat.yaml'), 'schema: 1\n');
  recordFlow(project, 'beat');
  // 卡点的分镜计划（按小节）：分镜关卡绑定的是它。
  fs.mkdirSync(path.join(project.path, 'production', 'beat'), { recursive: true });
  fs.writeFileSync(path.join(project.path, 'production', 'beat', 'plan.json'), JSON.stringify({ schema: 1, scenes: [{ id: 'scene-001', bars: 2 }] }));
  await openProject(page, project);
  await page.locator('nav.steps [data-tab="storyboard"]').click();
  await page.locator('#storyboard-confirm').click();
  await expect(page.locator('.message.user').last()).toContainText('分镜我看过了，没问题，开始渲染。');
  await expect.poll(() => {
    const file = path.join(project.path, 'production', 'studio', 'gates.json');
    return fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).gates) : [];
  }).toEqual(['gate-beat-storyboard']);
  // 路线页上那一站显示已确认。
  await page.locator('#progress-open').click();
  await expect(page.locator('[data-station="gate-beat-storyboard"]')).toContainText('你在');
});
