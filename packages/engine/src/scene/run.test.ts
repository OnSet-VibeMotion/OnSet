import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newConfig } from '../config';
import { liveFile } from './live';
import { run, verifyOutput } from './run';
import { load, outputPath, stderrLog, streamLog, userLog } from './scene';
import { executable, fakeFfprobe, Sink, tempDir, writeScene } from './testsupport';
import { VerificationError } from './verification';

const plainScene = '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}';
const cfg = newConfig({ orchestrator: 'claude', renderer: 'codex', ttsProvider: 'minimax' });

function catchError(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe('run', () => {
  it('writes logs and verifies the duration', async () => {
    const s = load(writeScene(plainScene));
    const bin = tempDir();
    executable(
      bin,
      'codex',
      `
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"[[USER_MESSAGE]]代码已完成，开始渲染"}}'
printf video > out.mp4
test -f render-scene-001.live.json && printf seen > live-seen
`,
    );
    fakeFfprobe(bin, {});
    const user = new Sink();
    await run(s, cfg, false, { PATH: bin, HOME: tempDir() }, user, 0.15);
    expect(user.text).toContain('代码已完成');
    for (const file of [streamLog(s), stderrLog(s), userLog(s)]) expect(fs.existsSync(file), `missing log ${file}`).toBe(true);
    // 渲染器跑的时候有进行中标记（客户端据此显示渲染中），结束就删。
    expect(fs.existsSync(path.join(s.directory, 'live-seen')), '渲染器运行时应能看到进行中标记').toBe(true);
    expect(fs.existsSync(liveFile(s.directory, s.id)), '渲染结束后标记应已删除').toBe(false);
  });

  it('cancellation terminates the process group', async () => {
    const s = load(writeScene(plainScene));
    const bin = tempDir();
    executable(bin, 'codex', '/bin/sleep 300');
    const started = Date.now();
    const signal = AbortSignal.timeout(150);
    await expect(run(s, cfg, false, { PATH: bin, HOME: tempDir() }, new Sink(), 0.15, signal)).rejects.toThrow('中断');
    expect(Date.now() - started, 'cancellation took too long').toBeLessThan(5000);
    expect(fs.existsSync(liveFile(s.directory, s.id)), '取消后标记应已删除').toBe(false);
  });

  it('reports a renderer failure', async () => {
    const s = load(writeScene(plainScene));
    const bin = tempDir();
    executable(bin, 'codex', 'echo boom >&2; exit 3');
    await expect(run(s, cfg, false, { PATH: bin, HOME: tempDir() }, new Sink(), 0.15)).rejects.toThrow('退出码 3');
  });
});

describe('verifyOutput', () => {
  it('rejects invalid artifacts', () => {
    const s = load(writeScene(plainScene));
    const bin = tempDir();
    fakeFfprobe(bin, { duration: '2.000' });
    const env = { PATH: bin, HOME: tempDir() };
    expect(() => verifyOutput(s, env, 0.15), 'missing output should fail').toThrow();
    fs.writeFileSync(outputPath(s), '');
    expect(() => verifyOutput(s, env, 0.15), 'empty output should fail').toThrow();
    fs.writeFileSync(outputPath(s), 'video');
    expect(() => verifyOutput(s, env, 0.15)).toThrow('时长不符');
    expect(() => verifyOutput(s, env, -1), 'negative tolerance should fail').toThrow();
  });

  // 差 3 帧（0.1 秒）落在默认 0.15 秒的时长容差内，只看时长会放行。
  it('rejects a frame count within the duration tolerance', () => {
    const s = load(writeScene(plainScene));
    fs.writeFileSync(outputPath(s), 'video');
    const bin = tempDir();
    fakeFfprobe(bin, { duration: '1.000', frames: 33 });
    const err = catchError(() => verifyOutput(s, { PATH: bin, HOME: tempDir() }, 0.15)) as Error;
    expect(err).toBeInstanceOf(VerificationError);
    expect(err.message).toContain('期望 30 帧');
    expect(err.message).toContain('实测 33 帧');
  });

  // 画幅、帧率、静音三项：渲染成别的规格的产物一律退出码 0，错误要到拼接甚至成片才暴露。
  it('checks the canvas, frame rate and silence', () => {
    const cases: Array<[name: string, reply: Parameters<typeof fakeFfprobe>[1], want: string]> = [
      ['画幅不符', { widthPx: 720, heightPx: 1280 }, '分辨率不符'],
      ['帧率不符', { fpsNum: 25 }, '帧率不符'],
      ['混进了音轨', { audio: true }, '应当没有音轨'],
    ];
    for (const [name, reply, want] of cases) {
      const s = load(writeScene(plainScene));
      const bin = tempDir();
      fakeFfprobe(bin, reply);
      fs.writeFileSync(outputPath(s), 'video');
      expect(() => verifyOutput(s, { PATH: bin, HOME: tempDir() }, 0.15), name).toThrow(want);
    }
  });

  // 调度层靠这个类型判定「不要重试」。
  it('failures are VerificationErrors', () => {
    const s = load(writeScene(plainScene));
    const bin = tempDir();
    fakeFfprobe(bin, { widthPx: 720, heightPx: 1280, fpsNum: 25, duration: '9.000' });
    fs.writeFileSync(outputPath(s), 'video');
    const err = catchError(() => verifyOutput(s, { PATH: bin, HOME: tempDir() }, 0.15));
    expect(err).toBeInstanceOf(VerificationError);
    // 分辨率、帧率、时长、逐帧计数同时不符时要一次全报出来。
    expect((err as VerificationError).problems).toHaveLength(4);
    expect((err as Error).message, '错误信息没有点名产物').toContain('out.mp4');
  });

  // 画幅取自 style_guide 而不是写死的默认值。
  it('honors the style guide canvas', () => {
    const dir = writeScene('{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello","style_guide":"frame.md"}');
    fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas:\n  width_px: 1080\n  height_px: 1920\n  fps: 30\n---\n正文\n');
    const s = load(dir);
    fs.writeFileSync(outputPath(s), 'video');
    const bin = tempDir();
    // 按默认画幅（1440 高）渲染，但 style_guide 要的是 1920。
    fakeFfprobe(bin, { widthPx: 1080, heightPx: 1440 });
    expect(() => verifyOutput(s, { PATH: bin, HOME: tempDir() }, 0.15)).toThrow('1080x1920');
    const bin2 = tempDir();
    fakeFfprobe(bin2, { widthPx: 1080, heightPx: 1920 });
    expect(() => verifyOutput(s, { PATH: bin2, HOME: tempDir() }, 0.15)).not.toThrow();
  });

  // 规格全对、源码读了时钟的产物只有源码扫描拦得住，同样走 VerificationError。
  it('rejects nondeterministic source', () => {
    const dir = writeScene(plainScene);
    const s = load(dir);
    const bin = tempDir();
    fakeFfprobe(bin, {});
    fs.writeFileSync(outputPath(s), 'video');
    const env = { PATH: bin, HOME: tempDir() };
    fs.writeFileSync(path.join(dir, 'index.html'), '<script>\nconst seed = Date.now();\n</script>');
    const err = catchError(() => verifyOutput(s, env, 0.15)) as Error;
    expect(err).toBeInstanceOf(VerificationError);
    expect(err.message).toContain('index.html:2 [clock]');
    fs.writeFileSync(path.join(dir, 'index.html'), '<script>const tl = gsap.timeline({ paused: true });</script>');
    expect(() => verifyOutput(s, env, 0.15), '干净源码不应被拦').not.toThrow();
  });
});
