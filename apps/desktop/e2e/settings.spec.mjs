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
  const conf = path.join(project.path, 'onset.conf');
  await row('SCENE_JOBS').getByLabel('这个项目的同时渲染').selectOption('5');
  await expect.poll(() => fs.readFileSync(conf, 'utf8')).toContain('SCENE_JOBS=5');
  await expect(row('SCENE_JOBS').getByLabel('这个项目的同时渲染')).toHaveClass(/overridden/);
  await page.screenshot({ path: test.info().outputPath('settings.png') });

  // 全部跟随全局：项目里单独设的几项都清空。
  await dialog.getByRole('button', { name: '全部跟随全局' }).click();
  await expect.poll(() => fs.readFileSync(conf, 'utf8')).toMatch(/^SCENE_JOBS=$/m);
  await expect(row('SCENE_JOBS').getByLabel('这个项目的同时渲染')).not.toHaveClass(/overridden/);
});

test('the Director keeps several model services, prefilled by presets, and never shows a key back', async ({ page, project, sandbox }) => {
  await openProject(page, project);
  await page.locator('#settings-trigger').click();
  const section = page.locator('#settings-dialog section.agent-services');
  // 一套都没有：表单直接打开，预设已经填好第一家。
  const form = section.getByRole('form', { name: '添加模型服务' });
  await expect(form.getByLabel('Base URL')).toHaveValue('https://api.deepseek.com');
  await expect(form.getByLabel('模型', { exact: true })).toHaveValue('deepseek-v4-pro');
  // 换个预设：地址、协议、模型跟着换。
  await form.locator('[data-preset="anthropic"]').click();
  await expect(form.getByLabel('协议')).toHaveValue('anthropic');
  await expect(form.getByLabel('Base URL')).toHaveValue('https://api.anthropic.com');
  await form.locator('[data-preset="deepseek"]').click();
  await form.getByLabel('API key').fill('sk-e2e-secret');
  await page.screenshot({ path: test.info().outputPath('agent-service-form.png') });
  await form.getByRole('button', { name: '保存' }).click();
  const first = section.locator('.agent-service-list li').first();
  await expect(first).toContainText('DeepSeek');
  await expect(first).toContainText('在用');
  await expect(first).toContainText('看不了画面');

  // 再加一套手填的：OpenAI 兼容的中转。
  await section.getByRole('button', { name: '添加' }).click();
  const second = section.getByRole('form', { name: '添加模型服务' });
  await second.locator('[data-preset=""]').click();
  await second.getByLabel('名称', { exact: true }).fill('公司中转');
  await second.getByLabel('Base URL').fill('https://relay.example.com/v1/');
  await second.getByLabel('API key').fill('sk-relay');
  await second.getByLabel('模型', { exact: true }).fill('gpt-x');
  await second.getByRole('button', { name: '保存' }).click();
  const relay = section.locator('.agent-service-list li', { hasText: '公司中转' });
  await expect(relay).toContainText('https://relay.example.com/v1 · gpt-x');
  await relay.getByRole('radio').click();
  await expect(relay).toContainText('在用');
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('agent-services.png') });

  const file = path.join(sandbox.agent, 'services.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(saved.services.map((s) => s.key)).toEqual(['sk-e2e-secret', 'sk-relay']);
  expect(saved.active).toBe(saved.services[1].id);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  // key 只写进那个文件，页面与接口都不回传。
  expect(await page.content()).not.toContain('sk-e2e-secret');

  // 编辑时 key 留空：不换。
  await relay.getByRole('button', { name: '编辑' }).click();
  const edit = section.getByRole('form', { name: '编辑模型服务' });
  await expect(edit.getByLabel('API key')).toHaveAttribute('placeholder', /留空不更换/);
  await edit.getByLabel('模型', { exact: true }).fill('gpt-y');
  await edit.getByRole('button', { name: '保存' }).click();
  await expect(relay).toContainText('gpt-y');
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).services[1].key).toBe('sk-relay');

  // 编排可以选导演，渲染不行（暂时只做编排）。
  const row = (key) => page.locator(`#settings-dialog .settings-row[data-key="${key}"]`);
  await expect(row('ORCHESTRATOR').getByLabel('全局编排').locator('option[value="director"]')).toHaveCount(1);
  await expect(row('RENDERER').getByLabel('全局渲染').locator('option[value="director"]')).toHaveCount(0);

  // 删掉在用的那套：改用剩下的。
  await relay.getByRole('button', { name: '删除' }).click();
  await expect(relay).toHaveCount(0);
  await expect(first).toContainText('在用');
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).services).toHaveLength(1);
});
