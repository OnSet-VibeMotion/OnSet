import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envMap, lookPath } from '../envutil';
import { newToolchain, type Toolchain } from '../mediaprobe';
import { DefaultCodec, DefaultPixelFormat, analyze, newRunner, type Input, type Target } from './concat';

function which(name: string): string | null {
  try {
    return lookPath(name, process.env.PATH ?? '');
  } catch {
    return null;
  }
}

const ffmpegBinary = which('ffmpeg');
/** 本机没有 ffmpeg / ffprobe 时与 Go 版一样跳过。 */
const missing = ffmpegBinary === null || which('ffprobe') === null;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onset-concat-'));
const toolchain = (): Toolchain => newToolchain(envMap());
const target = (): Target => ({ widthPx: 320, heightPx: 240, fps: 30, codec: DefaultCodec, pixelFormat: DefaultPixelFormat });

function ffmpeg(args: string[]): void {
  const result = spawnSync(ffmpegBinary!, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`生成素材失败：${result.stdout}${result.stderr}`);
}

/** clip 生成一段测试素材。extra 用于制造与目标规格的差异。 */
function clip(dir: string, name: string, filter: string, ...extra: string[]): string {
  const file = path.join(dir, name);
  const argv = ['-v', 'error', '-y', '-f', 'lavfi', '-i', filter, ...extra];
  if (extra.length === 0) argv.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  ffmpeg([...argv, file]);
  return file;
}

describe.skipIf(missing)('concat', () => {
  it('analyze accepts uniform clips', () => {
    const dir = tempDir();
    const inputs: Input[] = [
      { id: 'scene-001', path: clip(dir, 'a.mp4', 'testsrc=size=320x240:rate=30:duration=1') },
      { id: 'scene-002', path: clip(dir, 'b.mp4', 'testsrc=size=320x240:rate=30:duration=2') },
    ];
    const plan = analyze(toolchain(), inputs, target());
    expect(plan.blocking, '规格一致却报了阻断问题').toEqual([]);
    expect(plan.normalize, '规格一致不该需要规范化').toEqual([]);
    expect(Math.abs(plan.totalSeconds - 3)).toBeLessThanOrEqual(0.1);
  });

  // 这个包最重要的一条约束：PROMPT 明令「规范化不得承担语义重定时，禁止通过 setpts 或改变帧率让镜头
  // 追赶配音」。分辨率和帧率不符必须回去重渲染，而不是在这里悄悄缩放或改帧率——
  // 提示词里的禁令可以被忽略，不存在的能力不能。
  it('analyze refuses to rescale or retime', () => {
    const dir = tempDir();
    let plan = analyze(toolchain(), [{ id: 'scene-001', path: clip(dir, 'small.mp4', 'testsrc=size=160x120:rate=30:duration=1') }], target());
    expect(plan.normalize.length, '分辨率不符绝不能靠规范化解决').toBe(0);
    expect(plan.blocking.length === 1 && plan.blocking[0].includes('重渲染'), String(plan.blocking)).toBe(true);

    plan = analyze(toolchain(), [{ id: 'scene-002', path: clip(dir, 'slow.mp4', 'testsrc=size=320x240:rate=15:duration=1') }], target());
    expect(plan.normalize.length, '帧率不符绝不能靠规范化解决').toBe(0);
    expect(plan.blocking.length === 1 && plan.blocking[0].includes('时间轴'), String(plan.blocking)).toBe(true);
  });

  it('analyze rejects clips with audio', () => {
    const file = path.join(tempDir(), 'noisy.mp4');
    ffmpeg([
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
    ]);
    const plan = analyze(toolchain(), [{ id: 'scene-001', path: file }], target());
    expect(plan.blocking.length === 1 && plan.blocking[0].includes('音轨'), String(plan.blocking)).toBe(true);
  });

  it('analyze flags pixel format for normalization', () => {
    // yuv444p：编码和画幅都对，只有像素格式不同——这才是规范化该处理的情况。
    const file = clip(tempDir(), '444.mp4', 'testsrc=size=320x240:rate=30:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv444p');
    const plan = analyze(toolchain(), [{ id: 'scene-001', path: file }], target());
    expect(plan.blocking, '像素格式差异不该阻断').toEqual([]);
    expect(plan.normalize.length, '像素格式差异应当走规范化').toBe(1);
  });

  it('normalize preserves timeline and drops audio', async () => {
    const tc = toolchain();
    const runner = newRunner(envMap(), tc);
    const dir = tempDir();
    const source = clip(dir, '444.mp4', 'testsrc=size=320x240:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv444p');
    const before = tc.countFrames(source);
    const dest = path.join(dir, 'normalized', 'out.mp4');
    await runner.normalize(source, dest, target());
    // 帧数一帧不多一帧不少：规范化只统一格式，不碰时间轴。
    expect(tc.countFrames(dest)).toBe(before);
    const media = tc.probe(dest);
    expect(media.video!.pixel_format).toBe('yuv420p');
    expect(media.audio, '规范化产物不该有音轨').toBeNull();
    expect(fs.existsSync(source), '原始文件必须保留').toBe(true);
  });

  it('concat produces a continuous master', async () => {
    const tc = toolchain();
    const runner = newRunner(envMap(), tc);
    const dir = tempDir();
    const a = clip(dir, 'a.mp4', 'testsrc=size=320x240:rate=30:duration=1');
    const b = clip(dir, 'b.mp4', 'testsrc=size=320x240:rate=30:duration=2');
    const dest = path.join(dir, 'production', 'silent-master.mp4');
    await runner.concat([a, b], dest);
    expect(tc.countFrames(dest), '母版帧数应为 90（30 + 60）').toBe(90);
    expect(tc.probe(dest).audio, '静音母版不该有音轨').toBeNull();
    // 清单文件是中间产物，不能留在交付目录里。清单文件名是随机的，用前缀匹配。
    const leftovers = fs.readdirSync(path.join(dir, 'production')).filter((n) => n.startsWith('.onset-concat-list-') && n.endsWith('.txt'));
    expect(leftovers, '拼接清单没有清理').toEqual([]);
  });

  // 守住临时清单文件名的并发安全：固定文件名在同一目录下并发跑两个 concat 会互相覆盖对方
  // 还没读完的清单，产出错误的拼接结果（缺一段、内容错乱）或直接失败。
  it('concurrent concat runs do not clobber each other', async () => {
    const tc = toolchain();
    const runner = newRunner(envMap(), tc);
    const dir = tempDir();
    const a = clip(dir, 'a.mp4', 'testsrc=size=320x240:rate=30:duration=1');
    const b = clip(dir, 'b.mp4', 'testsrc=size=320x240:rate=30:duration=2');
    const destA = path.join(dir, 'out-a.mp4');
    const destB = path.join(dir, 'out-b.mp4');
    // out-a 只拼 a（30 帧）；out-b 拼 a+b（90 帧），两次同时往 dir 下写清单。
    await Promise.all([runner.concat([a], destA), runner.concat([a, b], destB)]);
    expect(tc.countFrames(destA), '清单被另一次 concat 覆盖会产出错误的帧数').toBe(30);
    expect(tc.countFrames(destB), '清单被另一次 concat 覆盖会产出错误的帧数').toBe(90);
  });

  it('concat handles paths with quotes', async () => {
    const tc = toolchain();
    const runner = newRunner(envMap(), tc);
    // concat demuxer 的清单里单引号必须转义，否则路径会被截断。
    const dir = path.join(tempDir(), "it's a dir");
    fs.mkdirSync(dir, { recursive: true });
    const a = clip(dir, 'a.mp4', 'testsrc=size=320x240:rate=30:duration=1');
    const dest = path.join(tempDir(), 'out.mp4');
    await runner.concat([a], dest);
    tc.probe(dest);
  });

  it('concat rejects empty input', async () => {
    const runner = newRunner(envMap(), toolchain());
    await expect(runner.concat(null, path.join(tempDir(), 'x.mp4'))).rejects.toThrow();
  });

  it('analyze reports empty input', () => {
    expect(analyze(toolchain(), null, target()).blocking.length).toBe(1);
  });

  // mediaprobe.probe 放行纯音频文件后，video 可能为 null。混进拼接输入的纯音频文件
  // 说明上游镜头渲染出了错，这里要落成一条 blocking 记录。
  it('analyze reports audio-only clip as blocking', () => {
    const file = path.join(tempDir(), 'audio-only.wav');
    ffmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file]);
    const plan = analyze(toolchain(), [{ id: 'scene-001', path: file }], target());
    expect(plan.blocking.length === 1 && plan.blocking[0].includes('scene-001') && plan.blocking[0].includes('没有视频流'), String(plan.blocking)).toBe(true);
  });
});
