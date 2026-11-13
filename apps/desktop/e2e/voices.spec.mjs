import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('voice page saves an uploaded recording into the shared library, plays it and deletes it', async ({ page, project, sandbox }) => {
  test.skip(!hasFfmpeg, '要用 ffmpeg 把录音转成参考音频');
  const take = path.join(sandbox.root, 'me.m4a');
  expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=180:duration=6', take]).status).toBe(0);

  await openProject(page, project);
  await page.locator('[data-tab="voice"]').click();
  const tab = page.locator('.voices-tab');
  await expect(tab.locator('.voices-empty')).toContainText('就用这个声音');

  const upload = tab.locator('.voices-upload');
  const save = upload.getByRole('button', { name: '存进音色库' });
  await expect(save).toBeDisabled();
  await upload.getByPlaceholder('例如：我的声音').fill('我的声音');
  await upload.locator('input[type="file"]').setInputFiles(take);
  await expect(upload.locator('.voices-file')).toContainText('me.m4a');
  await upload.getByPlaceholder('录音里说的话，一字不差').fill('大家好，欢迎来到今天的节目。');
  await save.click();

  const voice = tab.locator('.voice', { hasText: '我的声音' });
  await expect(voice).toBeVisible();
  await expect(voice.locator('.voice-badge')).toHaveText('默认');
  await expect(voice).toContainText('6.0 秒 · 本人录音');
  await expect(voice.locator('.voice-text')).toHaveText('「大家好，欢迎来到今天的节目。」');
  // 音色库在用户级目录（测试里是 AM_VOICES_DIR），不在项目里。
  expect(fs.existsSync(path.join(sandbox.voices, '我的声音', 'reference.wav'))).toBe(true);
  await page.screenshot({ path: test.info().outputPath('voices.png') });

  await voice.locator('.voice-play').click();
  await expect(voice.locator('.voice-play')).toHaveClass(/armed/);

  // 删除要点两次。
  await voice.getByTitle('删除').click();
  await voice.getByRole('button', { name: '确认删除' }).click();
  await expect(tab.locator('.voices-empty')).toBeVisible();
  expect(fs.existsSync(path.join(sandbox.voices, '我的声音'))).toBe(false);
});
