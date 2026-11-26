import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DefaultMixIntegratedLUFS, DefaultMixTruePeakMax, MixSampleRate, mixProgram } from './mix';
import { ffmpeg, hasFfmpeg, tempDir } from './testutil';
import { newToolchain } from './toolchain';

function videoStreamHash(ffmpegPath: string, file: string): string {
  const ran = spawnSync(
    ffmpegPath,
    ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'streamhash', '-'],
    {
      encoding: 'utf8',
    },
  );
  if (ran.status !== 0) throw new Error(ran.stderr || 'streamhash failed');
  return ran.stdout.trim();
}

it.skipIf(!hasFfmpeg)('mixes two stems and exports a verified AAC candidate without re-encoding video', async () => {
  const dir = tempDir();
  const voice = path.join(dir, 'voice.wav'),
    music = path.join(dir, 'source.wav'),
    video = path.join(dir, 'silent.mp4');
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', voice);
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', music);
  ffmpeg('-f', 'lavfi', '-i', 'color=blue:s=320x240:r=30:d=2', '-c:v', 'libx264', video);
  const chain = newToolchain(
    Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<
      string,
      string
    >,
  );
  const report = await mixProgram(chain, {
    directory: dir,
    voice,
    video,
    frames: 60,
    fps: 30,
    cues: [
      {
        kind: 'music',
        file: music,
        start: 0,
        length: 96_000,
        sourceStart: 0,
        gainDB: -15,
        fadeIn: 2400,
        fadeOut: 4800,
      },
    ],
    integratedLUFS: -16,
    truePeakMax: -1,
    loudnessTolerance: 2,
  });
  expect(report.ok, report.problems.join('; ')).toBe(true);
  expect(report.target_samples_per_channel).toBe(MixSampleRate * 2);
  expect(report.decoded_samples_per_channel).toBeGreaterThanOrEqual(report.target_samples_per_channel);
  expect(report.true_peak_dbtp).toBeLessThanOrEqual(-1);
  expect(chain.countFrames(path.join(dir, 'candidate.mp4'))).toBe(60);
  for (const name of ['music.wav', 'sfx.wav', 'premaster.wav'])
    expect(fs.statSync(path.join(dir, name)).size).toBeGreaterThan(0);
  const beat = fs.mkdtempSync(path.join(dir, 'beat-'));
  expect(
    await mixProgram(chain, {
      directory: beat,
      primaryMusic: music,
      video,
      frames: 60,
      fps: 30,
      cues: [],
      integratedLUFS: -16,
      truePeakMax: -1,
      loudnessTolerance: 2,
    }),
  ).toMatchObject({ ok: true, target_samples_per_channel: 96_000 });
  await expect(
    mixProgram(chain, {
      directory: beat,
      primaryMusic: voice,
      video,
      frames: 60,
      fps: 30,
      cues: [],
      integratedLUFS: -16,
      truePeakMax: -1,
      loudnessTolerance: 2,
    }),
  ).rejects.toThrow(/主音乐必须原样/);
});

it.skipIf(!hasFfmpeg)(
  'clamps hot impulsive SFX cue gain by true peak and masters with loudnorm + alimiter while preserving -c:v copy',
  async () => {
    const dir = tempDir();
    const voice = path.join(dir, 'voice.wav');
    const hotSfx = path.join(dir, 'impact.wav');
    const video = path.join(dir, 'silent.mp4');
    // 3 秒稳态旁白（48kHz 双声道，约 -18 LUFS 常见人声电平）
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=320:sample_rate=48000:duration=3',
      '-af',
      'volume=3dB',
      '-ac',
      '2',
      voice,
    );
    // 80ms 高电平短促脉冲打击音效：双声道源真峰值约 -0.4 dBFS（0.95 振幅正弦脉冲）
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.95*sin(2*PI*1200*t)|0.95*sin(2*PI*1200*t):s=48000:d=0.08',
      '-c:a',
      'pcm_f32le',
      hotSfx,
    );
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video);

    const chain = newToolchain(
      Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<
        string,
        string
      >,
    );
    const srcHash = videoStreamHash(chain.ffmpegPath(), video);

    // 1. 默认防护开启：对高电平短促音效给 +8 dB 增益应触发真峰值夹取，且输出满足 -14 LUFS (±1.5) 与 <= -1.0 dBTP
    const guarded = await mixProgram(chain, {
      directory: dir,
      voice,
      video,
      frames: 90,
      fps: 30,
      cues: [
        { kind: 'sfx', file: hotSfx, start: 24_000, length: 3_840, sourceStart: 0, gainDB: 8, fadeIn: 0, fadeOut: 0 },
      ],
    });
    expect(guarded.ok, guarded.problems.join('; ')).toBe(true);
    expect(guarded.clamped_cues).toHaveLength(1);
    expect(guarded.clamped_cues[0].clamped_from_db).toBe(8);
    expect(guarded.clamped_cues[0].applied_gain_db).toBeLessThan(0);
    expect(guarded.clamped_cues[0].source_true_peak_dbtp + guarded.clamped_cues[0].applied_gain_db).toBeLessThanOrEqual(
      -1.0,
    );
    expect(guarded.hints.some((h) => h.includes('防削波'))).toBe(true);
    expect(Math.abs(guarded.integrated_lufs - DefaultMixIntegratedLUFS)).toBeLessThanOrEqual(1.5);
    expect(guarded.true_peak_dbtp).toBeLessThanOrEqual(DefaultMixTruePeakMax);
    expect(guarded.limiter_limit_db).toBeLessThanOrEqual(-1.5);
    expect(chain.countFrames(path.join(dir, 'candidate.mp4'))).toBe(90);
    expect(videoStreamHash(chain.ffmpegPath(), path.join(dir, 'candidate.mp4'))).toBe(srcHash);

    // 2. 显式 allowClip=true 跳过单轨夹取，末端 alimiter 砖墙限幅依然保证 <= -1.0 dBTP 且视频流零重编
    const unguardedDir = fs.mkdtempSync(path.join(dir, 'allow-clip-'));
    const allowed = await mixProgram(chain, {
      directory: unguardedDir,
      voice,
      video,
      frames: 90,
      fps: 30,
      cues: [
        {
          kind: 'sfx',
          file: hotSfx,
          start: 24_000,
          length: 3_840,
          sourceStart: 0,
          gainDB: 8,
          fadeIn: 0,
          fadeOut: 0,
          allowClip: true,
        },
      ],
    });
    expect(allowed.ok, allowed.problems.join('; ')).toBe(true);
    expect(allowed.clamped_cues).toHaveLength(0);
    expect(allowed.true_peak_dbtp).toBeLessThanOrEqual(DefaultMixTruePeakMax);
    expect(videoStreamHash(chain.ffmpegPath(), path.join(unguardedDir, 'candidate.mp4'))).toBe(srcHash);

    // 3. 极低真峰目标（-30 dBTP，低于 alimiter -24 dB 下限）时通过整体衰减回退收敛并通过校验
    const lowTpDir = fs.mkdtempSync(path.join(dir, 'low-tp-'));
    const lowTp = await mixProgram(chain, {
      directory: lowTpDir,
      voice,
      video,
      frames: 90,
      fps: 30,
      cues: [],
      integratedLUFS: -14,
      truePeakMax: -30,
    });
    expect(lowTp.ok, lowTp.problems.join('; ')).toBe(true);
    expect(lowTp.true_peak_dbtp).toBeLessThanOrEqual(-30);
    expect(lowTp.encoded_gain_db).toBeLessThan(0);
  },
  30_000,
);
