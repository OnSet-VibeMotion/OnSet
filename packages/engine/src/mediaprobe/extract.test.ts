import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isBlank, isDark } from './mediaprobe';
import { Toolchain } from './toolchain';
import { ffmpeg, hasFfmpeg, sample, tempDir, toolchain } from './testutil';

it.each(['darwin','linux'] as const)('preserves the existing %s extraction and statistics calls', platform => {
  // 这里只测平台分派，两个外部调用都被替身接管，不要求本机安装媒体工具。
  const tc=new Toolchain('unused-ffprobe','',{}), descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
  const extract=vi.spyOn(tc,'extractFrameRegion').mockImplementation(()=>{});
  const statistics=vi.spyOn(tc,'frameStats').mockReturnValue({at_seconds:0.5,mean:100,stddev:10});
  try {
    Object.defineProperty(process,'platform',{...descriptor,value:platform});
    const report=tc.extractFramesRegion('fixture.mp4',[0.5],null,'fixture-output');
    expect(extract).toHaveBeenCalledOnce();expect(statistics).toHaveBeenCalledOnce();
    expect(report.frames[0].stats).toEqual({at_seconds:0.5,mean:100,stddev:10});
  } finally {Object.defineProperty(process,'platform',descriptor);extract.mockRestore();statistics.mockRestore();}
});

describe.skipIf(!hasFfmpeg || process.platform !== 'win32')('Windows single-decode frame extraction', () => {
  it('preserves PNG bytes and full-frame statistics, including cropped images and seeks across a long GOP', () => {
    const tc = toolchain();
    const file = sample('testsrc2=size=160x120:rate=30:duration=6', '-g', '120');
    const root = tempDir();
    const points = [130 / 30, 0, 7 / 30, 1.966667, 179 / 30];
    for (const region of [null, { x: 10, y: 20, w: 80, h: 60 }]) {
      const report = tc.extractFramesRegion(file, points, region, path.join(root, region ? 'cropped' : 'full'));
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
