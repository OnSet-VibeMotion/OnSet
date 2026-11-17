import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RenderAdvice, SnapshotAdvice, shouldShrinkSnapshot, snapshotStills } from './hfsnapshot';
import { compactHyperFrames } from './hfoutput';

describe('snapshot stills', () => {
  it('shrinks plain snapshots, not --zoom crops or other subcommands', () => {
    expect(shouldShrinkSnapshot(['snapshot', '--at', '1.5', '--describe', 'false'])).toBe(true);
    expect(shouldShrinkSnapshot(['snapshot', '--zoom', '.title'])).toBe(false);
    expect(shouldShrinkSnapshot(['snapshot', '--zoom=0,0,200,100'])).toBe(false);
    expect(shouldShrinkSnapshot(['render'])).toBe(false);
  });

  // 只认这次写出的单帧（frame-NN… 与 --keep 的 at-…），联系表、镜头目录外的文件、不存在的路径都不碰。
  it('finds the stills the output names inside the scene directory', () => {
    const scene = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset snap with spaces-')));
    const shots = path.join(scene, '.hyperframes', 'artifacts', 'snapshots', 'abc');
    fs.mkdirSync(shots, { recursive: true });
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-snap-out-')));
    const files = ['frame-00-at-0s.png', 'frame-01-at-1.5s.png', 'at-2.25s.png', 'contact-sheet.jpg'].map((name) => path.join(shots, name));
    for (const file of [...files, path.join(outside, 'frame-00-at-0s.png')]) fs.writeFileSync(file, 'x');
    const output = [
      `◇  ${files[0]}`,
      JSON.stringify({ frames: [{ path: files[1] }, { path: files[2] }, { path: files[1] }], sheets: [files[3]] }),
      `${path.join(outside, 'frame-00-at-0s.png')}`,
      `${path.join(shots, 'frame-09-at-9s.png')}`,
    ].join('\n');
    expect(snapshotStills(output, scene).sort()).toEqual([files[0], files[1], files[2]].sort());
  });

  // 两句提醒接在 hyperframes 的输出后面，精简输出时不能被当成日志删掉。
  it('keeps the advice through output compaction', () => {
    for (const advice of [SnapshotAdvice, RenderAdvice]) {
      expect(compactHyperFrames(`[INFO] trace\n◇  /p/out.mp4\n${advice}\n`).text).toContain(advice);
    }
    expect(RenderAdvice).toContain('ffprobe');
    expect(SnapshotAdvice).toContain('--zoom');
  });
});
