import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test, expect, openProject } from './fixtures.mjs';

test.describe('Producer renderer settings', () => {
  test.use({ appEnv: { RENDERER: null } });
  test('selects the Producer, lists models from the custom service, and keeps the home tool menu in step', async ({ page, sandbox }) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'custom-render-model' }, { id: 'custom-other-model' }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      // 还没有模型服务：首页的工具菜单里制作人不能选。
      const homeTool = page.locator('#home-tool');
      const director = page.getByRole('menuitemradio', { name: /^制作人/ });
      await homeTool.click();
      await expect(director).toBeDisabled();
      await homeTool.click();
      await page.locator('#settings-trigger').click();
      const dialog = page.locator('#settings-dialog');
      const section = dialog.locator('section.agent-services');
      const form = dialog.getByRole('form', { name: '添加模型服务' });
      await form.locator('[data-preset=""]').click();
      await form.getByLabel('名称', { exact: true }).fill('自定义渲染服务');
      await form.getByLabel('Base URL').fill(`http://127.0.0.1:${server.address().port}/v1`);
      await form.getByLabel('API key').fill('sk-refresh-test');
      await form.getByLabel('模型', { exact: true }).fill('custom-render-model');
      await form.getByRole('button', { name: '保存' }).click();
      await expect(page.locator('.agent-service-list li')).toContainText('自定义渲染服务');
      // 存下服务后首页菜单立刻能选制作人，不用重开。
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await homeTool.click();
      await expect(director).toBeEnabled();
      await director.click();
      await expect(homeTool).toContainText('制作人');
      await page.locator('#settings-trigger').click();
      const renderer = page.getByLabel('全局画镜头的工具');
      await expect(renderer.locator('option[value="director"]')).toHaveText('制作人');
      await renderer.selectOption('director');
      await expect.poll(() => fs.readFileSync(sandbox.settings, 'utf8')).toContain('RENDERER=director');
      const model = page.getByLabel('全局画镜头的模型');
      await expect(model.locator('option[value="custom-other-model"]')).toHaveCount(1);
      await model.selectOption('custom-other-model');
      await expect.poll(() => fs.readFileSync(sandbox.settings, 'utf8')).toContain('RENDERER_MODEL=custom-other-model');
      // 删掉服务：首页菜单里的制作人跟着变回不能选。
      await section.getByRole('button', { name: '删除', exact: true }).click();
      await expect(section.locator('.agent-service-list li')).toHaveCount(0);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await homeTool.click();
      await expect(director).toBeDisabled();
      await expect(homeTool).not.toContainText('制作人');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('settings pick what to use for every project, and one project can differ', async ({ page, project, sandbox }) => {
  await openProject(page, project);
  await page.locator('#settings-trigger').click();
  const dialog = page.locator('#settings-dialog');
  const row = (key) => dialog.locator(`.settings-row[data-key="${key}"]`);

  // 全局：配音改成 Edge（默认那一家只以「默认」出现一次，挑一个不是默认的），写进用户级的全局设置文件。
  await row('TTS_PROVIDER').getByLabel('全局配音').selectOption('edge');
  await expect.poll(() => (fs.existsSync(sandbox.settings) ? fs.readFileSync(sandbox.settings, 'utf8') : '')).toContain('TTS_PROVIDER=edge');
  // 测试项目没单独设配音：只露一个下拉框；点「只给这个项目换」才展开，默认和其他项目一样（Edge）。
  await expect(row('TTS_PROVIDER').getByLabel('这个项目的配音')).toHaveCount(0);
  await row('TTS_PROVIDER').getByRole('button', { name: '只给这个项目换' }).click();
  await expect(row('TTS_PROVIDER').getByLabel('这个项目的配音')).toContainText('和其他项目一样（微软 Edge');
  await row('TTS_PROVIDER').getByRole('button', { name: '算了' }).click();
  await expect(row('TTS_PROVIDER').getByLabel('这个项目的配音')).toHaveCount(0);
  // 渲染模型：可选的是渲染工具（默认 claude）报的模型，写进全局设置。
  await row('RENDERER_MODEL').getByLabel('全局画镜头的模型').selectOption('sonnet');
  await expect.poll(() => fs.readFileSync(sandbox.settings, 'utf8')).toContain('RENDERER_MODEL=sonnet');
  // 编排工具被测试环境的环境变量定死了：页面照实说。
  await expect(row('ORCHESTRATOR')).toContainText('被电脑上的环境变量定死了');

  // 这个项目单独把同时渲染改成 5 个：写进项目配置（写任务）。
  const conf = path.join(project.path, 'onset.conf');
  await row('SCENE_JOBS').getByRole('button', { name: '只给这个项目换' }).click();
  await row('SCENE_JOBS').getByLabel('这个项目的同时画几个镜头').selectOption('5');
  await expect.poll(() => fs.readFileSync(conf, 'utf8')).toContain('SCENE_JOBS=5');
  await expect(row('SCENE_JOBS').getByLabel('这个项目的同时画几个镜头')).toHaveClass(/overridden/);
  await page.screenshot({ path: test.info().outputPath('settings.png') });

  // 全部跟随全局：项目里单独设的几项都清空。
  await dialog.getByRole('button', { name: /全部改回和其他项目一样/ }).click();
  await expect.poll(() => fs.readFileSync(conf, 'utf8')).toMatch(/^SCENE_JOBS=$/m);
  await expect(row('SCENE_JOBS').getByLabel('这个项目的同时画几个镜头')).toHaveCount(0);
});

test('a large custom model catalogue scrolls and can be filtered or selected by keyboard', async ({ page, project }) => {
  const models = Array.from({ length: 97 }, (_, i) => `provider/model-${String(i).padStart(3, '0')}`);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await openProject(page, project);
    await page.locator('#settings-trigger').click();
    const form = page.locator('#settings-dialog section.agent-services').getByRole('form', { name: '添加模型服务' });
    await form.locator('[data-preset=""]').click();
    await form.getByLabel('Base URL').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await form.getByRole('button', { name: '读取模型列表' }).click();
    const list = form.getByRole('listbox', { name: '可选模型' });
    await expect(list.getByRole('option')).toHaveCount(97);
    const input = form.getByRole('combobox', { name: '模型', exact: true });
    const geometry = await list.evaluate((el) => ({ height: el.clientHeight, scrollHeight: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
    expect(geometry.height).toBeLessThanOrEqual(240);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
    expect(geometry.overflow).toBe('scroll');
    await list.hover();
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await list.getByRole('option', { name: models[96], exact: true }).click();
    await expect(input).toHaveValue(models[96]);
    await expect(list).toHaveCount(0);
    await form.getByRole('button', { name: '展开模型列表' }).click();
    await expect(list.getByRole('option')).toHaveCount(97);
    await input.fill('model-096');
    await expect(list.getByRole('option')).toHaveCount(1);
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(input).toHaveValue(models[96]);
    await expect(list).toHaveCount(0);
    await input.fill('my-private-model');
    await expect(form.getByText('没有匹配的模型，可以直接使用输入的名称')).toBeVisible();
    await input.press('Escape');
    await expect(input).toHaveValue('my-private-model');
    await expect(list).toHaveCount(0);
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await form.getByRole('button', { name: '展开模型列表' }).click();
    await list.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('scrollable-model-catalogue.png') });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('the Director keeps several model services, prefilled by presets that reset when switched to custom, and never shows a key back', async ({ page, project, sandbox }) => {
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
  // 从预设换回自定义：服务商带来的字段全部清空，要重新填。
  for (const preset of ['deepseek', 'anthropic']) {
    await second.locator(`[data-preset="${preset}"]`).click();
    await second.locator('[data-preset=""]').click();
    await expect(second.getByLabel('名称', { exact: true })).toHaveValue('');
    await expect(second.getByLabel('协议')).toHaveValue('openai');
    await expect(second.getByLabel('Base URL')).toHaveValue('');
    await expect(second.getByLabel('模型', { exact: true })).toHaveValue('');
    await expect(second.getByRole('checkbox')).toBeChecked();
    await expect(second.getByRole('link', { name: '去申请' })).toHaveCount(0);
    await expect(second.getByRole('button', { name: '保存' })).toBeDisabled();
  }
  // 已经是自定义时，再点一次不丢掉手填内容。
  await second.getByLabel('名称', { exact: true }).fill('本机服务');
  await second.getByLabel('Base URL').fill('http://localhost:8080/v1');
  await second.locator('[data-preset=""]').click();
  await expect(second.getByLabel('名称', { exact: true })).toHaveValue('本机服务');
  await expect(second.getByLabel('Base URL')).toHaveValue('http://localhost:8080/v1');
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
  // Windows stat mode does not represent its access-control list.
  if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
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

  // 制作人可以用于编排，也可以用配置的模型服务画镜头。
  const row = (key) => page.locator(`#settings-dialog .settings-row[data-key="${key}"]`);
  await expect(row('ORCHESTRATOR').getByLabel('全局对话助手').locator('option[value="director"]')).toHaveCount(1);
  await expect(row('RENDERER').getByLabel('全局画镜头的工具').locator('option[value="director"]')).toHaveCount(1);

  // 删掉在用的那套：改用剩下的。
  await relay.getByRole('button', { name: '删除' }).click();
  await expect(relay).toHaveCount(0);
  await expect(first).toContainText('在用');
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).services).toHaveLength(1);
});
