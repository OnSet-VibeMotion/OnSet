// 移植自 internal/cli/media_test.go。
import { Buffer, hasFfmpeg, makeClip, makeSceneDir, run, tempDir } from './testutil';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCanvas, parseTimePoints } from './media';

describe('media', () => {
  it('parseCanvas', () => {
    const cases: [string, number, number, boolean][] = [
      ['1080x1440', 1080, 1440, true],
      ['1080X1920', 1080, 1920, true],
      [' 1080 x 1920 ', 1080, 1920, true],
      ['1080', 0, 0, false],
      ['1080x', 0, 0, false],
      ['x1440', 0, 0, false],
      ['0x1440', 0, 0, false],
      ['-1080x1440', 0, 0, false],
      ['axb', 0, 0, false],
      ['', 0, 0, false],
    ];
    for (const [input, width, height, ok] of cases) {
      if (ok) expect(parseCanvas(input), input).toEqual([width, height]);
      else expect(() => parseCanvas(input), input).toThrow();
    }
  });

  it('parseTimePoints supports seconds, percent and end', () => {
    // 时长 10 秒、30fps：末帧在 10 - 1/30 ≈ 9.9667 秒。
    const points = parseTimePoints('0,25%,50%,end', 10, 30);
    const want = [0, 2.5, 5, 10 - 1.0 / 30];
    expect(points.length).toBe(want.length);
    want.forEach((value, i) => expect(Math.abs(points[i] - value)).toBeLessThanOrEqual(1e-9));
  });

  // end 直接取时长会超出末帧，ffmpeg 会返回成功却什么都不输出——静默产出空文件比报错更危险。
  it('parseTimePoints end stays within last frame', () => {
    expect(parseTimePoints('end', 2, 30)[0]).toBeLessThan(2);
    // 100% 同样要被夹到末帧内。
    expect(parseTimePoints('100%', 2, 30)[0]).toBeLessThan(2);
  });

  it('parseTimePoints rejects bad input', () => {
    for (const input of ['', '  ', 'abc', '-1', '101%', '-5%', '99', '1,abc']) {
      expect(() => parseTimePoints(input, 10, 30), input).toThrow();
    }
  });

  it('parseTimePoints tolerates missing fps', () => {
    // fps 为 0 时退回 30，不能除零。
    const points = parseTimePoints('end', 1, 0);
    expect(points[0]).toBeGreaterThan(0);
    expect(points[0]).toBeLessThan(1);
  });

  // --- 以下需要真实 ffmpeg/ffprobe ---

  it.skipIf(!hasFfmpeg)('validate video reports all mismatches', async () => {
    const dir = tempDir();
    const clip = path.join(dir, 'clip.mp4');
    makeClip(clip, 'testsrc=size=320x240:rate=25:duration=1');
    const out = new Buffer();
    const errOut = new Buffer();
    const reportPath = path.join(dir, 'report.json');
    const code = await run(['validate', 'video', clip, '--canvas', '1080x1440', '--fps', '30', '--silent', '--report-json', reportPath], out, errOut);
    expect(code, errOut.text).toBe(1);
    for (const want of ['分辨率不符', '帧率不符']) expect(errOut.text).toContain(want);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { ok: boolean; problems: string[] };
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!hasFfmpeg)('validate video passes', async () => {
    const clip = path.join(tempDir(), 'clip.mp4');
    makeClip(clip, 'testsrc=size=320x240:rate=30:duration=1');
    const out = new Buffer();
    const errOut = new Buffer();
    const code = await run(['validate', 'video', clip, '--canvas', '320x240', '--fps', '30', '--silent', '--decode'], out, errOut);
    expect(code, errOut.text).toBe(0);
    expect(out.text).toContain('校验通过');
  });

  it.skipIf(!hasFfmpeg)('validate video rejects contradictory audio flags', async () => {
    const clip = path.join(tempDir(), 'clip.mp4');
    makeClip(clip, 'testsrc=size=320x240:rate=30:duration=1');
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['validate', 'video', clip, '--canvas', '320x240', '--silent', '--audio'], out, errOut)).toBe(1);
    expect(errOut.text).toContain('互斥');
  });

  // 脱离项目使用时 frame.md 不存在，错误信息必须告诉调用方改用 --canvas，而不是只说文件读不到。
  it.skipIf(!hasFfmpeg)('validate video without project explains how to proceed', async () => {
    const dir = tempDir();
    const clip = path.join(dir, 'clip.mp4');
    makeClip(clip, 'testsrc=size=320x240:rate=30:duration=1');
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['validate', 'video', clip, '--project-root', dir], out, errOut)).toBe(1);
    expect(errOut.text).toContain('--canvas');
  });

  it.skipIf(!hasFfmpeg)('scene frames extracts and flags blank frames', async () => {
    const root = tempDir();
    const busy = makeSceneDir(root, 'scene-001', 1, 'testsrc=size=320x240:rate=30:duration=1');
    let out = new Buffer();
    let errOut = new Buffer();
    const reportPath = path.join(root, 'qc.json');
    const code = await run(['scene', 'frames', busy, '--at', '0,50%,end', '--check-blank', '--report-json', reportPath], out, errOut);
    expect(code, errOut.text).toBe(0);
    expect(fs.readdirSync(path.join(busy, 'visual-qc')).length).toBe(3);
    expect(fs.existsSync(reportPath)).toBe(true);

    const blank = makeSceneDir(root, 'scene-002', 1, 'color=c=black:size=320x240:rate=30:duration=1');
    out = new Buffer();
    errOut = new Buffer();
    expect(await run(['scene', 'frames', blank, '--at', '0', '--check-blank'], out, errOut)).toBe(1);
    expect(errOut.text).toContain('空白帧');

    // 不带 --check-blank 时只记录不改变退出码。
    out = new Buffer();
    errOut = new Buffer();
    expect(await run(['scene', 'frames', blank, '--at', '0'], out, errOut)).toBe(0);
  });

  it.skipIf(!hasFfmpeg)('concat builds master and refuses mismatched scenes', async () => {
    const root = tempDir();
    const scenes = path.join(root, 'scenes');
    makeSceneDir(scenes, 'scene-001', 1, 'testsrc=size=320x240:rate=30:duration=1');
    makeSceneDir(scenes, 'scene-002', 1, 'testsrc=size=320x240:rate=30:duration=1');
    const master = path.join(root, 'production', 'silent-master.mp4');

    let out = new Buffer();
    let errOut = new Buffer();
    const code = await run(['concat', scenes, '--out', master, '--canvas', '320x240', '--fps', '30', '--dry-run'], out, errOut);
    expect(code, errOut.text).toBe(0);
    expect(fs.existsSync(master), 'dry-run 不该写出任何文件').toBe(false);

    out = new Buffer();
    errOut = new Buffer();
    expect(await run(['concat', scenes, '--out', master, '--canvas', '320x240', '--fps', '30'], out, errOut), errOut.text).toBe(0);
    expect(fs.existsSync(master)).toBe(true);

    // 画幅不一致的镜头必须阻断，且要求重渲染而不是缩放。
    makeSceneDir(scenes, 'scene-003', 1, 'testsrc=size=160x120:rate=30:duration=1');
    out = new Buffer();
    errOut = new Buffer();
    expect(await run(['concat', scenes, '--out', master, '--canvas', '320x240', '--fps', '30'], out, errOut)).toBe(1);
    expect(errOut.text).toContain('重渲染');
  });

  it('concat requires output path', async () => {
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['concat', tempDir()], out, errOut)).toBe(1);
    expect(errOut.text).toContain('--out');
  });
});
