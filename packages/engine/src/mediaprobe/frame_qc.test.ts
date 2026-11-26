import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { envMap } from '../envutil';
import * as review from '../review';
import { type FrameQCScene, mapFrameRangeToScenes, readFrameQCSummary, runFrameQC, summarizeFrameQC } from './frame_qc';
import { VideoLogParser } from './frame_qc_parse';
import { ffmpeg, hasFfmpeg } from './testutil';
import { newToolchain } from './toolchain';

const cleanupDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-frame-qc-'));
  cleanupDirs.push(dir);
  return dir;
}

/** 生成背景上带安全区内移动方块的动态测试片段（支持附加滤镜）。 */
function makeDynamicClip(
  out: string,
  durationSec: number,
  boxColor: string,
  extraVf?: string,
  audioArgs?: string[],
): void {
  const chain = `[0:v][1:v]overlay=x='60+mod(n*4,160)':y=100:shortest=1${extraVf ? `,${extraVf}` : ''}[v]`;
  const args = [
    '-f',
    'lavfi',
    '-i',
    `color=c=0x1e2a3a:s=320x240:r=30:d=${durationSec}`,
    '-f',
    'lavfi',
    '-i',
    `color=c=${boxColor}:s=40x40:r=30:d=${durationSec}`,
    ...(audioArgs ?? []),
    '-filter_complex',
    chain,
    '-map',
    '[v]',
    ...(audioArgs ? ['-map', '2:a:0'] : []),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '18',
    ...(audioArgs ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    out,
  ];
  ffmpeg(...args);
}

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('frame_qc pure helpers', () => {
  it('maps frame ranges to scenes for both half-open and inclusive schedules', () => {
    const halfOpen: FrameQCScene[] = [
      { id: 's1', startFrame: 0, endFrame: 60 },
      { id: 's2', startFrame: 60, endFrame: 120 },
    ];
    expect(mapFrameRangeToScenes(0, 59, halfOpen, 120)).toEqual(['s1']);
    expect(mapFrameRangeToScenes(60, 62, halfOpen, 120)).toEqual(['s2']);
    expect(mapFrameRangeToScenes(58, 61, halfOpen, 120)).toEqual(['s1', 's2']);

    const inclusive: FrameQCScene[] = [
      { id: 's1', startFrame: 0, endFrame: 59, inclusive: true },
      { id: 's2', startFrame: 60, endFrame: 119, inclusive: true },
    ];
    expect(mapFrameRangeToScenes(59, 59, inclusive, 120)).toEqual(['s1']);
    expect(mapFrameRangeToScenes(60, 119, inclusive, 120)).toEqual(['s2']);

    // 部分/有间隔的时间表：默认半开区间 [0, 60) 不应把第 60 帧误归属到 s1。
    const partial: FrameQCScene[] = [{ id: 's1', startFrame: 0, endFrame: 60 }];
    expect(mapFrameRangeToScenes(59, 59, partial, 120)).toEqual(['s1']);
    expect(mapFrameRangeToScenes(60, 60, partial, 120)).toEqual([]);
  });

  it('closes trailing freeze interval at EOF and summarizes severities', () => {
    const parser = new VideoLogParser();
    parser.feed('[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 2.0\n');
    parser.finish(5.5, 1.2);
    expect(parser.freezes).toEqual([{ startSeconds: 2.0, endSeconds: 5.5, durationSeconds: 3.5 }]);

    const summary = summarizeFrameQC([
      {
        kind: 'freeze',
        severity: 'info',
        start_frame: 0,
        end_frame: 40,
        start_seconds: 0,
        end_seconds: 1.367,
        duration_seconds: 1.367,
        message: 'info',
      },
      {
        kind: 'edge_clip',
        severity: 'warn',
        edge: 'top',
        start_frame: 50,
        end_frame: 60,
        start_seconds: 1.667,
        end_seconds: 2.033,
        duration_seconds: 0.367,
        message: 'warn',
      },
    ]);
    expect(summary).toMatchObject({ verdict: 'warn', issue_count: 2, fail_count: 0, warn_count: 1, info_count: 1 });
  });
});

describe('frame_qc FFmpeg integration', () => {
  it.skipIf(!hasFfmpeg)(
    'detects 3-frame black, single-frame white flash, top-edge clip, and >3s freeze with exact frame/scene mapping and 0 false positives on clean scene',
    async () => {
      const dir = makeTmpDir();
      const s1 = path.join(dir, 's1.mp4');
      const s2 = path.join(dir, 's2.mp4');
      const s3 = path.join(dir, 's3.mp4');
      const s4 = path.join(dir, 's4.mp4');
      const joined = path.join(dir, 'defective.mp4');
      const qcPath = path.join(dir, 'frame-qc.json');

      // s1 (frames 0..44, 1.5s): 正常动态安全区内移动方块 -> 应 0 误报
      makeDynamicClip(s1, 1.5, 'white');
      // s2 (frames 45..89, 1.5s): 含 3 帧黑场 (全局 50..52) + 单帧白闪 (全局 65)
      makeDynamicClip(
        s2,
        1.5,
        '0x44aaee',
        "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(n,5,7)'," +
          "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,20)'",
      );
      // s3 (frames 90..134, 1.5s): 动态画面 + 顶边贴边高对比度白块 (全局 100..125)
      makeDynamicClip(s3, 1.5, '0x66cc88', "drawbox=x=80:y=0:w=160:h=20:color=white:t=fill:enable='between(n,10,35)'");
      // s4 (frames 135..239, 3.5s): 超过 3 秒的长静止段
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        'color=c=0x1e2a3a:s=320x240:r=30:d=3.5',
        '-vf',
        'drawbox=x=120:y=100:w=60:h=40:color=0xeeaa44:t=fill',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '18',
        s4,
      );

      const listFile = path.join(dir, 'list.txt');
      fs.writeFileSync(listFile, [s1, s2, s3, s4].map((f) => `file '${f}'`).join('\n') + '\n');
      ffmpeg('-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'copy', joined);

      const scenes: FrameQCScene[] = [
        { id: 's1', startFrame: 0, endFrame: 45 },
        { id: 's2', startFrame: 45, endFrame: 90 },
        { id: 's3', startFrame: 90, endFrame: 135 },
        { id: 's4', startFrame: 135, endFrame: 240 },
      ];
      const chain = newToolchain(envMap());
      const report = await runFrameQC(chain, { video: joined, fps: 30, scenes, outPath: qcPath });

      expect(report.total_frames).toBe(240);
      expect(report.verdict).toBe('fail');
      expect(fs.existsSync(qcPath)).toBe(true);

      // 正常动态镜头 s1 必须 0 误报
      expect(report.issues.filter((i) => i.scene_id === 's1')).toEqual([]);

      // 黑场（3 帧：50..52）精确命中 s2
      const black = report.issues.find((i) => i.kind === 'black');
      expect(black).toBeDefined();
      expect(black).toMatchObject({ scene_id: 's2', start_frame: 50, end_frame: 52, severity: 'fail' });

      // 单帧白闪（第 65 帧）精确命中 s2
      const flash = report.issues.find((i) => i.kind === 'flash');
      expect(flash).toBeDefined();
      expect(flash).toMatchObject({ scene_id: 's2', start_frame: 65, end_frame: 65, severity: 'fail' });

      // 顶边贴边（第 100..125 帧）精确命中 s3
      const edge = report.issues.find((i) => i.kind === 'edge_clip' && i.edge === 'top');
      expect(edge).toBeDefined();
      expect(edge).toMatchObject({ scene_id: 's3', start_frame: 100, end_frame: 125, severity: 'warn' });

      // >3s 长静止段（默认 freezeSeconds=1.2s，>=2x 记 warn）精确命中 s4
      const freeze = report.issues.find((i) => i.kind === 'freeze');
      expect(freeze).toBeDefined();
      expect(freeze).toMatchObject({ scene_id: 's4', severity: 'warn' });
      expect(freeze!.start_frame).toBeGreaterThanOrEqual(135);
      expect(freeze!.duration_seconds).toBeGreaterThan(3.0);

      // review.ts 薄桥接能读取并透出 frame-qc.json 摘要
      expect(readFrameQCSummary(qcPath)).toEqual(report.summary);
      const reviewOut = path.join(dir, 'review-out');
      const rev = review.run(chain, {
        video: joined,
        fps: 30,
        silent: true,
        outDir: reviewOut,
        thumbWidth: 64,
        frameQCPath: qcPath,
      });
      expect(rev.frame_qc).toEqual(report.summary);
      expect(rev.hints.some((h) => h.includes('全流帧检 verdict=fail'))).toBe(true);
    },
    30_000,
  );

  it.skipIf(!hasFfmpeg)('reports 0 false positives on a clean dynamic video with healthy audio', async () => {
    const dir = makeTmpDir();
    const clean = path.join(dir, 'clean.mp4');
    makeDynamicClip(clean, 2, '0xffcc33', undefined, [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=2',
      '-af',
      'volume=-3dB',
    ]);
    const report = await runFrameQC(newToolchain(envMap()), {
      video: clean,
      fps: 30,
      scenes: [{ id: 'clean-01', startFrame: 0, endFrame: 60 }],
    });
    expect(report.verdict, JSON.stringify(report.issues)).toBe('pass');
    expect(report.issues).toEqual([]);
    expect(report.audio).toBeDefined();
    expect(report.audio!.true_peak_dbtp).toBeLessThan(-1);
  });

  it.skipIf(!hasFfmpeg)('flags clipping audio and full-silence audio tracks', async () => {
    const dir = makeTmpDir();
    const clipped = path.join(dir, 'clipped.mp4');
    const silent = path.join(dir, 'silent-audio.mp4');
    // 削波音频：高电平正弦波经 +24dB 导致限幅削波 > -0.1 dBFS
    makeDynamicClip(clipped, 1, 'white', undefined, [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-af',
      'volume=24dB',
    ]);
    // 整段静音音轨
    makeDynamicClip(silent, 1, 'white', undefined, ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1']);
    const chain = newToolchain(envMap());
    const clipReport = await runFrameQC(chain, { video: clipped, fps: 30 });
    expect(clipReport.issues.some((i) => i.kind === 'audio_clip')).toBe(true);

    const silentReport = await runFrameQC(chain, { video: silent, fps: 30 });
    expect(silentReport.issues.some((i) => i.kind === 'audio_silence' && i.severity === 'fail')).toBe(true);
  });
});
