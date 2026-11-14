import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';
import { estimateScriptTiming } from '../src/renderer/scriptTiming.ts';

function wav(seconds = 4) {
  const sampleRate = 24000, frames = sampleRate * seconds;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / sampleRate) * 1000), 44 + i * 2);
  return bytes;
}

async function draft(project, text = '# 开场\n\n你好，@{year}<2025|二零二五>@{/year}。') {
  const dir = path.join(project.path, 'production/audio');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(project.path, 'production/script-final.md'), text);
  return dir;
}

test('estimated reading preserves nested markup, silent text and paragraph offsets', () => {
  const input = [
    { kind: 'heading', text: '不参与朗读' },
    { kind: 'para', nodes: [{ kind: 'text', text: '你好，' }, { kind: 'phrase', id: 'year', children: [{ kind: 'alt', text: '2025', spoken: '二零二五' }] }, { kind: 'alt', text: '注', spoken: '' }] },
    { kind: 'para', nodes: [{ kind: 'alt', spoken: '嗯' }, { kind: 'text', text: '世界。' }] },
  ];
  const out = estimateScriptTiming(input, 9);
  expect(out[0]).toEqual(input[0]);
  expect(out[1].nodes[0].timings).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, null]);
  expect(out[1].nodes[1].children[0].timings).toHaveLength(4);
  expect(out[1].nodes[2].timings).toEqual([null]);
  expect(out[2].nodes[0].timings).toEqual([{ start: 6, end: 7 }]);
  expect(out[2].nodes[1].timings).toEqual([{ start: 7, end: 8 }, { start: 8, end: 9 }, null]);
  expect(input[1].nodes[0].timings).toBeUndefined();
});

test('plays actual script audio, follows word timing, seeks and switches takes', async ({ page, project }) => {
  const dir = await draft(project);
  await fs.writeFile(path.join(dir, 'voice.wav'), wav());
  await fs.writeFile(path.join(dir, 'voice-v02.wav'), wav(6));
  await fs.writeFile(path.join(dir, 'align.json'), JSON.stringify([
    { text: '你', start: 0.2, end: 0.6 }, { text: '好', start: 0.7, end: 1.1 },
    { text: '二', start: 1.2, end: 1.6 }, { text: '零', start: 1.6, end: 2 },
    { text: '二', start: 2, end: 2.4 }, { text: '五', start: 2.4, end: 2.8 },
  ]));
  await openProject(page, project);
  await page.locator('[data-tab="script"]').click();
  const audio = page.locator('audio[aria-label="口播配音"]');
  await expect(audio).toHaveAttribute('src', /voice\.wav/);
  await expect.poll(() => audio.evaluate(el => el.duration)).toBe(4);
  await page.getByRole('button', { name: '播放配音', exact: true }).click();
  await expect.poll(() => audio.evaluate(el => el.currentTime)).toBeGreaterThan(0.25);
  await expect(page.locator('.script-char.now')).toHaveCount(1);
  await page.getByRole('button', { name: '暂停配音', exact: true }).click();
  await audio.evaluate(el => { el.currentTime = 0.3; });
  await expect(page.locator('.script-char.now')).toHaveText('你');
  await audio.evaluate(el => { el.currentTime = 0.8; });
  await expect(page.locator('.script-char.now')).toHaveText('好');
  await expect.poll(() => audio.evaluate(el => el.paused)).toBe(true);
  await page.locator('.script-body ruby .script-char').nth(2).click();
  await expect.poll(() => audio.evaluate(el => el.currentTime)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => audio.evaluate(el => el.paused)).toBe(false);
  await page.getByRole('button', { name: '暂停配音', exact: true }).click();
  await audio.evaluate(el => { el.currentTime = 2.1; });
  await expect(page.locator('.script-char.now')).toHaveText('2');
  await page.getByRole('combobox', { name: '配音版本' }).selectOption('production/audio/voice-v02.wav');
  await expect(audio).toHaveAttribute('src', /voice-v02\.wav/);
  await expect.poll(() => audio.evaluate(el => el.duration)).toBe(6);
  await expect.poll(() => audio.evaluate(el => el.paused)).toBe(true);
  await expect(page.locator('.script-player')).toContainText('按时长估算');
  await page.getByRole('button', { name: '播放配音', exact: true }).click();
  await expect.poll(() => audio.evaluate(el => el.currentTime)).toBeGreaterThan(0.1);
  await expect(page.locator('.script-char.now')).toHaveText('你');
  await page.getByRole('button', { name: '暂停配音', exact: true }).click();
});

test('subtitles alone are not playable and versioned audio works without subtitles', async ({ page, project }) => {
  const dir = await draft(project, '你好世界');
  await fs.writeFile(path.join(dir, 'voice.srt'), '1\n00:00:00,000 --> 00:00:04,000\n你好世界\n');
  await openProject(page, project);
  await page.locator('[data-tab="script"]').click();
  await expect(page.locator('.script-tab')).toContainText('还没有找到配音音频');
  await expect(page.getByRole('button', { name: '播放配音' })).toHaveCount(0);
  await fs.rm(path.join(dir, 'voice.srt'));
  await fs.writeFile(path.join(dir, 'voice-v01.wav'), wav());
  await page.reload();
  await page.locator('[data-tab="script"]').click();
  const audio = page.locator('audio[aria-label="口播配音"]');
  await expect(audio).toHaveAttribute('src', /voice-v01\.wav/);
  await page.getByRole('button', { name: '播放配音' }).click();
  await expect.poll(() => audio.evaluate(el => el.currentTime)).toBeGreaterThan(0.1);
  await expect(page.locator('.script-char.now')).toHaveText('你');
});

test('an unreadable audio file explains the playback failure', async ({ page, project }) => {
  const dir = await draft(project);
  await fs.writeFile(path.join(dir, 'voice.wav'), 'broken audio');
  await openProject(page, project);
  await page.locator('[data-tab="script"]').click();
  await expect(page.locator('.script-player [role="alert"]')).toContainText('音频无法播放');
});
