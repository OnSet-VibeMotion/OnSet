import fs from 'node:fs';
import { test, expect } from './fixtures.mjs';

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

// 缺渲染工具时的引导与「开始制作」是组件测试：src/renderer/components/Onboarding.test.tsx、StartProduction.test.tsx、agentReady.test.ts。
