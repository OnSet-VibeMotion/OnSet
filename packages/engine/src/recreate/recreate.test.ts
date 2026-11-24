import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as mediaprobe from '../mediaprobe';
import {
  analyzeReferenceVideo,
  compareReferenceAndCandidate,
  renderMotionSpecMarkdown,
  writeMotionSpec,
} from './index';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-recreate-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('recreate', () => {
  it.skipIf(!hasFfmpeg)('detects hard cut, writes MotionSpec without banned words, and compares two clips', () => {
    const dir = tempDir();
    const refVideo = path.join(dir, 'ref.mp4');
    // 合成一个 2 秒双色切镜测试片（前 1 秒红底、后 1 秒蓝底）
    const gen = spawnSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x240:d=1:r=30',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:d=1:r=30',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      refVideo,
    ]);
    expect(gen.status).toBe(0);

    const tc = mediaprobe.newToolchain(process.env as Record<string, string>);
    const analysis = analyzeReferenceVideo(tc, refVideo, { stepSeconds: 0.25, cutThreshold: 30 });
    expect(analysis.cuts_seconds.length).toBeGreaterThanOrEqual(1);
    expect(analysis.shots.length).toBeGreaterThanOrEqual(2);

    const md = renderMotionSpecMarkdown(analysis, '双色测试片');
    expect(md).toContain('双色测试片');
    expect(md).toContain('shot-01');
    expect(md).not.toMatch(/\bagent\b/i);

    const proj = tempDir();
    const specFile = writeMotionSpec(proj, analysis, '双色测试片');
    expect(fs.existsSync(specFile)).toBe(true);

    // 自身对比应该 MAD ≈ 0 且通过
    const cmp = compareReferenceAndCandidate(tc, refVideo, refVideo, { sheetOut: path.join(dir, 'sheet.png') });
    expect(cmp.pass).toBe(true);
    expect(cmp.mean_mad).toBeLessThan(2);
    expect(fs.existsSync(path.join(dir, 'sheet.png'))).toBe(true);
  });
});
