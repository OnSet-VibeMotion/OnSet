import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ffmpeg, hasFfmpeg, tempDir, toolchain } from './testutil';

// 静音上叠咔嗒，重拍处的峰值必须高于普通拍，且时长与原音乐一致（48kHz 双声道 16 位）。
it.skipIf(!hasFfmpeg)('clickTrack marks downbeats louder', async () => {
  const tc = toolchain();
  const dir = tempDir();
  const music = path.join(dir, 'silence.wav');
  ffmpeg('-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', music);
  const dest = path.join(dir, 'click.wav');
  await tc.clickTrack(music, dest, [0.5, 1.0], [0.5]);
  const body = fs.readFileSync(dest);
  // WAV 头。
  expect(body.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(body.readUInt32LE(24)).toBe(48000);
  expect(body.readUInt16LE(22)).toBe(2);
  const frames = Math.floor((body.length - 44) / 4);
  // 帧数与 2 秒相符。
  expect(frames).toBeGreaterThanOrEqual(95900);
  expect(frames).toBeLessThanOrEqual(96100);
  const peak = (at: number) => {
    const start = Math.trunc(at * 48000);
    let best = 0;
    for (let i = start; i < start + Math.trunc(0.035 * 48000); i++) best = Math.max(best, Math.abs(body.readInt16LE(44 + 4 * i)));
    return best / 32768;
  };
  const [down, normal, quiet] = [peak(0.5), peak(1.0), peak(1.5)];
  expect(down).toBeGreaterThan(normal);
  expect(normal).toBeGreaterThanOrEqual(0.1);
  expect(quiet).toBeLessThanOrEqual(0.001);
});
