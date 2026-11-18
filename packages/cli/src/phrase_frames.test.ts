import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { findOp, normalizeParams } from './ops/op';
import { Buffer, hasFfmpeg, makeClip, tempDir } from './testutil';
import './phrase_frames';

it.skipIf(!hasFfmpeg)('takes three consecutive-phase evidences and marks an unregistered phrase for review', async () => {
  const root = tempDir(), production = path.join(root, 'production');
  fs.mkdirSync(production);
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 320, height_px: 240, fps: 30}\n---\n');
  makeClip(path.join(production, 'video.mp4'), 'testsrc2=size=320x240:rate=30:duration=1');
  fs.writeFileSync(path.join(production, 'phrase-timeline.json'), JSON.stringify({ fps: 30, phrases: [
    { phrase_id: 'p1', start_frame: 5, end_frame_exclusive: 15 },
    { phrase_id: 'p2', start_frame: 18, end_frame_exclusive: 29 },
  ] }));
  fs.writeFileSync(path.join(production, 'visible-event-inventory.json'), JSON.stringify({ schema: 1, fps: 30, events: [
    { event_id: 'e1', phrase_id: 'p1', readable_start_frame: 8, readable_end_frame_exclusive: 14 },
  ] }));
  const op = findOp('phrase_frames')!, out = new Buffer();
  const result = (await op.run(normalizeParams(op, { project_root: root, video: 'production/video.mp4' }),
    { out, err: out, signal: new AbortController().signal, unsafe: false }))?.data as { report: string; sheets: string[]; needs_review: string[] };
  expect(result.needs_review).toEqual(['p2']);
  expect(fs.existsSync(path.join(root, result.sheets[0]))).toBe(true);
  const report = JSON.parse(fs.readFileSync(path.join(root, result.report), 'utf8'));
  expect(report.sheets[0].rows[0]).toMatchObject({ phrase_id: 'p1', frames: [4, 5, 10], registered_readable_frame: true });
});
