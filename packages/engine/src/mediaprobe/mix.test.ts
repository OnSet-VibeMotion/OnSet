import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { mixProgram, MixSampleRate } from './mix';
import { tempDir, hasFfmpeg, ffmpeg } from './testutil';
import { newToolchain } from './toolchain';

it.skipIf(!hasFfmpeg)('mixes two stems and exports a verified AAC candidate without re-encoding video', async () => {
  const dir = tempDir();
  const voice = path.join(dir, 'voice.wav'), music = path.join(dir, 'source.wav'), video = path.join(dir, 'silent.mp4');
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', voice);
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', music);
  ffmpeg('-f', 'lavfi', '-i', 'color=blue:s=320x240:r=30:d=2', '-c:v', 'libx264', video);
  const chain = newToolchain(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>);
  const report = await mixProgram(chain, {
    directory: dir, voice, video, frames: 60, fps: 30,
    cues: [{ kind: 'music', file: music, start: 0, length: 96_000, sourceStart: 0, gainDB: -15, fadeIn: 2400, fadeOut: 4800 }],
    integratedLUFS: -16, truePeakMax: -1, loudnessTolerance: 2,
  });
  expect(report.ok, report.problems.join('; ')).toBe(true);
  expect(report.target_samples_per_channel).toBe(MixSampleRate * 2);
  expect(report.decoded_samples_per_channel).toBeGreaterThanOrEqual(report.target_samples_per_channel);
  expect(report.true_peak_dbtp).toBeLessThanOrEqual(-1);
  expect(chain.countFrames(path.join(dir, 'candidate.mp4'))).toBe(60);
  for (const name of ['music.wav', 'sfx.wav', 'premaster.wav']) expect(fs.statSync(path.join(dir, name)).size).toBeGreaterThan(0);
  const beat = fs.mkdtempSync(path.join(dir, 'beat-'));
  expect(await mixProgram(chain, {
    directory: beat, primaryMusic: music, video, frames: 60, fps: 30, cues: [],
    integratedLUFS: -16, truePeakMax: -1, loudnessTolerance: 2,
  })).toMatchObject({ ok: true, target_samples_per_channel: 96_000 });
  await expect(mixProgram(chain, {
    directory: beat, primaryMusic: voice, video, frames: 60, fps: 30, cues: [],
    integratedLUFS: -16, truePeakMax: -1, loudnessTolerance: 2,
  })).rejects.toThrow(/主音乐必须原样/);
});
