import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ffmpegBinary, hasFfmpeg, tempDir, toolchain } from './testutil';

it.skipIf(!hasFfmpeg)('song mux pads only the sub-frame tail', async () => {
  const dir = tempDir();
  const audio = path.join(dir, 'song.wav');
  const video = path.join(dir, 'silent.mp4');
  const dest = path.join(dir, 'final.mp4');
  const run = (...args: string[]) => {
    const result = spawnSync(ffmpegBinary!, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${result.status}: ${result.stdout}${result.stderr}`);
  };
  run('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.01', '-ar', '48000', audio);
  run('-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30', '-frames:v', '31', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video);
  const tc = toolchain();
  await tc.prepareAlignment(audio, path.join(dir, 'analysis.wav'));
  const analysis = tc.probe(path.join(dir, 'analysis.wav'));
  expect(analysis.audio!.sample_rate).toBe(16000);
  expect(analysis.audio!.channels).toBe(1);
  expect(Math.abs(analysis.duration_seconds - 1.01)).toBeLessThanOrEqual(0.001);

  await tc.muxSong(video, audio, dest, 1.01, 30);
  const m = tc.probe(dest);
  expect(m.audio).not.toBeNull();
  expect(m.video).not.toBeNull();
  expect(m.video!.nb_frames).toBe(31);

  for (const duration of [0, -1, NaN, 2]) {
    await expect(tc.muxSong(video, audio, dest, duration, 30), `invalid duration ${duration}`).rejects.toThrow();
  }
  await expect(tc.muxSong(video, audio, video, 1.01, 30), 'overwrite').rejects.toThrow('输出不得覆盖输入');
  run('-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30', '-frames:v', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video);
  await expect(tc.muxSong(video, audio, dest, 1.01, 30), 'truncated master').rejects.toThrow(/^歌曲静音母版不合格：\[/);
});
