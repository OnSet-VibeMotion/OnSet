import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

test('settings pick what to use for every project, and one project can differ', async ({ page, project, sandbox }) => {
  await openProject(page, project);
  await page.locator('#settings-trigger').click();
  const dialog = page.locator('#settings-dialog');
  const row = (key) => dialog.locator(`.settings-row[data-key="${key}"]`);

  // 全局：配音改成 Breeze，写进用户级的全局设置文件。
  await row('TTS_PROVIDER').getByLabel('全局配音').selectOption('breeze');
  await expect.poll(() => (fs.existsSync(sandbox.settings) ? fs.readFileSync(sandbox.settings, 'utf8') : '')).toContain('TTS_PROVIDER=breeze');
  // 测试项目没单独设配音：「这个项目」显示跟随全局，值是 Breeze。
  await expect(row('TTS_PROVIDER').getByLabel('这个项目的配音')).toContainText('跟随全局（Breeze TTS 2');
  // 渲染模型：可选的是渲染工具（默认 claude）报的模型，写进全局设置。
  await row('RENDERER_MODEL').getByLabel('全局渲染模型').selectOption('sonnet');
  await expect.poll(() => fs.readFileSync(sandbox.settings, 'utf8')).toContain('RENDERER_MODEL=sonnet');
  // 编排工具被测试环境的环境变量定死了：页面照实说。
  await expect(row('ORCHESTRATOR')).toContainText('被环境变量覆盖');

  // 这个项目单独把同时渲染改成 5 个：写进项目配置（写任务）。
  const conf = path.join(project.path, 'article-to-motion.conf');
  await row('SCENE_JOBS').getByLabel('这个项目的同时渲染').selectOption('5');
  await expect.poll(() => fs.readFileSync(conf, 'utf8')).toContain('SCENE_JOBS=5');
  await expect(row('SCENE_JOBS').getByLabel('这个项目的同时渲染')).toHaveClass(/overridden/);
  await page.screenshot({ path: test.info().outputPath('settings.png') });

  // 全部跟随全局：项目里单独设的几项都清空。
  await dialog.getByRole('button', { name: '全部跟随全局' }).click();
  await expect.poll(() => fs.readFileSync(conf, 'utf8')).toMatch(/^SCENE_JOBS=$/m);
  await expect(row('SCENE_JOBS').getByLabel('这个项目的同时渲染')).not.toHaveClass(/overridden/);
});

test('the Director takes a model service key that never comes back to the page', async ({ page, project, sandbox }) => {
  await openProject(page, project);
  await page.locator('#settings-trigger').click();
  const keys = page.locator('#settings-dialog section.agent-keys');
  const deepseek = keys.locator('li[data-provider="deepseek"]');
  await expect(deepseek).toContainText('未填写');

  await deepseek.getByRole('button', { name: '填写' }).click();
  await deepseek.getByLabel('DeepSeek 的 API key').fill('sk-e2e-secret');
  await deepseek.getByRole('button', { name: '保存' }).click();
  await expect(deepseek).toContainText('已填写');
  await keys.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('agent-keys.png') });
  const auth = path.join(sandbox.agent, 'auth.json');
  expect(JSON.parse(fs.readFileSync(auth, 'utf8')).deepseek.key).toBe('sk-e2e-secret');
  expect(fs.statSync(auth).mode & 0o777).toBe(0o600);
  // key 只写进那个文件，页面与接口都不回传。
  expect(await page.content()).not.toContain('sk-e2e-secret');

  // 编排可以选导演，渲染不行（暂时只做编排）。
  const row = (key) => page.locator(`#settings-dialog .settings-row[data-key="${key}"]`);
  await expect(row('ORCHESTRATOR').getByLabel('全局编排').locator('option[value="director"]')).toHaveCount(1);
  await expect(row('RENDERER').getByLabel('全局渲染').locator('option[value="director"]')).toHaveCount(0);

  await deepseek.getByRole('button', { name: '删除' }).click();
  await expect(deepseek).toContainText('未填写');
  expect(JSON.parse(fs.readFileSync(auth, 'utf8')).deepseek).toBeUndefined();
});
