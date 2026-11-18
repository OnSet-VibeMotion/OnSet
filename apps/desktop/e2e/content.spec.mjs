import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 内容页面里要真实排版、真实后台的端到端测试。
// 右键引用、@ 与 / 补全、风格海报、回复里音频的播放器在 src/renderer/components 的组件测试（ContextMenu、chat/Composer、
// chat/StylePicks、chat/MediaStrip）；风格推荐发出的话（全片 / 一段）在 chat/model.test.mjs。

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

// 菜单挂到 body、往哪边开、点外面收起在组件测试里（src/renderer/components/Preview.test.tsx）；这里只看真实排版：
// 面板动画的 transform 包含块下也不被裁掉、不被时间线盖住、第一帧不露出没定位的菜单。
test('scene "more" menu opens as a popover inside the window, above the timeline', async ({ page, project, electronApp }) => {
  // 镜头有产物时菜单最长；窗口压矮，菜单不能被外层裁掉、也不能被时间线盖住。
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=1', '-pix_fmt', 'yuv420p', path.join(project.path, 'scenes', 'scene-001', 'out.mp4')]);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isResizable()).setSize(1100, 640));
  await openProject(page, project);
  await page.locator('[data-tab="scene"]').click();
  // 面板进入动画会建立 fixed 定位的包含块；保持这一状态，不能靠动画结束碰巧通过。
  await page.addStyleTag({ content: '.panel { transform: translateX(0) !important; }' });
  await page.locator('.scene-menu > summary').scrollIntoViewIfNeeded();
  // details 的 toggle 在下一次任务才送达；第一帧不能先露出一个尚未定位的菜单。
  const opening = await page.locator('.scene-menu > summary').evaluate((summary) => {
    summary.click();
    const body = document.querySelector('.scene-menu-body');
    if (!body) return { visible: false, bottom: 0, height: innerHeight };
    const style = getComputedStyle(body);
    const box = body.getBoundingClientRect();
    return { visible: style.visibility !== 'hidden' && style.display !== 'none', bottom: box.bottom, height: innerHeight };
  });
  expect(opening.visible ? opening.bottom : 0).toBeLessThanOrEqual(opening.height);
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
  // 顶层菜单内的点击仍算内部操作，输入反馈不能把菜单关掉。
  await body.getByRole('textbox', { name: '反馈说明' }).click();
  await body.getByRole('textbox', { name: '反馈说明' }).fill('保留这个镜头');
  await expect(body).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('scene-menu.png') });
  // 点外面收起。
  await page.locator('.scene-title').click();
  await expect(body).toBeHidden();
});

test('approving the final film starts consolidating memory and goes to publish', async ({ page, project }) => {
  const { execFileSync } = await import('node:child_process');
  const video = path.join(project.path, 'final.mp4');
  const makeFilm = (size, file) => execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=1`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', file,
  ]);
  const reviewFile = path.join(project.path, 'production/review-final/review.json');
  const readReview = async () => fs.readFile(reviewFile, 'utf8').then(JSON.parse, () => null);
  await fs.writeFile(path.join(project.path, 'frame.md'),
    '---\ncanvas: {width_px: 240, height_px: 320, fps: 30}\naudio: {final_integrated_lufs: -21, final_lufs_tolerance: 10, true_peak_max_dbtp: -1}\n---\n');
  makeFilm('320x240', video);
  await openProject(page, project);
  await page.locator('[data-tab="final"]').click();
  // 成片的播放器没有「下载」。
  const film = page.locator('#panel video[controls]');
  await expect(film).toHaveCount(1);
  expect(await film.evaluate((el) => el.controlsList.contains('nodownload'))).toBe(true);
  const review = page.getByRole('button', { name: /^(重新)?复查$/ });
  const [failedResponse] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/review/run' && response.request().method() === 'POST'),
    review.click(),
  ]);
  expect(failedResponse.status()).toBe(202);
  const { task_id } = await failedResponse.json();
  await expect.poll(() => page.evaluate(async (id) => (await (await fetch('/api/tasks/' + id)).json()).status, task_id)).toBe('failed');
  await expect.poll(readReview).toMatchObject({ ok: false, problems: [expect.stringContaining('分辨率不符')] });
  await expect(page.locator('#final-approve')).toHaveCount(0);
  const replacement = path.join(project.path, 'corrected.mp4');
  makeFilm('240x320', replacement);
  await fs.rename(replacement, video);
  await review.click();
  await expect.poll(readReview).toMatchObject({ ok: true, video_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
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
  await expect(page.locator('.steps .step:not(.route-step)')).toHaveText([/口播稿/, /分镜/, /镜头/, /成片/, /发布/]);
  // 口播项目没有卡点的节拍页。
  await expect(page.locator('[data-tab="beat"]')).toHaveCount(0);
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
