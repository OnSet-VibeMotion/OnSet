// 移植自 internal/dialogue/audio_test.go。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasMediaTools, newTestRunner, tone } from './testsupport';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-dialogue-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasMediaTools)('runner', () => {
  it('silence has exact duration', async () => {
    const { runner, toolchain } = newTestRunner();
    const dest = path.join(tempDir(), 'gap.wav');
    await runner.silence(dest, 250);
    const media = toolchain.probe(dest);
    expect(Math.abs(media.duration_seconds - 0.25)).toBeLessThanOrEqual(0.002);
    expect(media.audio?.sample_rate).toBe(48000);
    expect(media.audio?.channels).toBe(1);
  });

  it('normalize unifies format', async () => {
    const { runner, toolchain } = newTestRunner();
    const dir = tempDir();
    const source = tone(dir, 'src.wav', 1.0);
    const dest = path.join(dir, 'norm.wav');
    await runner.normalize(source, dest);
    const media = toolchain.probe(dest);
    expect(media.audio?.sample_rate).toBe(48000);
    expect(media.audio?.channels).toBe(1);
  });

  it('concat duration is sum of parts', async () => {
    const { runner, toolchain } = newTestRunner();
    const dir = tempDir();
    const parts: string[] = [];
    for (const [i, seconds] of [1.0, 0.5].entries()) {
      const letter = String.fromCharCode(97 + i);
      const source = tone(dir, `src${letter}.wav`, seconds);
      const dest = path.join(dir, `norm${letter}.wav`);
      await runner.normalize(source, dest);
      parts.push(dest);
    }
    const gap = path.join(dir, 'gap.wav');
    await runner.silence(gap, 200);
    const out = path.join(dir, 'voice.wav');
    await runner.concat([parts[0], gap, parts[1]], out);
    expect(Math.abs(toolchain.probe(out).duration_seconds - 1.7)).toBeLessThanOrEqual(0.005);
  });

  // concat 假定输入已经统一格式，自己不转码；格式不一致时 concat demuxer 不会
  // 报错，只会静默拼出错误的时长。这里故意跳过 normalize，直接把两段规格不符
  // 目标格式的源文件交给 concat，断言拿到的是错误并且能定位到具体文件。
  it('concat rejects mismatched format', async () => {
    const { runner } = newTestRunner();
    const dir = tempDir();
    const a = tone(dir, 'a.wav', 1.0);
    const b = tone(dir, 'b.wav', 1.0);
    await expect(runner.concat([a, b], path.join(dir, 'voice.wav'))).rejects.toThrow(a);
  });
});
