import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SilenceFloorDB, parseLoudnorm, rmsToDB } from './loudness';
import { ffmpeg, hasFfmpeg, tempDir, toolchain } from './testutil';

describe.skipIf(!hasFfmpeg)('loudness with real ffmpeg', () => {
  // 0.5 秒静音 + 0.5 秒正弦 + 0.5 秒静音，10ms 一窗共 150 窗；静音段必须落在地板附近。
  // ffmpeg sine 默认振幅 1/8，理论 RMS = 0.125/√2，即 -21.07 dBFS。
  it('separates tone from silence', () => {
    const tc = toolchain();
    const file = path.join(tempDir(), 'tone.wav');
    ffmpeg(
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=0.5',
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=0.5',
      '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', file,
    );
    const levels = tc.loudness(file, 0.01);
    expect(levels).toHaveLength(150);
    // 静音段电平不应过高。
    expect(levels[20]).toBeLessThanOrEqual(-90);
    expect(levels[130]).toBeLessThanOrEqual(-90);
    // 正弦段电平在预期范围。
    expect(levels[75]).toBeGreaterThanOrEqual(-21.6);
    expect(levels[75]).toBeLessThanOrEqual(-20.6);
  });

  it('rejects bad window and input', () => {
    const tc = toolchain();
    expect(() => tc.loudness('x.wav', 0)).toThrow('响度窗口必须是正数，收到 0');
    // 窗口短于一个采样。
    expect(() => tc.loudness('x.wav', 1e-9)).toThrow('响度窗口太短：1e-09 秒');
    expect(() => tc.loudness(path.join(tempDir(), 'missing.wav'), 0.01)).toThrow(/^无法解码音频：/);
    expect(rmsToDB(0)).toBe(SilenceFloorDB);
  });

  // 编码后的正弦能量稳定，积分响度与真峰都应落在有限值上，且真峰高于积分响度。
  it('measureProgramLoudness on encoded tone', () => {
    const tc = toolchain();
    const file = path.join(tempDir(), 'tone.m4a');
    ffmpeg('-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:a', 'aac', file);
    const got = tc.measureProgramLoudness(file);
    expect(got.integrated_lufs).toBeGreaterThanOrEqual(-30);
    expect(got.integrated_lufs).toBeLessThanOrEqual(-15);
    expect(got.true_peak_dbtp).toBeGreaterThan(got.integrated_lufs);
    expect(got.true_peak_dbtp).toBeLessThanOrEqual(0);
  });
});

it('parseLoudnorm takes last JSON block and floors silence', () => {
  const log =
    '[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-inf",\n\t"input_tp" : "-inf",\n\t"input_lra" : "0.00"\n}\nsize=N/A time=00:00:02.00\n';
  const got = parseLoudnorm('Metadata: {encoder}\n' + log);
  // 静音应记为地板值。
  expect(got).toEqual({ integrated_lufs: SilenceFloorDB, true_peak_dbtp: SilenceFloorDB, range_lu: 0 });
  for (const bad of ['no json here', '{"input_i":"loud","input_tp":"-1","input_lra":"1"}', '{"input_i":"nan","input_tp":"-1","input_lra":"1"}']) {
    expect(() => parseLoudnorm(bad), bad).toThrow();
  }
  expect(() => parseLoudnorm('{"input_i":"loud","input_tp":"-1","input_lra":"1"}')).toThrow('loudnorm 测量值 "loud" 不是数字');
});
