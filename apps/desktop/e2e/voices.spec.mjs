import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, openPage } from './fixtures.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// 录我的声音（麦克风、实时电平、回放跟读、交给 /api/voice-record 的内容）在 src/renderer/components/Voices.test.tsx。

test('designing offers Breeze; an uploaded recording goes into the shared library, plays and deletes', async ({ page, project, sandbox }) => {
  await openProject(page, project);
  await openPage(page, 'voice');
  const tab = page.locator('.voices-tab');
  await tab.getByRole('tab', { name: '按描述设计' }).click();
  // 测试的 HOME 是空的：Breeze 不在。Apple Silicon 上给安装按钮，别的机器说明原因。
  await expect(tab.locator('.voices-way-body')).toContainText(/Breeze TTS 2|Apple Silicon/);
  await page.screenshot({ path: test.info().outputPath('design.png') });

  test.skip(!hasFfmpeg, '要用 ffmpeg 把录音转成参考音频');
  const take = path.join(sandbox.root, 'me.m4a');
  expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=180:duration=6', take]).status).toBe(0);
  await tab.getByRole('tab', { name: '上传录音' }).click();

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
  expect(fs.existsSync(path.join(sandbox.voices, '我的声音', 'reference.wav'))).toBe(true);

  // 波形画出来了，时长与音频一致。
  await expect(voice.locator('.voice-clock')).toHaveText('0:06.0');
  await expect(voice.locator('.voice-bars rect.idle')).toHaveCount(0);
  await voice.locator('.voice-play').click();
  await expect(voice.locator('.voice-play')).toHaveClass(/armed/);
  // 放的时候逐字点亮：正好有一个字在念，前面的字算念过。
  await expect(voice.locator('.voice-read .w.now')).toHaveCount(1);
  await expect(voice.locator('.voice-read .w.said').first()).toBeVisible({ timeout: 5_000 });
  await expect(voice.locator('.voice-bars rect.played').first()).toBeVisible();
  // 点某个字从那里放。
  await voice.locator('.voice-read .w', { hasText: '节' }).click();
  await expect(voice.locator('.voice-read .w.now')).toHaveText(/节|目/);
  await page.screenshot({ path: test.info().outputPath('read-along.png') });
  await voice.locator('.voice-play').click();
  await voice.getByTitle('删除').click();
  await voice.getByRole('button', { name: '确认删除' }).click();
  await expect(tab.locator('.voices-empty')).toBeVisible();
  expect(fs.existsSync(path.join(sandbox.voices, '我的声音'))).toBe(false);
});
