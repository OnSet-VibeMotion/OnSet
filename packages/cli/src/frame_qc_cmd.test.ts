import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { findOp, normalizeParams } from './ops/op';
import { Buffer, hasFfmpeg, tempDir } from './testutil';
import './frame_qc_cmd';

it.skipIf(!hasFfmpeg)('runs media_frame_qc op and writes structured frame-qc.json with scene mapping', async () => {
  const dir = tempDir();
  const video = path.join(dir, 'sample.mp4');
  const outPath = path.join(dir, 'frame-qc.json');
  const built = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x1e2a3a:s=320x240:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=white:s=40x40:r=30:d=2',
      '-filter_complex',
      "[0:v][1:v]overlay=x='50+mod(n*4,180)':y=100:shortest=1,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(n,10,12)'[v]",
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      video,
    ],
    { encoding: 'utf8' },
  );
  if (built.status !== 0) throw new Error(built.stderr || 'ffmpeg failed');

  const op = findOp('media_frame_qc')!;
  expect(op).toBeDefined();
  const out = new Buffer();
  const signal = new AbortController().signal;
  const result = await op.run(
    normalizeParams(op, {
      video,
      fps: 30,
      scenes_json: JSON.stringify([
        { id: 'intro', startFrame: 0, endFrame: 30 },
        { id: 'body', startFrame: 30, endFrame: 60 },
      ]),
      out: outPath,
      check_audio: false,
    }),
    { out, err: out, signal, unsafe: false },
  );
  expect(fs.existsSync(outPath)).toBe(true);
  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  expect(written.verdict).toBe('fail');
  expect(written.issues).toContainEqual(
    expect.objectContaining({ kind: 'black', scene_id: 'intro', start_frame: 10, end_frame: 12 }),
  );
  expect(result?.data).toMatchObject({ verdict: 'fail', report_path: outPath });
});
