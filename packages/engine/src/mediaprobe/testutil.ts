// 测试共用：本机有没有 ffmpeg / ffprobe、现场生成素材。不进 index。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envMap, lookPath } from '../envutil';
import { newToolchain, type Toolchain } from './toolchain';

function which(name: string): string | null {
  try {
    return lookPath(name, process.env.PATH ?? '');
  } catch {
    return null;
  }
}

export const ffmpegBinary = which('ffmpeg');
export const hasFfmpeg = ffmpegBinary !== null && which('ffprobe') !== null;

export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onset-mediaprobe-'));

export function toolchain(): Toolchain {
  return newToolchain(envMap());
}

/** 跑一条 ffmpeg 生成素材命令，失败直接抛出（对应 Go 测试里的 t.Fatalf）。 */
export function ffmpeg(...args: string[]): void {
  const result = spawnSync(ffmpegBinary!, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`生成测试素材失败：${result.error?.message ?? result.status}\n${result.stdout}${result.stderr}`);
}

/**
 * 用 ffmpeg 现场生成测试素材。不入库 testdata：二进制 fixture 会让
 * 「测试通过」依赖某个特定 ffmpeg 版本编出的文件，现场生成才是在测真实链路。
 */
export function sample(filter: string, ...extra: string[]): string {
  const file = path.join(tempDir(), 'sample.mp4');
  ffmpeg('-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...extra, file);
  return file;
}
