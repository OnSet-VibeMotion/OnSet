import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AVBacktestAnchor, runAVBacktest } from './av_backtest';
import { newToolchain } from './toolchain';

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-av-backtest-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

/** 写出 48kHz 单声道 16-bit PCM WAV，在指定脉冲时刻放置 Hann 窗多频打击瞬态。 */
function writePulseWav(
  file: string,
  durationSeconds: number,
  pulseTimesSeconds: readonly number[],
  options: { sampleRate?: number; baseFreq?: number; pulseDurationSeconds?: number; amplitude?: number } = {},
): void {
  const sampleRate = options.sampleRate ?? 48_000;
  const pulseDuration = options.pulseDurationSeconds ?? 0.035;
  const baseFreq = options.baseFreq ?? 520;
  const amplitude = options.amplitude ?? 0.8;
  const totalSamples = Math.round(durationSeconds * sampleRate);
  const pcm = new Float32Array(totalSamples);

  for (let p = 0; p < pulseTimesSeconds.length; p++) {
    const center = Math.round(pulseTimesSeconds[p] * sampleRate);
    const half = Math.round((pulseDuration * sampleRate) / 2);
    const freq = baseFreq + p * 110;
    for (let k = -half; k <= half; k++) {
      const idx = center + k;
      if (idx < 0 || idx >= totalSamples) continue;
      const u = (k + half) / (2 * half);
      const env = 0.5 * (1 - Math.cos(2 * Math.PI * u));
      const t = k / sampleRate;
      const wave = 0.6 * Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(2 * Math.PI * (freq * 2.13) * t);
      pcm[idx] = Math.max(-0.98, Math.min(0.98, pcm[idx] + amplitude * env * wave));
    }
  }

  const dataBytes = totalSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < totalSamples; i++) {
    buf.writeInt16LE(Math.round(pcm[i] * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

/** 用 FFmpeg 合成 320x240@30fps 测试成片：黑底 + 指定帧列表在中心 ROI（80,60,160,120）白闪，并与指定音轨封装。 */
function synthesizeFlashVideo(
  dest: string,
  audioWav: string,
  durationSeconds: number,
  flashFrames: readonly number[],
  fps = 30,
): void {
  const drawExpr =
    flashFrames.length > 0
      ? `,drawbox=x=80:y=60:w=160:h=120:color=white:t=fill:enable='${flashFrames.map((f) => `eq(n,${f})`).join('+')}'`
      : '';
  const r = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=320x240:r=${fps}:d=${durationSeconds}`,
      '-i',
      audioWav,
      '-vf',
      `format=yuv420p${drawExpr}`,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '256k',
      '-ar',
      '48000',
      '-shortest',
      dest,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`合成测试视频失败：${r.stderr}`);
}

const centerROI = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
const baseAnchors = (metric: 'brightness' | 'change' = 'brightness'): AVBacktestAnchor[] => [
  { id: 'hit_1', type: 'action', music_seconds: 1.0, planned_frame: 30, visual: { metric, roi: centerROI } },
  { id: 'hit_2', type: 'action', music_seconds: 2.0, planned_frame: 60, visual: { metric, roi: centerROI } },
  { id: 'hit_3', type: 'action', music_seconds: 3.0, planned_frame: 90, visual: { metric, roi: centerROI } },
];

describe.skipIf(!hasFfmpeg)('av_backtest (needs ffmpeg)', () => {
  it('passes at 0-frame and +1-frame visual offset (both brightness and change metrics)', async () => {
    const dir = tempDir();
    const music = path.join(dir, 'source.wav');
    writePulseWav(music, 4.0, [1.0, 2.0, 3.0]);

    const video0 = path.join(dir, 'offset-0.mp4');
    synthesizeFlashVideo(video0, music, 4.0, [30, 60, 90]);
    const outPath = path.join(dir, 'av-backtest.json');
    const tc = newToolchain(process.env as Record<string, string>);

    const report0 = await runAVBacktest(tc, {
      video: video0,
      sourceMusic: music,
      anchors: baseAnchors('brightness'),
      outPath,
    });
    expect(report0.verdict).toBe('pass');
    expect(report0.summary).toMatchObject({ total: 3, pass: 3, fail: 0, unverified: 0, reliable_music_matches: 3 });
    expect(report0.measured_output_offset_seconds).not.toBeNull();
    expect(Math.abs(report0.measured_output_offset_seconds!)).toBeLessThan(0.03);
    for (const a of report0.anchors) {
      expect(a.status).toBe('pass');
      expect(Math.abs(a.visual_error_frames!)).toBeLessThanOrEqual(1);
    }
    expect(fs.existsSync(outPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(outPath, 'utf8')).verdict).toBe('pass');

    // +1 帧偏移（默认 ±2 帧容差内）同样 pass，同时验证 change 指标
    const video1 = path.join(dir, 'offset-plus1.mp4');
    synthesizeFlashVideo(video1, music, 4.0, [31, 61, 91]);
    const report1 = await runAVBacktest(tc, {
      video: video1,
      sourceMusic: music,
      anchors: baseAnchors('change'),
    });
    expect(report1.verdict).toBe('pass');
    for (const a of report1.anchors) {
      expect(a.status).toBe('pass');
      expect(a.visual.peak_frame).toBe(a.planned_frame + 1);
      expect(a.visual_error_frames!).toBeGreaterThan(0.3);
      expect(a.visual_error_frames!).toBeLessThan(1.7);
    }
  });

  it('fails at +5-frame offset and accurately reports frame error and measured_output_offset_seconds', async () => {
    const dir = tempDir();
    const music = path.join(dir, 'source.wav');
    writePulseWav(music, 4.0, [1.0, 2.0, 3.0]);

    // 情况 A：画面滞后 +5 帧（35/65/95），音轨无额外延迟
    const video5 = path.join(dir, 'offset-plus5.mp4');
    synthesizeFlashVideo(video5, music, 4.0, [35, 65, 95]);
    const tc = newToolchain(process.env as Record<string, string>);
    const report5 = await runAVBacktest(tc, {
      video: video5,
      sourceMusic: music,
      anchors: baseAnchors('brightness'),
    });
    expect(report5.verdict).toBe('fail');
    expect(report5.summary.fail).toBe(3);
    expect(report5.measured_output_offset_seconds).not.toBeNull();
    for (const a of report5.anchors) {
      expect(a.status).toBe('fail');
      expect(a.visual.peak_frame).toBe(a.planned_frame + 5);
      expect(Math.round(a.visual_error_frames!)).toBe(5);
    }

    // 情况 B：音轨整体延迟 +0.100s（3 帧），画面停在 30/60/90 -> measured_output_offset_seconds 应精确测出 ~+0.100s
    const delayedMusic = path.join(dir, 'delayed.wav');
    writePulseWav(delayedMusic, 4.0, [1.1, 2.1, 3.1]);
    const videoDelayed = path.join(dir, 'audio-delayed.mp4');
    synthesizeFlashVideo(videoDelayed, delayedMusic, 4.0, [30, 60, 90]);
    const reportDelayed = await runAVBacktest(tc, {
      video: videoDelayed,
      sourceMusic: music,
      anchors: baseAnchors('brightness'),
    });
    expect(reportDelayed.verdict).toBe('fail');
    expect(reportDelayed.measured_output_offset_seconds).not.toBeNull();
    expect(Math.abs(reportDelayed.measured_output_offset_seconds! - 0.1)).toBeLessThan(0.025);
    expect(reportDelayed.summary.music_offset_spread_seconds!).toBeLessThan(0.015);
  });

  it('honestly marks pure static video as unverified', async () => {
    const dir = tempDir();
    const music = path.join(dir, 'source.wav');
    writePulseWav(music, 4.0, [1.0, 2.0, 3.0]);
    const staticVideo = path.join(dir, 'static.mp4');
    synthesizeFlashVideo(staticVideo, music, 4.0, []);
    const tc = newToolchain(process.env as Record<string, string>);
    const report = await runAVBacktest(tc, {
      video: staticVideo,
      sourceMusic: music,
      anchors: baseAnchors('brightness'),
    });
    expect(report.verdict).toBe('unverified');
    expect(report.summary).toMatchObject({ total: 3, pass: 0, fail: 0, unverified: 3 });
    for (const a of report.anchors) {
      expect(a.status).toBe('unverified');
      expect(a.visual.verified).toBe(false);
    }
  });

  it('measures SFX-to-music error via sfxStem', async () => {
    const dir = tempDir();
    const music = path.join(dir, 'source.wav');
    const sfxOk = path.join(dir, 'sfx-ok.wav');
    const sfxLate = path.join(dir, 'sfx-late.wav');
    writePulseWav(music, 4.0, [1.0, 2.0, 3.0]);
    writePulseWav(sfxOk, 4.0, [1.0, 2.0, 3.0], { baseFreq: 900 });
    writePulseWav(sfxLate, 4.0, [1.0, 2.17, 3.0], { baseFreq: 900 }); // 第 2 个音效偏晚 ~5 帧
    const video = path.join(dir, 'ok.mp4');
    synthesizeFlashVideo(video, music, 4.0, [30, 60, 90]);
    const tc = newToolchain(process.env as Record<string, string>);
    const anchors: AVBacktestAnchor[] = baseAnchors('brightness').map((a, i) => ({
      ...a,
      sfx: [{ cue_id: `hit_sfx_${i + 1}`, peak_seconds: 0.1 }],
    }));

    const passReport = await runAVBacktest(tc, { video, sourceMusic: music, sfxStem: sfxOk, anchors });
    expect(passReport.verdict).toBe('pass');

    const failReport = await runAVBacktest(tc, { video, sourceMusic: music, sfxStem: sfxLate, anchors });
    expect(failReport.verdict).toBe('fail');
    expect(failReport.anchors[1].sfx[0].status).toBe('fail');
    expect(Math.round(failReport.anchors[1].sfx[0].sfx_error_frames!)).toBe(5);

    // 同一锚点绑定多条无源素材的 cue 时，不得把同一个分轨峰判给两条 cue（必须标为 unverified）
    const multiSfxAnchors: AVBacktestAnchor[] = [
      {
        id: 'hit_multi',
        type: 'action',
        music_seconds: 1.0,
        planned_frame: 30,
        visual: { metric: 'brightness', roi: centerROI },
        sfx: [
          { cue_id: 'cue_a', peak_seconds: 0.1 },
          { cue_id: 'cue_b', peak_seconds: 0.1 },
        ],
      },
    ];
    const multiReport = await runAVBacktest(tc, {
      video,
      sourceMusic: music,
      sfxStem: sfxOk,
      anchors: multiSfxAnchors,
    });
    expect(multiReport.verdict).toBe('unverified');
    expect(multiReport.anchors[0].sfx.every((s) => s.status === 'unverified')).toBe(true);
  });

  it('preserves delayed audio first-packet PTS, deduplicates music observations, handles mismatched fps, odd 1px ROI, and minVisualDelta=0', async () => {
    const dir = tempDir();
    const music = path.join(dir, 'source.wav');
    writePulseWav(music, 4.0, [1.0, 2.0, 3.0]);
    const tc = newToolchain(process.env as Record<string, string>);

    // 1. 首包 PTS 延迟 +0.167s 且未预填静音：必须测出约 5 帧偏差（不能判 pass）
    const delayedPtsVideo = path.join(dir, 'delayed-pts.mp4');
    const rDelay = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x240:r=30:d=4',
        '-itsoffset',
        '0.167',
        '-i',
        music,
        '-vf',
        "format=yuv420p,drawbox=x=80:y=60:w=160:h=120:color=white:t=fill:enable='eq(n,30)+eq(n,60)+eq(n,90)'",
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '256k',
        '-ar',
        '48000',
        '-t',
        '4',
        delayedPtsVideo,
      ],
      { encoding: 'utf8' },
    );
    if (rDelay.status !== 0) throw new Error(rDelay.stderr);
    const delayRep = await runAVBacktest(tc, {
      video: delayedPtsVideo,
      sourceMusic: music,
      anchors: baseAnchors('brightness'),
    });
    expect(delayRep.verdict).toBe('fail');
    expect(delayRep.measured_output_offset_seconds).not.toBeNull();
    expect(delayRep.measured_output_offset_seconds!).toBeGreaterThan(0.1);

    // 2. 三个锚点引用同一音乐时刻（不同 ROI）：reliable_music_matches 应去重为 1，不产出校准建议
    const video0 = path.join(dir, 'ok0.mp4');
    synthesizeFlashVideo(video0, music, 4.0, [30, 60, 90]);
    const sameMoment = await runAVBacktest(tc, {
      video: video0,
      sourceMusic: music,
      anchors: [
        {
          id: 'roi_1',
          type: 'action',
          music_seconds: 1.0,
          planned_frame: 30,
          visual: { metric: 'brightness', roi: { x: 81, y: 61, w: 1, h: 1 } },
        },
        {
          id: 'roi_2',
          type: 'action',
          music_seconds: 1.0,
          planned_frame: 30,
          visual: { metric: 'brightness', roi: { x: 91, y: 71, w: 1, h: 1 } },
        },
        {
          id: 'roi_3',
          type: 'action',
          music_seconds: 1.0,
          planned_frame: 30,
          visual: { metric: 'brightness', roi: { x: 101, y: 81, w: 1, h: 1 } },
        },
      ],
    });
    expect(sameMoment.verdict).toBe('pass');
    expect(sameMoment.summary.reliable_music_matches).toBe(1);
    expect(sameMoment.measured_output_offset_seconds).toBeNull();

    // 3. 计划 30fps、成片 60fps 时窗口中心按成片帧率定位到第 60/120/180 帧
    const video60 = path.join(dir, 'ok60.mp4');
    synthesizeFlashVideo(video60, music, 4.0, [60, 120, 180], 60);
    const mismatchRep = await runAVBacktest(tc, {
      video: video60,
      sourceMusic: music,
      fps: 30,
      anchors: baseAnchors('brightness'),
    });
    expect(mismatchRep.verdict).toBe('pass');

    // 4. minVisualDelta=0 时静止画面仍必须判 unverified
    const staticVideo = path.join(dir, 'static-zero.mp4');
    synthesizeFlashVideo(staticVideo, music, 4.0, []);
    const staticZero = await runAVBacktest(tc, {
      video: staticVideo,
      sourceMusic: music,
      minVisualDelta: 0,
      anchors: baseAnchors('change'),
    });
    expect(staticZero.verdict).toBe('unverified');
  });
});
