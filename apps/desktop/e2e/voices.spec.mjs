import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('records my own voice from the microphone into the shared library', async ({ page, project, sandbox }) => {
  test.skip(!hasFfmpeg, '要用 ffmpeg 把录音转成参考音频');
  await openProject(page, project);
  await page.locator('[data-tab="voice"]').click();
  const tab = page.locator('.voices-tab');
  await expect(tab.locator('.voices-empty')).toContainText('录一段自己的声音');
  // 默认就是「录我的声音」：页面给出要念的那段字。
  await expect(tab.getByRole('tab', { name: '录我的声音' })).toHaveAttribute('aria-selected', 'true');
  await expect(tab.locator('.voices-sample')).toContainText('大家好');

  await tab.getByRole('button', { name: '开始录音' }).click();
  await expect(tab.locator('.voices-rec')).toContainText('停止 · 4 秒', { timeout: 10_000 });
  await tab.locator('.voices-rec').click();
  await expect(tab.locator('.voices-recorder audio')).toBeVisible();
  // 念的就是那段字，逐字稿已经填好。
  await expect(tab.locator('.voices-field textarea')).toHaveValue(/大家好/);
  await tab.getByPlaceholder('给它起个名字，例如：我的声音').fill('我的声音');
  await page.screenshot({ path: test.info().outputPath('record.png') });
  await tab.getByRole('button', { name: '存进音色库' }).click();

  const voice = tab.locator('.voice', { hasText: '我的声音' });
  await expect(voice).toBeVisible();
  await expect(voice.locator('.voice-badge')).toHaveText('默认');
  await expect(voice).toContainText('本人录音');
  expect(fs.existsSync(path.join(sandbox.voices, '我的声音', 'reference.wav'))).toBe(true);
});

test('designing a voice offers to install Breeze when it is not on this Mac', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('[data-tab="voice"]').click();
  const tab = page.locator('.voices-tab');
  await tab.getByRole('tab', { name: '按描述设计' }).click();
  // 测试的 HOME 是空的：Breeze 不在。Apple Silicon 上给安装按钮，别的机器说明原因。
  await expect(tab.locator('.voices-way-body')).toContainText(/Breeze TTS 2|Apple Silicon/);
  await page.screenshot({ path: test.info().outputPath('design.png') });
});

test('uploaded recording goes into the shared library, plays and deletes', async ({ page, project, sandbox }) => {
  test.skip(!hasFfmpeg, '要用 ffmpeg 把录音转成参考音频');
  const take = path.join(sandbox.root, 'me.m4a');
  expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=180:duration=6', take]).status).toBe(0);

  await openProject(page, project);
  await page.locator('[data-tab="voice"]').click();
  const tab = page.locator('.voices-tab');
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

  await voice.locator('.voice-play').click();
  await expect(voice.locator('.voice-play')).toHaveClass(/armed/);
  await voice.getByTitle('删除').click();
  await voice.getByRole('button', { name: '确认删除' }).click();
  await expect(tab.locator('.voices-empty')).toBeVisible();
  expect(fs.existsSync(path.join(sandbox.voices, '我的声音'))).toBe(false);
});
