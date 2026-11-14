import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, openPage } from './fixtures.mjs';

// 一个项目装几种风格：风格页列出默认风格与其他风格、各有哪些镜头在用；镜头页显示本镜头的风格，
// 「换风格」不直接改文件，而是把要求写进输入框交给编排工具。

function writeStyle(dir, slug, cn, en) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'STYLE.md'), `# ${cn}\n\n笔触与材质的不变量。\n`);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'guide');
  fs.writeFileSync(
    path.join(dir, 'am-film-style.json'),
    JSON.stringify({ source: 'lemo-opuscar', slug, cn, en, version: 'v', digest: 'd', installed_at: '' }),
  );
}

function writeScene(root, id, filmStyle) {
  const dir = path.join(root, 'scenes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  fs.writeFileSync(
    path.join(dir, 'scene.json'),
    JSON.stringify({ id, duration_seconds: 1, output: 'out.mp4', transcript: 'voice.srt', text: 'hello', film_style: filmStyle }),
  );
}

test('shows several film styles and asks the orchestrator to change a scene', async ({ page, project }) => {
  writeStyle(path.join(project.path, '.agents/skills/am-film-style'), 'watercolor', '水彩笔刷', 'Watercolor Brush');
  writeStyle(path.join(project.path, '.agents/am-film-styles/lemo-opuscar/ink-wash'), 'ink-wash', '中国水墨', 'Chinese Ink Wash');
  writeScene(project.path, 'scene-002', 'lemo-opuscar/ink-wash');
  writeScene(project.path, 'scene-003', 'none');
  await openProject(page, project);

  await openPage(page, 'style');
  await expect(page.locator('.style-intro.film h3')).toContainText('水彩笔刷');
  const ink = page.locator('.style-other[data-style="lemo-opuscar/ink-wash"]');
  await expect(ink).toContainText('中国水墨');
  await expect(ink.locator('.chip')).toHaveText(['镜头 02']);
  await expect(ink.locator('button', { hasText: '去掉' }), '还有镜头在用时不能去掉').toBeDisabled();
  await ink.locator('button', { hasText: '看说明' }).click();
  await expect(page.locator('.style-doc')).toContainText('中国水墨 的 STYLE.md');

  await ink.locator('.chip', { hasText: '镜头 02' }).click();
  await expect(page.locator('.scene-style')).toContainText('中国水墨');
  await page.locator('#scene-style').click();
  await expect(page.locator('#film-style-dialog .fs-item[data-style="lemo-opuscar/ink-wash"] .fs-current')).toHaveText('正在用');
  await page.locator('#film-style-dialog .fs-item[data-special="@default"]').click();
  await page.locator('#film-style-confirm').click();
  await expect(page.locator('#film-style-dialog')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue(/把镜头 02（scene-002）改回默认风格「水彩笔刷」.*风格交界/);
});

test('storyboard shows each scene’s style, the style boundaries, and changes a scene’s style through the chat', async ({ page, project }) => {
  writeStyle(path.join(project.path, '.agents/skills/am-film-style'), 'watercolor', '水彩笔刷', 'Watercolor Brush');
  writeStyle(path.join(project.path, '.agents/am-film-styles/lemo-opuscar/ink-wash'), 'ink-wash', '中国水墨', 'Chinese Ink Wash');
  writeScene(project.path, 'scene-002', '');
  writeScene(project.path, 'scene-003', '');
  fs.mkdirSync(path.join(project.path, 'production'), { recursive: true });
  fs.writeFileSync(
    path.join(project.path, 'production', 'scene-plan.json'),
    JSON.stringify({
      schema: 1,
      scenes: [
        { id: 'scene-001', dir: 'scenes/scene-001', summary: '开场' },
        { id: 'scene-002', dir: 'scenes/scene-002', first_subtitle: 2, summary: '回忆', film_style: 'lemo-opuscar/ink-wash', handoff: { device: 'carry', bridge: '一滴墨晕开', style_shift: 'morph' } },
        { id: 'scene-003', dir: 'scenes/scene-003', first_subtitle: 3, summary: '回到现在' },
      ],
    }),
  );
  await openProject(page, project);
  await page.locator('[data-tab="storyboard"]').click();

  const styles = page.locator('#storyboard-styles');
  await expect(styles).toContainText('2 种画风 · 2 处风格交界');
  await expect(styles.locator('.sb-style-group')).toHaveText([/水彩笔刷默认.*2 个镜头 · 01、03/, /中国水墨.*1 个镜头 · 02/]);

  const card = (id) => page.locator(`#storyboard .sb-scene[data-scene="${id}"]`);
  await expect(card('scene-001').locator('.sb-style')).toContainText('水彩笔刷（默认）');
  await expect(card('scene-002').locator('.sb-style')).toContainText('中国水墨');
  await expect(card('scene-002')).toHaveClass(/off-default/);

  // 两处风格交界：写了过渡手法的显示手法，没写的照实标出（scene_cues 会拒绝它）。
  const shifts = page.locator('#storyboard .sb-handoff.style-shift');
  await expect(shifts).toHaveCount(2);
  await expect(shifts.nth(0)).toContainText('水彩笔刷→中国水墨');
  await expect(page.locator('#storyboard .sb-handoff.unplanned')).toContainText('还没写画风怎么换过去');

  // 换风格：不改文件，写进输入框交给编排工具。
  await card('scene-003').locator('.sb-style button', { hasText: '换风格' }).click();
  await page.locator('#film-style-dialog .fs-item[data-style="lemo-opuscar/ink-wash"]').click();
  await page.locator('#film-style-confirm').click();
  await expect(page.locator('#film-style-dialog')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue(/把镜头 03（scene-003）换成「中国水墨」风格（lemo-opuscar\/ink-wash）。.*scene_cues\(\)/);
});
