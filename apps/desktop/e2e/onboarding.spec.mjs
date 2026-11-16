import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 首次使用引导（项目内的「接下来」卡片在 progress.spec.mjs）。

test('the first-run guide walks through tools, the orchestrator, voice and the first film', async ({ page, sandbox }) => {
  // 测试环境里工具都算装好、claude 也在：不会自动弹出，从首页左栏打开。
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('#onboarding')).toHaveCount(0);
  await page.locator('#open-guide').click();
  const guide = page.locator('#onboarding');
  await expect(guide).toBeVisible();
  await expect(guide.locator('[data-step="crew"]')).toHaveClass(/done/);
  await expect(guide.locator('[data-step="ai"]')).toHaveClass(/done/);
  // 第一个没做完的是配音。
  await expect(guide.locator('.ob-main h2')).toHaveText('配音方式');

  // 选制作人：写进全局设置，出现配置模型服务的表单（预设已经填好）；填了 key 保存之后制作人就能用。
  await guide.locator('[data-step="ai"]').click();
  await guide.locator('[data-agent="director"]').click();
  await expect.poll(() => (fs.existsSync(sandbox.settings) ? fs.readFileSync(sandbox.settings, 'utf8') : '')).toContain('ORCHESTRATOR=director');
  const form = guide.getByRole('form', { name: '添加模型服务' });
  await form.getByLabel('API key').fill('sk-guide');
  await form.getByRole('button', { name: '保存' }).click();
  await expect(guide.locator('[data-agent="director"]')).toContainText('在用');
  await page.screenshot({ path: test.info().outputPath('onboarding.png') });

  // 配音：先用默认的。
  await guide.locator('[data-step="voice"]').click();
  await guide.getByRole('button', { name: '先用默认的，以后再说' }).click();
  await expect(guide.locator('[data-step="voice"]')).toHaveClass(/done/);
  await expect(guide.locator('.ob-main h2')).toHaveText('开拍');

  // 去开拍：回到首页，之后不再自动出现。
  await guide.getByRole('button', { name: '去开拍' }).click();
  await expect(page.locator('#onboarding')).toHaveCount(0);
  await expect(page.locator('#home-prompt')).toBeVisible();
});

test.describe('without a renderer on this computer', () => {
  // 不固定渲染工具（走设置），PATH 只有假工具与系统目录：这台电脑上能渲染的只有假的 claude、codex、opencode。
  test.use({ appEnv: { RENDERER: null, ORCHESTRATOR: null, PATH: ['{fakeBin}', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter) } });

  test('picking the director still needs a renderer installed on this computer', async ({ page, sandbox }) => {
    // 全局设置里的渲染工具是 qoder，而这台（测试）电脑上只有 claude、codex、opencode。
    fs.writeFileSync(sandbox.settings, 'RENDERER=qoder\n');
    await page.reload();
    // 缺渲染工具也算没准备好：引导自动出现，停在第二步。
    const guide = page.locator('#onboarding');
    await expect(guide).toBeVisible();
    await expect(guide.locator('.ob-main h2')).toHaveText('请 AI 来编排');

    // 选制作人、配一套只读得了文字的服务（DeepSeek 预设不勾「能看图片」）：制作人能用了，但这一步仍没做完，「去开拍」不让点。
    await guide.locator('[data-agent="director"]').click();
    const form = guide.getByRole('form', { name: '添加模型服务' });
    await form.locator('[data-preset="deepseek"]').click();
    await expect(form.getByRole('checkbox')).not.toBeChecked();
    await form.getByLabel('API key').fill('sk-guide');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(guide.locator('.agent-service-list li').first()).toContainText('看不了画面');
    await expect(guide.locator('[data-agent="director"]')).toContainText('在用');
    await expect(guide.locator('#director-vision-note')).toContainText('看不了画面');

    const seat = guide.locator('#ob-renderer');
    await expect(seat.getByRole('alert')).toContainText('Qoder');
    await expect(seat.locator('[data-renderer="qoder"]')).toHaveCount(0);
    await expect(guide.locator('[data-step="ai"]')).not.toHaveClass(/done/);
    await page.screenshot({ path: test.info().outputPath('onboarding-renderer.png') });
    await guide.locator('[data-step="shoot"]').click();
    await expect(guide.getByRole('button', { name: '去开拍' })).toBeDisabled();

    // 从已经装好的里挑一家：写进全局设置，这一步就做完了。
    await guide.locator('[data-step="ai"]').click();
    await seat.locator('[data-renderer="claude"]').click();
    await expect.poll(() => fs.readFileSync(sandbox.settings, 'utf8')).toContain('RENDERER=claude');
    await expect(guide.locator('[data-step="ai"]')).toHaveClass(/done/);
    await expect(seat.getByRole('alert')).toHaveCount(0);
  });

  test('start production stays off while the renderer is not installed', async ({ page, project }) => {
    await write(project.path, 'onset.conf', 'ORCHESTRATOR=claude\nRENDERER=qoder\n');
    await openProject(page, project);
    await expect(page.locator('#start-production')).toBeDisabled();
    await expect(page.locator('#renderer-missing')).toContainText('Qoder');
    // 在输入框下方换一家装好的，就能开工。
    await page.locator('#agent-renderer').selectOption('claude');
    await expect(page.locator('#start-production')).toBeEnabled();
    await expect(page.locator('#renderer-missing')).toHaveCount(0);
  });
});

async function write(root, rel, body) {
  await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fsp.writeFile(path.join(root, rel), body);
}
