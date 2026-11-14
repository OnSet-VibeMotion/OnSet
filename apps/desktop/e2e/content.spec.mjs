import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 从 internal/studio/ui/e2e/studio.spec.mjs 迁来：文件树、右键引用、@ 与 / 补全、回复里的风格海报、音频与 Markdown。

test('opens a project file from the tree', async ({ page, project }) => {
  await openProject(page, project);
  // 文件树只在「文件」页里。
  await page.locator('[data-tab="file"]').click();
  await page.locator('.tree-file', { hasText: 'notes.md' }).click();
  await expect(page.locator('#file-content')).toContainText('项目笔记');
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
  await page.locator('.tree-file', { hasText: 'notes.md' }).click({ button: 'right' });
  await page.locator('.ctx-item', { hasText: '引用这个文件到对话' }).click();
  await expect(page.locator('#attachments .quote-card')).toHaveCount(2);
  // 输入框里保留系统自己的菜单。
  await page.locator('#prompt').click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  await page.locator('#prompt').fill('这段太长');
  await page.locator('#send').click();
  await expect(page.locator('.user-extra')).toContainText('口播稿第 1 段（production/script-final.md）');
  await expect(page.locator('.user-extra')).toContainText('文件 notes.md');
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
  await page.locator('#prompt').fill('挑几张海报');
  await page.locator('#send').click();
  const picks = page.locator('.style-picks .style-pick');
  await expect(picks).toHaveCount(3);
  await expect(picks.first()).toContainText('油画厚涂');
  await expect(picks.first()).toContainText('厚涂有分量');
  await expect(picks.first()).toContainText('全片默认风格');
  await expect(picks.nth(1)).toContainText('浮世绘');
  await expect(page.locator('.message.assistant')).not.toContainText('film-styles');
  await expect(page.locator('.choices')).toContainText('不用整片风格');
  // 只推荐给一段的风格：标出用在哪，按钮与发出的话都不说成整片风格。
  const scoped = page.locator('.style-pick.scoped');
  await expect(scoped).toHaveCount(1);
  await expect(scoped).toContainText('只用在：回忆段，镜头 04–06');
  await expect(scoped.locator('button')).toHaveText('用在这一段');
  await expect(picks.first().locator('button')).toHaveText('设为整片风格');
  // 点全片默认的那张：把选择作为下一条消息发出。
  await picks.first().locator('button', { hasText: '设为整片风格' }).click();
  await expect(page.locator('.message.user').last()).toContainText('整片风格用「油画厚涂」（lemo-opuscar/impasto）');
  // 选过之后海报与其他选项收起，只留选中的风格名。
  await expect(page.locator('.choice-picked')).toContainText('油画厚涂');
  await expect(page.locator('.style-picks')).toHaveCount(0);
});

test('plays audio files a reply mentions', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#prompt').fill('做几个试听');
  await page.locator('#send').click();
  const item = page.locator('.media-strip .media-item.audio');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('try-A.wav');
  await expect(item.locator('audio')).toHaveAttribute('src', /production%2Faudio%2Fauditions%2Ftry-A\.wav/);
  // 原生播放控件的「⋮」菜单里不出现「下载」与「投放」。
  expect(await item.locator('audio').evaluate((el) => [el.controls, el.controlsList.contains('nodownload'), el.controlsList.contains('noremoteplayback')])).toEqual([true, true, true]);
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
  await prose.locator('code.file-link', { hasText: 'notes.md' }).click();
  await expect(page.locator('#file-content')).toContainText('项目笔记');
});

test('scene "more" menu opens as a popover inside the window, above the timeline', async ({ page, project, electronApp }) => {
  // 镜头有产物时菜单最长；窗口压矮，菜单不能被外层裁掉、也不能被时间线盖住。
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=1', '-pix_fmt', 'yuv420p', path.join(project.path, 'scenes', 'scene-001', 'out.mp4')]);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 640));
  await openProject(page, project);
  await page.locator('[data-tab="scene"]').click();
  await page.locator('.scene-menu > summary').click();
  const body = page.locator('.scene-menu-body');
  await expect(body).toBeVisible();
  const box = await body.boundingBox();
  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.h);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.w);
  // 菜单底边一带点到的是菜单自己，不是时间线。
  const onTop = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.scene-menu-body'), {
    x: box.x + box.width / 2,
    y: box.y + box.height - 6,
  });
  expect(onTop).toBe(true);
  await page.screenshot({ path: test.info().outputPath('scene-menu.png') });
  // 点外面收起。
  await page.locator('.scene-title').click();
  await expect(body).toBeHidden();
});

test('drags a region straight on the scene frame and asks about it', async ({ page, project }) => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=1', '-pix_fmt', 'yuv420p', path.join(project.path, 'scenes', 'scene-001', 'out.mp4')]);
  await openProject(page, project);
  await page.locator('[data-tab="scene"]').click();
  const layer = page.locator('.select-layer');
  await expect(layer).toBeVisible();
  const box = await layer.boundingBox();
  // 不用先进「圈选模式」：按下、拖动、松手就是一块选区，旁边出工具条。
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45, { steps: 5 });
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator('.select-box')).toBeVisible();
  await expect(page.locator('.selection-bar')).toBeVisible();
  // 点一下画面：清掉选区，不播放。
  await page.mouse.click(box.x + 20, box.y + 20);
  await expect(page.locator('.select-box')).toHaveCount(0);
  // 再圈一次，Esc 取消。
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  // 再圈，「说说这里…」把这一帧和选区带进输入框，等用户说哪里不对。
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45, { steps: 5 });
  await page.mouse.up();
  await page.screenshot({ path: test.info().outputPath('scene-region.png') });
  await page.locator('#fix-region').click();
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue(/圈出的这块/);
  await expect(page.locator('#attachments')).toContainText('圈选区域');
});

test('steps scene frames with the arrow keys', async ({ page, project }) => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=1', '-pix_fmt', 'yuv420p', path.join(project.path, 'scenes', 'scene-001', 'out.mp4')]);
  await openProject(page, project);
  await page.locator('[data-tab="scene"]').click();
  const frame = page.locator('.transport', { hasText: '帧' });
  await expect(frame).toContainText('帧 0 / 30');
  await page.locator('.scene-title').click();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(frame).toContainText('帧 3 / 30');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(frame).toContainText('帧 13 / 30');
  await page.keyboard.press('ArrowLeft');
  await expect(frame).toContainText('帧 12 / 30');
  // 输入框里的方向键照常移光标，不动画面。
  await page.locator('#prompt').fill('abc');
  await page.keyboard.press('ArrowLeft');
  await expect(frame).toContainText('帧 12 / 30');
});

test('memory page explains the loop in three steps and records a preference', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('[data-tab="memory"]').click();
  const flow = page.locator('.memory-flow li');
  await expect(flow).toHaveCount(3);
  await expect(flow.nth(0)).toContainText('记下的问题');
  await expect(flow.nth(1)).toContainText('整理成的提醒');
  await expect(flow.nth(2)).toContainText('scene-001 会带上 0 条');
  // 页头照实说：成片确认可用后才整理，经验要考试才带进渲染。
  await expect(page.locator('.memory-head')).toContainText('这一版可用');
  await expect(page.locator('.memory-head')).toContainText('考过了');
  // 没有失败时不出「记下的问题」一节，渲染日志收在「高级」里。
  await expect(page.locator('.memory-problems')).toHaveCount(0);
  await expect(page.locator('.memory-activity')).toBeHidden();
  await page.locator('.memory-preference').fill('节奏慢一点，每个画面多停一秒');
  await page.getByRole('button', { name: '记住' }).click();
  await expect(page.locator('.memory-card')).toContainText('节奏慢一点');
  await expect(flow.nth(1)).toContainText('你的要求 1');
});

test('approving the final film starts consolidating memory and goes to publish', async ({ page, project }) => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=1', '-pix_fmt', 'yuv420p', path.join(project.path, 'final.mp4')]);
  await fs.mkdir(path.join(project.path, 'production', 'review'), { recursive: true });
  await fs.writeFile(path.join(project.path, 'production', 'review', 'review.json'), JSON.stringify({ ok: true, problems: [] }));
  await openProject(page, project);
  await page.locator('[data-tab="final"]').click();
  // 成片的播放器没有「下载」。
  const film = page.locator('#panel video[controls]');
  await expect(film).toHaveCount(1);
  expect(await film.evaluate((el) => el.controlsList.contains('nodownload'))).toBe(true);
  await page.locator('#final-approve').click();
  await expect(page.locator('[data-tab="publish"]')).toHaveClass(/on/);
  const tasks = await page.evaluate(async () => (await (await fetch('/api/tasks')).json()).tasks);
  expect(tasks.some((t) => t.type === 'memory.consolidate')).toBe(true);
});

test('storyboard lists the plan and each scene’s description before rendering', async ({ page, project }) => {
  await fs.mkdir(path.join(project.path, 'production'), { recursive: true });
  await fs.writeFile(
    path.join(project.path, 'production', 'scene-plan.json'),
    JSON.stringify({
      schema: 1,
      look: { background: '#0F1720', ink: '#F5F1E8', accent: '#F2B134' },
      scenes: [{ id: 'scene-001', dir: 'scenes/scene-001', chapter: '开场', visual_role: '语境', summary: '一只猫推开门' }],
    }),
  );
  await fs.writeFile(path.join(project.path, 'production', 'treatment.md'), '# 处理方案\n\n主旨：猫也想看世界。\n');
  await fs.writeFile(project.promptFile, '# 开场\n\n门缝里透出一道光。\n');
  await openProject(page, project);
  // 分镜步骤排在口播稿与镜头之间。
  await expect(page.locator('.steps .step')).toHaveText([/口播稿/, /分镜/, /镜头/, /成片/, /发布/]);
  await page.locator('[data-tab="storyboard"]').click();
  await expect(page.locator('#storyboard .sb-title')).toHaveText('1 个镜头');
  await expect(page.locator('#storyboard .sb-chapter')).toHaveText('开场');
  await expect(page.locator('#storyboard .sb-summary')).toHaveText('一只猫推开门');
  await expect(page.locator('#storyboard .sb-text')).toHaveText('hello');
  await page.locator('#storyboard .sb-treatment summary').click();
  await expect(page.locator('#storyboard .sb-treatment')).toContainText('猫也想看世界');
  await page.locator('#storyboard .sb-prompt summary').click();
  await expect(page.locator('#storyboard .sb-prompt')).toContainText('门缝里透出一道光');
  // 右键镜头卡：引用镜头。
  await page.locator('#storyboard .sb-summary').click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toContainText('引用镜头 scene-001 到对话');
  await page.locator('#storyboard .sb-title').click();
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  // 确认交给对话。
  await page.locator('#storyboard-confirm').click();
  await expect(page.locator('#messages')).toContainText('分镜我看过了，没问题，开始渲染。');
  // 镜头页旁边有这个镜头的说明。
  await page.locator('[data-tab="scene"]').click();
  await expect(page.locator('#scene-brief')).toContainText('一只猫推开门');
});

test('a style recommended for one segment is sent as that segment’s style, not the whole film’s', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#prompt').fill('挑几张海报');
  await page.locator('#send').click();
  await page.locator('.style-pick.scoped button', { hasText: '用在这一段' }).click();
  const sent = page.locator('.message.user').last();
  await expect(sent).toContainText(/回忆段，镜头 04–06用「.+」风格（lemo-opuscar\/ink-wash），其余镜头不变/);
  await expect(sent).not.toContainText('整片风格');
  await expect(page.locator('.choice-picked')).toContainText('回忆段，镜头 04–06：');
});
