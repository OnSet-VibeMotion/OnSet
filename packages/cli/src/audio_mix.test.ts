import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { MixOutputs, Toolchain } from '@onset/engine/mediaprobe';
import { findOp, normalizeParams } from './ops/op';
import { Buffer, hasFfmpeg, makeClip, tempDir } from './testutil';
import './audio_mix';
import './review_cmd';

it.skipIf(!hasFfmpeg)('publishes and reuses a verified candidate, with explicit archives on revision', async () => {
  const root = tempDir(), audio = path.join(root, 'production/audio');
  fs.mkdirSync(audio, { recursive: true });
  const frameFile = path.join(root, 'frame.md');
  const frame = '---\ncanvas: {width_px: 320, height_px: 240, fps: 30}\naudio: {final_integrated_lufs: -16, final_lufs_tolerance: 2, true_peak_max_dbtp: -1}\n---\n';
  fs.writeFileSync(frameFile, frame);
  makeClip(path.join(audio, 'voice.wav'), 'sine=frequency=440:sample_rate=48000:duration=1', '-ac', '2');
  makeClip(path.join(root, 'production/silent-master.mp4'), 'testsrc2=s=320x240:r=30:d=2');
  fs.writeFileSync(path.join(root, 'production/timing-report.json'), JSON.stringify({ fps: 30, total_frames: 60, sample_rate: 48000, target_samples_per_channel: 96_000 }));
  const sheet = path.join(audio, 'cue-sheet.json');
  fs.writeFileSync(sheet, JSON.stringify({ schema: 1, cues: [] }));
  const op = findOp('audio_mix')!, out = new Buffer();
  const signal = new AbortController().signal;
  const call = (replace = false) => op.run(normalizeParams(op, { project_root: root, replace }), { out, err: out, signal, unsafe: false });
  expect((await call())?.data).toMatchObject({ reused: false, total_frames: 60 });
  expect((await call())?.data).toMatchObject({ reused: true });
  for (const name of MixOutputs) expect(fs.existsSync(path.join(audio, name))).toBe(true);
  const candidate = fs.readFileSync(path.join(audio, 'candidate.mp4'));
  const review = findOp('review')!;
  const reviewCandidate = () => review.run(normalizeParams(review, {
    project_root: root, video: path.join(audio, 'candidate.mp4'), out: path.join(root, 'production/review'),
    fps: 30, expect_frames: 60, validate_report: 'production/final-check.json',
  }), { out, err: out, signal, unsafe: false });
  const video = path.join(audio, 'candidate.mp4');
  const original = video + '.original';
  const verify = Toolchain.prototype.verify;
  const duringVerify = vi.spyOn(Toolchain.prototype, 'verify').mockImplementation(function (this: Toolchain, file, options) {
    fs.renameSync(video, original);
    fs.writeFileSync(video, 'the original path temporarily points to unreviewable bytes');
    try {
      return verify.call(this, file, options);
    } finally {
      fs.renameSync(original, video);
    }
  });
  let reviewed;
  try {
    reviewed = await reviewCandidate();
    expect(duringVerify).toHaveBeenCalledOnce();
  } finally {
    duringVerify.mockRestore();
  }
  expect(reviewed?.data).toMatchObject({ ok: true, counted_frames: 60 });
  expect(JSON.parse(fs.readFileSync(path.join(root, 'production/final-check.json'), 'utf8')).ok).toBe(true);
  expect(reviewed?.data).toMatchObject({ video_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  fs.writeFileSync(frameFile, frame.replace('fps: 30', 'fps: 24'));
  await expect(reviewCandidate()).rejects.toThrow(/帧率不符/);
  fs.writeFileSync(frameFile, frame.replace('width_px: 320, height_px: 240', 'width_px: 240, height_px: 320'));
  await expect(reviewCandidate()).rejects.toThrow(/分辨率不符/);
  const failed = JSON.parse(fs.readFileSync(path.join(root, 'production/review/review.json'), 'utf8'));
  expect(failed).toMatchObject({ ok: false, problems: [expect.stringContaining('分辨率不符')] });
  expect(failed.video_sha256).toBeUndefined();
  fs.writeFileSync(frameFile, frame);
  await expect(review.run(normalizeParams(review, {
    project_root: root, video, out: path.join(root, 'production/review'), expect_frames: 60,
    report_json: path.join(root, 'production/review/CHECK.json'), validate_report: 'production/review/check.json',
  }), { out, err: out, signal, unsafe: false })).rejects.toThrow(/需要不同路径/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(root, 'production/review'), path.join(root, 'production/review-alias'));
    await expect(review.run(normalizeParams(review, {
      project_root: root, video, out: path.join(root, 'production/review'), expect_frames: 60,
      report_json: path.join(root, 'production/review-alias/not-yet-written/reports.json'),
      validate_report: 'production/review/not-yet-written/reports.json',
    }), { out, err: out, signal, unsafe: false })).rejects.toThrow(/需要不同路径/);
  }
  fs.writeFileSync(sheet, JSON.stringify({ schema: 1, cues: [{ kind: 'music', asset: 'production/audio/voice.wav', duration_frames: 24 }] }));
  await expect(call()).rejects.toThrow(/replace=true/);
  expect(fs.readFileSync(path.join(audio, 'candidate.mp4'))).toEqual(candidate);
  const abandoned = fs.mkdtempSync(path.join(audio, '.mix-'));
  const notes = path.join(audio, '.mix-notes.txt');
  fs.writeFileSync(notes, 'keep');
  expect((await call(true))?.data).toMatchObject({ reused: false });
  expect(fs.existsSync(abandoned)).toBe(false);
  expect(fs.existsSync(notes)).toBe(true);
  const archive = fs.readdirSync(audio).find(name => name.startsWith('mix-previous-'))!;
  expect(fs.readFileSync(path.join(audio, archive, 'candidate.mp4'))).toEqual(candidate);
});
