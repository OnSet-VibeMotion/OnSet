import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pngSize, shrinkPNG } from './image';
import { isBlank, isDark } from './mediaprobe';
import { ffmpeg, hasFfmpeg, sample, tempDir, toolchain } from './testutil';

describe.skipIf(!hasFfmpeg)('Single-decode frame extraction', () => {
  it('preserves PNG bytes and full-frame statistics, including cropped images and seeks across a long GOP', () => {
    const tc = toolchain();
    const file = sample('testsrc2=size=160x120:rate=30:duration=6', '-g', '120');
    const root = tempDir();
    const points = [130 / 30, 0, 7 / 30, 1.966667, 179 / 30];
    for (const region of [null, { x: 10, y: 20, w: 80, h: 60 }]) {
      const imageCall = vi.spyOn(tc, 'extractFrameRegion');
      const statsCall = vi.spyOn(tc, 'frameStats');
      const report = tc.extractFramesRegion(file, points, region, path.join(root, region ? 'cropped' : 'full'));
      expect(imageCall).not.toHaveBeenCalled();
      expect(statsCall).not.toHaveBeenCalled();
      imageCall.mockRestore();
      statsCall.mockRestore();
      expect(report.frames.map(frame => frame.at_seconds)).toEqual(points);
      for (const frame of report.frames) {
        const reference = path.join(root, 'reference.png');
        tc.extractFrameRegion(file, frame.at_seconds, region, reference);
        expect(fs.readFileSync(frame.image)).toEqual(fs.readFileSync(reference));
        expect(frame.stats).toEqual(tc.frameStats(file, frame.at_seconds));
        expect(frame.blank).toBe(isBlank(frame.stats));
        expect(frame.dark).toBe(isDark(frame.stats));
      }
    }
  });

  // 给看图的一方的 PNG 缩小（每张少花几倍 token），空白帧判定照旧按原帧；裁了区域就是要原始像素，不缩；本来就窄的不放大。
  it('scales the written PNG down without touching the statistics', () => {
    const tc = toolchain();
    const file = sample('testsrc2=size=320x180:rate=30:duration=1');
    const root = tempDir();
    const size = (png: string) => { const b = fs.readFileSync(png); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    const small = tc.extractFramesRegion(file, [0.5], null, path.join(root, 'small'), 160).frames[0];
    expect(size(small.image)).toEqual([160, 90]);
    expect(small.stats).toEqual(tc.frameStats(file, 0.5));
    const wide = tc.extractFramesRegion(file, [0.5], null, path.join(root, 'wide'), 960).frames[0];
    expect(size(wide.image)).toEqual([320, 180]);
    const cropped = tc.extractFramesRegion(file, [0.5], { x: 0, y: 0, w: 200, h: 100 }, path.join(root, 'crop'), 160).frames[0];
    expect(size(cropped.image)).toEqual([200, 100]);
  });

  it('shrinks a wide PNG in place and leaves a narrow one alone', async () => {
    const tc = toolchain();
    const root = tempDir();
    const wide = path.join(root, 'wide.png');
    const narrow = path.join(root, 'narrow.png');
    tc.extractFrame(sample('testsrc2=size=320x180:rate=30:duration=1'), 0.5, wide);
    tc.extractFrame(sample('testsrc2=size=96x54:rate=30:duration=1'), 0.5, narrow);
    const before = fs.readFileSync(narrow);
    expect(await shrinkPNG(tc, wide, 160)).toBe(true);
    expect(pngSize(wide)).toEqual({ width: 160, height: 90 });
    expect(await shrinkPNG(tc, narrow, 160)).toBe(false);
    expect(fs.readFileSync(narrow)).toEqual(before);
    expect(fs.readdirSync(root).sort()).toEqual(['narrow.png', 'wide.png']);
  });

  it('still reports blank frames and rejects a time beyond the last frame even with a previous PNG there', () => {
    const tc = toolchain();
    const file = sample('color=c=black:s=64x64:r=30:d=1');
    const dest = tempDir();
    const report = tc.extractFrames(file, [0, 0], dest);
    expect(report.frames).toHaveLength(2);
    expect(report.frames.every(frame => frame.blank)).toBe(true);
    expect(report.ok).toBe(false);
    const old = path.join(dest, 'frame-5.png');
    fs.copyFileSync(report.frames[0].image, old);
    expect(() => tc.extractFrames(file, [5], dest)).toThrow('抽帧没有产出内容');
    expect(fs.existsSync(old)).toBe(false);
  });

  it('keeps automatic stream selection when the main picture is not the first video stream', () => {
    const tc = toolchain();
    const root = tempDir();
    const file = path.join(root, 'multiple.mp4');
    ffmpeg('-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=1',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=1',
      '-map', '0:v', '-map', '1:v', '-disposition:v:0', '0', '-disposition:v:1', 'default',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file);
    const frame = tc.extractFrames(file, [0.5], path.join(root, 'frames')).frames[0];
    const reference = path.join(root, 'reference.png');
    tc.extractFrame(file, 0.5, reference);
    expect(fs.readFileSync(frame.image)).toEqual(fs.readFileSync(reference));
    expect(frame.stats).toEqual(tc.frameStats(file, 0.5));
    expect(frame.blank).toBe(false);
  });
});
