import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

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

  await page.locator('[data-tab="style"]').click();
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
