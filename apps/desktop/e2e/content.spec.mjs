import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 从 internal/studio/ui/e2e/studio.spec.mjs 迁来：文件树、右键引用、@ 与 / 补全、回复里的风格海报、音频与 Markdown。

test('opens a project file from the tree', async ({ page, project }) => {
  await openProject(page, project);
  // 文件树只在「文件」页里。
  await page.locator('[data-tab="file"]').click();
  await page.locator('.tree-file', { hasText: 'PROMPT.md' }).click();
  await expect(page.locator('#file-content')).toContainText('整片制作提示词');
});

test('right-click quotes script text and files into the chat', async ({ page, project }) => {
  await fs.mkdir(path.join(project.path, 'production'), { recursive: true });
  await fs.writeFile(path.join(project.path, 'production', 'script-final.md'), '# 开场\n\n第一段，<2025年|二零二五年>很贵。\n\n第二段。\n');
  await openProject(page, project);
  await page.locator('[data-tab="script"]').click();
  // 段落上右键：整段引用，引用里是字幕文字，不带读法。
  await page.locator('.script-body p').first().click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toContainText('口播稿第 1 段');
  await page.locator('.ctx-item', { hasText: '引用这一段到对话' }).click();
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  await expect(page.locator('#attachments .quote-card')).toContainText('第一段，2025年很贵。');
  await expect(page.locator('#attachments .quote-card')).not.toContainText('二零二五年');
  // 文件树上右键：引用文件。
  await page.locator('[data-tab="file"]').click();
  await page.locator('.tree-file', { hasText: 'PROMPT.md' }).click({ button: 'right' });
  await page.locator('.ctx-item', { hasText: '引用这个文件到对话' }).click();
  await expect(page.locator('#attachments .quote-card')).toHaveCount(2);
  // 输入框里保留系统自己的菜单。
  await page.locator('#prompt').click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  await page.locator('#prompt').fill('这段太长');
  await page.locator('#send').click();
  await expect(page.locator('.user-extra')).toContainText('口播稿第 1 段（production/script-final.md）');
  await expect(page.locator('.user-extra')).toContainText('文件 PROMPT.md');
});

test('completes @ mentions and / commands in the input', async ({ page, project }) => {
  await openProject(page, project);
  const prompt = page.locator('#prompt');
  // @：列出镜头与文件，选中后留在文字里，发送时变成引用。
  await prompt.fill('看看 @sce');
  await expect(page.locator('#completions')).toContainText('scene-001');
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('看看 @scene-001 ');
  await prompt.pressSequentially('太快了');
  await prompt.press('Enter');
  await expect(page.locator('.user-extra')).toContainText('镜头 scene-001');
  // /：命令在界面里执行，不发给编排工具。
  await prompt.fill('/scr');
  await expect(page.locator('#completions .completion').first()).toContainText('/script');
  await prompt.press('Enter');
  await expect(page.locator('[data-tab="script"]')).toHaveClass(/on/);
  await expect(prompt).toHaveValue('');
  // 带参数的命令：先选命令，再选参数。
  await prompt.fill('/sho');
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('/show ');
  await expect(page.locator('#completions')).toContainText('记忆');
  await prompt.pressSequentially('记忆');
  await prompt.press('Enter');
  await expect(page.locator('[data-tab="memory"]')).toHaveClass(/on/);
  // Esc 收起补全。
  await prompt.fill('@');
  await expect(page.locator('#completions')).toBeVisible();
  await prompt.press('Escape');
  await expect(page.locator('#completions')).toHaveCount(0);
});

test('shows posters for film styles the orchestrator recommends', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#prompt').fill('推荐风格');
  await page.locator('#send').click();
  const picks = page.locator('.style-picks .style-pick');
  await expect(picks).toHaveCount(2);
  await expect(picks.first()).toContainText('油画厚涂');
  await expect(picks.first()).toContainText('厚涂有分量');
  await expect(picks.nth(1)).toContainText('浮世绘');
  await expect(page.locator('.message.assistant')).not.toContainText('film-styles');
  await expect(page.locator('.choices')).toContainText('不用整片风格');
  // 点「用这个风格」：把选择作为下一条消息发出。
  await picks.first().locator('button', { hasText: '用这个风格' }).click();
  await expect(page.locator('.message.user').last()).toContainText('整片风格用「油画厚涂」（lemo-opuscar/impasto）');
});

test('plays audio files a reply mentions', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#prompt').fill('做几个试听');
  await page.locator('#send').click();
  const item = page.locator('.media-strip .media-item.audio');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('try-A.wav');
  await expect(item.locator('audio')).toHaveAttribute('src', /production%2Faudio%2Fauditions%2Ftry-A\.wav/);
});

test('renders GitHub-flavored markdown safely', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#prompt').fill('排版测试');
  await page.locator('#send').click();
  const prose = page.locator('.message.assistant .prose');
  await expect(prose.locator('table td').nth(1)).toHaveText('稳重');
  await expect(prose.locator('h3')).toHaveText('标题');
  await expect(prose.locator('li ul li')).toHaveText('第二层');
  await expect(prose.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(prose.locator('del')).toHaveText('删掉');
  // 中文里收尾的 ** 前是标点、后面紧跟汉字，也要认成粗体。
  await expect(prose.locator('strong', { hasText: '好。' })).toHaveCount(1);
  await expect(prose.locator('a[href="https://example.com"]')).toHaveAttribute('target', '_blank');
  await expect(prose.locator('pre .code-lang')).toHaveText('bash');
  // 清洗：脚本、事件属性、javascript: 链接都不留。
  await expect(prose.locator('script')).toHaveCount(0);
  await expect(prose.locator('[onerror]')).toHaveCount(0);
  await expect(prose.locator('a[href^="javascript"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  // 写成行内代码的项目文件可点，打开文件页。
  await prose.locator('code.file-link', { hasText: 'PROMPT.md' }).click();
  await expect(page.locator('#file-content')).toContainText('整片制作提示词');
});
