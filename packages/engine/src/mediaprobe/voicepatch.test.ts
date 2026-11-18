import path from 'node:path';
import { expect, it } from 'vitest';
import { patchVoice } from './voicepatch';
import { ffmpeg, hasFfmpeg, tempDir, toolchain } from './testutil';

it.skipIf(!hasFfmpeg)('replaces just the requested PCM interval and preserves all other samples', async () => {
  const directory = tempDir();
  const original = path.join(directory, 'original.wav'), replacement = path.join(directory, 'replacement.wav');
  ffmpeg('-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-ac', '2', original);
  ffmpeg('-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=48000:duration=0.2', replacement);
  const t = toolchain();
  const options = { directory, original, replacement, startSample: 12_000, endSample: 24_000 };
  expect(await patchVoice(t, options)).toMatchObject({ total_samples: 48_000, replacement_samples: 9_600, padding_samples: 2_400 });
  const pcm = async (file: string) => (await t.runAsync(t.ffmpegPath(), ['-v', 'error', '-i', file, '-f', 's16le', '-'], { captureStdout: true })).stdout;
  const before = await pcm(original), after = await pcm(path.join(directory, 'voice.wav'));
  expect(after.length).toBe(before.length);
  expect(after.subarray(0, 12_000 * 4)).toEqual(before.subarray(0, 12_000 * 4));
  expect(after.subarray(24_000 * 4)).toEqual(before.subarray(24_000 * 4));
  expect(after.subarray(12_000 * 4, 24_000 * 4)).not.toEqual(before.subarray(12_000 * 4, 24_000 * 4));
  await expect(patchVoice(t, { ...options, endSample: 16_000 })).rejects.toThrow(/补录长于/);
});
