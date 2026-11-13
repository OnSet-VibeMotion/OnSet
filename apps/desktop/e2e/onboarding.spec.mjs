import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 首次使用引导与项目内的「接下来」。

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

  // 选导演：写进全局设置，出现填 key 的地方；填了之后导演就能用。
  await guide.locator('[data-step="ai"]').click();
  await guide.locator('[data-agent="director"]').click();
  await expect.poll(() => (fs.existsSync(sandbox.settings) ? fs.readFileSync(sandbox.settings, 'utf8') : '')).toContain('ORCHESTRATOR=director');
  const deepseek = guide.locator('li[data-provider="deepseek"]');
  await deepseek.getByRole('button', { name: '填写' }).click();
  await deepseek.getByLabel('DeepSeek 的 API key').fill('sk-guide');
  await deepseek.getByRole('button', { name: '保存' }).click();
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

async function write(root, rel, body) {
  await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fsp.writeFile(path.join(root, rel), body);
}

test('inside a project the next-step card says what to do now', async ({ page, project }) => {
  await write(project.path, 'production/script-final.md', '# 标题\n\n猫推开了门。\n');
  await write(project.path, 'production/audio/voice.wav', 'RIFF');
  await write(project.path, 'production/audio/voice.srt', '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  await write(project.path, 'production/scene-plan.json', JSON.stringify({ schema: 1, scenes: [{ id: 'scene-001', dir: 'scenes/scene-001', chapter: '开场' }] }));
  await openProject(page, project);

  const card = page.locator('#next-step');
  await expect(card).toContainText('分镜审核');
  await expect(card).toContainText('渲染前先看一遍');
  await page.screenshot({ path: test.info().outputPath('next-step.png') });

  // 「看分镜」打开分镜页；「我要改」只是把一句话填进输入框。
  await card.getByRole('button', { name: '看分镜' }).click();
  await expect(page.locator('#storyboard')).toBeVisible();
  await card.getByRole('button', { name: '我要改' }).click();
  await expect(page.locator('#prompt')).toHaveValue(/分镜这几处要改/);

  // 确认关卡：记下确认，把那句话发给 AI。
  await card.getByRole('button', { name: '没问题，开始渲染' }).click();
  await expect(page.locator('.message.user').last()).toContainText('分镜我看过了，没问题，开始渲染。');
  const gates = JSON.parse(await fsp.readFile(path.join(project.path, 'production', 'studio', 'gates.json'), 'utf8'));
  expect(Object.keys(gates.gates)).toEqual(['gate-storyboard']);
});
