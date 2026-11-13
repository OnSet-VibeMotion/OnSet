import { Buffer, hasFfmpeg, makeFilm, makeSceneDir, run, tempDir } from './testutil';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStrip } from './media';

describe('review', () => {
  it.skipIf(!hasFfmpeg)('review writes sheets and report', async () => {
    const root = tempDir();
    const scenes = path.join(root, 'scenes');
    makeSceneDir(scenes, 'scene-001', 1, 'testsrc=size=320x240:rate=30:duration=1');
    makeSceneDir(scenes, 'scene-002', 1, 'testsrc=size=320x240:rate=30:duration=1');
    const film = path.join(root, 'final.mp4');
    makeFilm(film, '2', '2');
    const outDir = path.join(root, 'production', 'review');
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['review', film, '--scenes', scenes, '--fps', '30', '--out', outDir, '--thumb-width', '64'], out, errOut), errOut.text).toBe(0);
    const body = fs.readFileSync(path.join(outDir, 'review.json'), 'utf8');
    const report = JSON.parse(body) as { ok: boolean; expected_frames: number; sheets: { image: string; tiles: unknown[] }[] };
    expect(report.ok && report.expected_frames === 60 && report.sheets.length === 1 && report.sheets[0].tiles.length === 6, body).toBe(true);
    expect(fs.existsSync(report.sheets[0].image)).toBe(true);
  });

  // 镜头目录多出一镜，成片帧数对不上。
  it.skipIf(!hasFfmpeg)('review fails on frame mismatch', async () => {
    const root = tempDir();
    const scenes = path.join(root, 'scenes');
    for (const id of ['scene-001', 'scene-002', 'scene-003']) makeSceneDir(scenes, id, 1, 'testsrc=size=320x240:rate=30:duration=1');
    const film = path.join(root, 'final.mp4');
    makeFilm(film, '2', '2');
    const out = new Buffer();
    const errOut = new Buffer();
    const code = await run(['review', film, '--scenes', scenes, '--fps', '30', '--out', path.join(root, 'review')], out, errOut);
    expect(code, errOut.text).toBe(1);
    expect(errOut.text).toContain('镜头帧数之和 90');
  });

  it('review requires out and fps', async () => {
    const out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['review', 'x.mp4', '--fps', '30'], out, errOut)).toBe(1);
    expect(errOut.text).toContain('out 指定');
    errOut = new Buffer();
    expect(await run(['review', 'x.mp4', '--out', tempDir(), '--project-root', tempDir()], out, errOut)).toBe(1);
    expect(errOut.text).toContain('显式传 fps');
  });

  it('scene lint', async () => {
    const dir = tempDir();
    const index = path.join(dir, 'index.html');
    fs.writeFileSync(index, '<script>\nconst x = Math.random();\n</script>');
    const report = path.join(dir, 'lint.json');
    let out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['scene', 'lint', dir, '--report-json', report], out, errOut)).toBe(1);
    expect(errOut.text).toContain('index.html:2 [random]');
    expect(fs.existsSync(report)).toBe(true);
    fs.writeFileSync(
      index,
      '<script>const x = rng(); // am-allow-nondeterministic: demo\nrequestAnimationFrame(f); // am-allow-nondeterministic: 预览\n</script>',
    );
    out = new Buffer();
    errOut = new Buffer();
    expect(await run(['scene', 'lint', dir], out, errOut), out.text + errOut.text).toBe(0);
    expect(out.text).toContain('已豁免');
  });

  it.skipIf(!hasFfmpeg)('scene frames strip and crop', async () => {
    const dir = makeSceneDir(tempDir(), 'scene-001', 2, 'testsrc=size=1080x1440:rate=30:duration=2');
    let out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['scene', 'frames', dir, '--strip', '0.5:0.8', '--cols', '5', '--thumb-width', '64'], out, errOut), errOut.text).toBe(0);
    // 0.5 到 0.8 秒应为第 15–24 帧共 10 帧。
    expect(out.text).toContain('（10 帧，5 列');
    expect(fs.existsSync(path.join(dir, 'visual-qc', 'strip-0_5-0_8.png'))).toBe(true);
    out = new Buffer();
    expect(await run(['scene', 'frames', dir, '--at', '0', '--crop', '0,0,200,100'], out, errOut), errOut.text).toBe(0);
    for (const args of [
      ['--strip', '0:2', '--at', '0'], // 互斥
      ['--strip', '0:end'], // 2 秒片子的 0:end 是 60 帧，在上限内，合法
      ['--crop', '1000,0,200,100'], // 超出画面
      ['--crop', '1,2,3'], // 格式错误
      ['--strip', '1.5:0.5'], // 倒序
    ]) {
      errOut = new Buffer();
      const code = await run(['scene', 'frames', dir, ...args], out, errOut);
      if (args[1] === '0:end') {
        expect(code, errOut.text).toBe(0);
        continue;
      }
      expect(code, args.join(' ')).toBe(1);
    }
  });

  it('parseStrip caps length', () => {
    expect(() => parseStrip('0:5', 10, 30)).toThrow('上限 90');
  });

  // 项目里有 frame.md 时按它的 audio 目标比对；正弦测试音约 -21 LUFS，
  // 偏离 -16±1 只进提示，退出码仍为 0，实测值写进报告。
  it.skipIf(!hasFfmpeg)('review reports loudness against frame targets', async () => {
    const root = tempDir();
    const frame =
      '---\nstyle_id: x\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\naudio:\n  final_integrated_lufs: -16\n  final_lufs_tolerance: 1\n  true_peak_max_dbtp: -1\n---\n';
    fs.writeFileSync(path.join(root, 'frame.md'), frame);
    const film = path.join(root, 'final.mp4');
    makeFilm(film, '2', '2');
    const outDir = path.join(root, 'review');
    const out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['review', film, '--project-root', root, '--out', outDir, '--thumb-width', '64'], out, errOut), errOut.text).toBe(0);
    expect(out.text).toContain('积分响度');
    expect(fs.readFileSync(path.join(outDir, 'review.json'), 'utf8')).toContain('"integrated_lufs"');

    // frame.md 读不出目标时报错，不静默跳过。
    fs.writeFileSync(path.join(root, 'frame.md'), '---\nstyle_id: x\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
    errOut = new Buffer();
    expect(await run(['review', film, '--project-root', root, '--out', outDir], out, errOut)).toBe(1);
    expect(errOut.text).toContain('响度目标');
  });
});
