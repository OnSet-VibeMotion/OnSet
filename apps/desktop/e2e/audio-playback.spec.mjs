import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject, openPage } from './fixtures.mjs';

// 真正可解码的 20 秒静音 WAV：测 play/pause 和进度，不让测试发出声音。
function silentWav() {
  const bytes = 24_000 * 20 * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(bytes, 40);
  return wav;
}

async function seedAuditions(project) {
  const files = ['try-A.wav', 'try-B.wav', 'try-C.wav'].map((name) => 'production/audio/auditions/' + name);
  const audioDir = path.join(project.path, 'production', 'audio', 'auditions');
  await fs.mkdir(audioDir, { recursive: true });
  await Promise.all(files.map((file) => fs.writeFile(path.join(project.path, file), silentWav())));
  // 从磁盘恢复一轮试听回复，不启动真实编排工具或模型。
  const session = 's-audio-playback';
  const turn = 't-audio-playback';
  const time = new Date().toISOString();
  const sessions = path.join(project.path, 'production', 'studio', 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, session + '.json'), JSON.stringify({
    session_id: session, title: '音频试听', kind: 'chat', tool: 'claude', renderer: 'claude',
    created_at: time, updated_at: time, turns: [turn],
  }));
  const events = [
    { kind: 'user', text: '比较三段试听' },
    { kind: 'turn-start', status: 'running' },
    { kind: 'text', text: files.map((file) => '`' + file + '`').join('\n\n') },
    { kind: 'turn-end', status: 'succeeded' },
  ].map((event, index) => JSON.stringify({ seq: index + 1, turn_id: turn, time, ...event }));
  await fs.writeFile(path.join(sessions, session + '.events.jsonl'), events.join('\n') + '\n');
}

async function paused(players) {
  return players.evaluateAll((elements) => elements.map((element) => element.paused));
}

async function openAuditions(page, project) {
  await openProject(page, project);
  await page.locator('#history').click();
  await page.locator('.history-row', { hasText: '音频试听' }).click();
  await expect(page.locator('.media-strip audio')).toHaveCount(3);
}

test.describe('Exclusive audio playback', () => {

  test('switches chat auditions and the file preview without resetting progress', async ({ page, project }) => {
    await seedAuditions(project);
    await openAuditions(page, project);
    const clips = page.locator('.media-strip audio');
    await expect(clips).toHaveCount(3);
    await expect.poll(() => clips.first().evaluate((element) => element.duration)).toBe(20);

    await clips.nth(0).evaluate(async (element) => { element.currentTime = 2; await element.play(); });
    await expect.poll(() => paused(clips)).toEqual([false, true, true]);
    await clips.nth(1).evaluate((element) => element.play());
    await expect.poll(() => paused(clips)).toEqual([true, false, true]);
    const savedPosition = await clips.nth(0).evaluate((element) => element.currentTime);
    expect(savedPosition).toBeGreaterThanOrEqual(2);
    await clips.nth(2).evaluate((element) => element.play());
    await expect.poll(() => paused(clips)).toEqual([true, true, false]);
    expect(await clips.nth(0).evaluate((element) => element.currentTime)).toBe(savedPosition);

    await clips.nth(0).evaluate((element) => element.play());
    await expect.poll(() => paused(clips)).toEqual([false, true, true]);
    expect(await clips.nth(0).evaluate((element) => element.currentTime)).toBeGreaterThanOrEqual(savedPosition);

    // 文件页的播放器后来才挂载，也与聊天里的试听互斥。
    await page.locator('.media-name', { hasText: 'try-B.wav' }).click();
    const preview = page.locator('.file-tab audio');
    await expect(preview).toBeVisible();
    await preview.evaluate((element) => element.play());
    await expect.poll(() => paused(clips)).toEqual([true, true, true]);
    await expect.poll(() => preview.evaluate((element) => element.paused)).toBe(false);
    await clips.nth(2).evaluate((element) => element.play());
    await expect.poll(() => preview.evaluate((element) => element.paused)).toBe(true);
    await expect.poll(() => paused(clips)).toEqual([true, true, false]);
    await page.screenshot({ path: test.info().outputPath('exclusive-audio.png') });
  });

  test('syncs hidden voice player buttons when a chat audition interrupts them', async ({ page, project, sandbox }) => {
    await seedAuditions(project);
    for (const name of ['音色甲', '音色乙']) {
      const directory = path.join(sandbox.voices, name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'reference.wav'), silentWav());
      await fs.writeFile(path.join(directory, 'voice.json'), JSON.stringify({
        name, text: '试听音色', source: 'uploaded', duration_seconds: 20, created: new Date().toISOString(),
      }));
    }
    await openAuditions(page, project);
    await openPage(page, 'voice');
    const voices = page.locator('.voices-tab .voice');
    await expect(voices).toHaveCount(2);
    const first = voices.nth(0).locator('.voice-play');
    const second = voices.nth(1).locator('.voice-play');
    const hiddenPlayer = page.locator('.voices-tab > audio');
    const clips = page.locator('.media-strip audio');

    await first.click();
    await expect(first).toHaveClass(/armed/);
    await expect.poll(() => hiddenPlayer.evaluate((element) => element.paused)).toBe(false);
    await second.click();
    await expect(first).not.toHaveClass(/armed/);
    await expect(second).toHaveClass(/armed/);

    await clips.first().evaluate((element) => element.play());
    await expect.poll(() => hiddenPlayer.evaluate((element) => element.paused)).toBe(true);
    await expect(second).not.toHaveClass(/armed/);
    await expect(second).toHaveAttribute('title', '试听');

    // 外部暂停后再点一次就能播放，不会先执行一次多余的“停止”。
    await second.click();
    await expect(second).toHaveClass(/armed/);
    await expect.poll(() => hiddenPlayer.evaluate((element) => element.paused)).toBe(false);
    await expect.poll(() => paused(clips)).toEqual([true, true, true]);
  });

  test('lets muted video previews continue and takes over sound when unmuted', async ({ page, project }) => {
    await seedAuditions(project);
    await openAuditions(page, project);
    const clip = page.locator('.media-strip audio').first();
    await expect(clip).toBeVisible();
    await clip.evaluate((element) => element.play());
    // 使用同一条可解码的音轨，验证 HTMLVideoElement 的真实播放与静音事件。
    await clip.evaluate(async (element) => {
      const video = document.createElement('video');
      video.id = 'muted-video-preview';
      video.muted = true;
      video.src = element.src;
      document.body.append(video);
      await video.play();
    });
    const video = page.locator('#muted-video-preview');
    expect(await clip.evaluate((element) => element.paused)).toBe(false);
    await video.evaluate((element) => { element.muted = false; });
    await expect.poll(() => clip.evaluate((element) => element.paused)).toBe(true);
    expect(await video.evaluate((element) => element.paused)).toBe(false);
    await clip.evaluate((element) => element.play());
    await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  });
});
