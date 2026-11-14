import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Buffer, hasFfmpeg, run, tempDir } from './testutil';

/** 生成「0.5 秒静音 + 1 秒声音 + 0.5 秒静音 + 1 秒声音」的配音。 */
function makeVoice(file: string): void {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000:duration=1',
      '-filter_complex', '[0][1][2][3]concat=n=4:v=0:a=1', file,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`生成配音失败：${result.stderr}`);
}

describe('audio check', () => {
  it.skipIf(!hasFfmpeg)('command', async () => {
    const dir = tempDir();
    const voice = path.join(dir, 'voice.wav');
    makeVoice(voice);
    const aligned = path.join(dir, 'aligned.srt');
    fs.writeFileSync(aligned, '1\n00:00:00,500 --> 00:00:01,500\n第一句\n\n2\n00:00:02,000 --> 00:00:03,000\n第二句\n');
    let out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['audio', 'check', '--audio', voice, '--srt', aligned], out, errOut), `对齐的字幕应通过：${errOut.text}`).toBe(0);
    const early = path.join(dir, 'early.srt');
    fs.writeFileSync(early, '1\n00:00:00,100 --> 00:00:01,100\n第一句\n\n2\n00:00:01,600 --> 00:00:02,600\n第二句\n');
    const report = path.join(dir, 'check.json');
    out = new Buffer();
    errOut = new Buffer();
    const code = await run(['audio', 'check', '--audio', voice, '--srt', early, '--report-json', report], out, errOut);
    expect(code, `整体早 0.4 秒应被拦下：${errOut.text}`).toBe(1);
    expect(errOut.text).toContain('第 1 条字幕比声音早 0.400 秒');
    expect(out.text, '应打印中位偏差').toContain('-0.400');
    expect(fs.existsSync(report), '应写出报告').toBe(true);
  });

  it('requires inputs', async () => {
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['audio', 'check', '--audio', 'x.wav'], out, errOut)).toBe(1);
    expect(errOut.text, '缺 srt 应失败并点名').toContain('srt');
  });

  it('rejects non-positive options', async () => {
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['audio', 'check', '--audio', 'x.wav', '--srt', 'x.srt', '--tolerance', '0'], out, errOut)).toBe(1);
    expect(errOut.text, '容差为 0 应报错而不是悄悄换成默认值').toContain('tolerance 必须');
  });
});
