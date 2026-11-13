// 本包测试共用的辅助（对应 audio_test.go 的 newTestRunner 与 tone）。不从 index.ts 导出。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { envMap, lookPath } from '../envutil';
import { newToolchain, type Toolchain } from '../mediaprobe';
import { newRunner, trimSeconds, type Runner } from './audio';

function has(name: string): boolean {
  try {
    lookPath(name, process.env.PATH ?? '');
    return true;
  } catch {
    return false;
  }
}

/** 缺 ffmpeg 或 ffprobe 时 Go 版 t.Skip；这里给 it.skipIf 用。 */
export const hasMediaTools = has('ffmpeg') && has('ffprobe');

export function newTestRunner(): { runner: Runner; toolchain: Toolchain } {
  const env = envMap();
  const toolchain = newToolchain(env);
  return { runner: newRunner(env, toolchain), toolchain };
}

/** tone 生成一段指定秒数的测试音频，格式故意与目标格式不同，用来验证 normalize 真的在统一格式。 */
export function tone(dir: string, name: string, seconds: number): string {
  const file = path.join(dir, name);
  const ran = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + trimSeconds(seconds), '-ar', '22050', '-ac', '2', file]);
  if (ran.status !== 0) throw new Error(`生成测试音频失败：${ran.stderr?.toString('utf8')}`);
  return file;
}
