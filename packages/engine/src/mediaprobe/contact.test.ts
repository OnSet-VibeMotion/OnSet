import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contactSheetPadding } from './contact';
import { videoResolution } from './mediaprobe';
import { hasFfmpeg, sample, tempDir, toolchain } from './testutil';

describe.skipIf(!hasFfmpeg)('contact sheet', () => {
  // 5 帧按 3 列拼成 2 行，最后一行不满也要输出。尺寸 = 列数 × 缩略图宽 + 分隔，按公式核对，不靠肉眼。
  it('tiles frames into one image', () => {
    const tc = toolchain();
    const file = sample('testsrc=size=320x240:rate=30:duration=2');
    const dest = path.join(tempDir(), 'review', 'sheet.png');
    tc.contactSheet(file, [0, 0.5, 1, 1.5, 1.9], 3, 64, dest);
    const media = tc.probe(dest);
    const wantWidth = 3 * 64 + 2 * contactSheetPadding + 2 * contactSheetPadding;
    const wantHeight = 2 * 48 + contactSheetPadding + 2 * contactSheetPadding;
    expect(videoResolution(media.video!)).toBe(`${wantWidth}x${wantHeight}`);
    // 临时缩略图目录要清理。
    expect(fs.readdirSync(path.dirname(dest)).filter((name) => name.startsWith('.contact-'))).toEqual([]);
  });

  it('rejects bad input', () => {
    const tc = toolchain();
    const file = sample('testsrc=size=320x240:rate=30:duration=1');
    const dest = path.join(tempDir(), 'sheet.png');
    expect(() => tc.contactSheet(file, [], 3, 64, dest)).toThrow('联系表至少需要一个时间点');
    expect(() => tc.contactSheet(file, [0], 0, 64, dest)).toThrow('联系表列数必须 ≥ 1、缩略图宽度必须 ≥ 16，收到 0 列、64 像素');
    // 时间点超出时长时应报错而不是产出空图。
    expect(() => tc.contactSheet(file, [5], 3, 64, dest)).toThrow();
    // 失败时不应留下联系表文件。
    expect(fs.existsSync(dest)).toBe(false);
  });

  // frameStats 改为输入端定位后必须仍取到第 k 帧。
  // 素材每帧亮度 = 帧号 × 4，GOP 设为 120，让取样点跨过关键帧。
  it('input seek is frame accurate', () => {
    const tc = toolchain();
    const file = sample("color=c=black:s=64x64:r=30:d=6,format=gray,geq=lum='mod(N\\,60)*4'", '-g', '120', '-qp', '0');
    for (const frame of [2, 7, 59, 119, 130, 179]) {
      const stats = tc.frameStats(file, frame / 30);
      const want = (frame % 60) * 4;
      expect(stats.mean, `第 ${frame} 帧`).toBeGreaterThanOrEqual(want - 2);
      expect(stats.mean, `第 ${frame} 帧`).toBeLessThanOrEqual(want + 2);
    }
  });

  it('region crops before scaling', () => {
    const tc = toolchain();
    const file = sample('testsrc=size=320x240:rate=30:duration=1');
    const dir = tempDir();
    const region = { x: 100, y: 50, w: 120, h: 80 };
    const still = path.join(dir, 'crop.png');
    tc.extractFrameRegion(file, 0.5, region, still);
    // 裁剪后应为 120x80。
    expect(videoResolution(tc.probe(still).video!)).toBe('120x80');
    const sheet = path.join(dir, 'sheet.png');
    tc.contactSheetRegion(file, [0, 0.5], region, 2, 60, sheet);
    // 每格 60x40（120x80 等比缩放），2 列 1 行加分隔。
    expect(videoResolution(tc.probe(sheet).video!)).toBe(`${2 * 60 + 3 * contactSheetPadding}x${40 + 2 * contactSheetPadding}`);
    const report = tc.extractFramesRegion(file, [0.2], region, dir);
    expect(report.frames).toHaveLength(1);
  });
});
