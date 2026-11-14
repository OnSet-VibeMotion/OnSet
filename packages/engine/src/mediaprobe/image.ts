// 静态图片的裁切（风格来源从一张图鉴里切出每种风格的海报）。ffmpeg 调用只在 mediaprobe 里拼。
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchain } from './toolchain';

/** 以像素为单位的矩形，左上角为原点。 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 从 source 里裁出 rects 的每一块，按顺序写成 dests（JPEG）。先写临时文件再改名，中途失败不留半张图。
 * 矩形超出原图时 ffmpeg 报错，原样抛出。
 */
export async function cropImages(t: Toolchain, source: string, rects: CropRect[], dests: string[], signal?: AbortSignal): Promise<void> {
  if (rects.length !== dests.length) throw new Error('cropImages: 矩形与输出文件数目不一致');
  const ffmpeg = t.ffmpegPath();
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    const dest = dests[i]!;
    for (const v of [r.x, r.y, r.w, r.h]) {
      if (!Number.isSafeInteger(v) || v < 0) throw new Error(`cropImages: 矩形必须是非负整数：${JSON.stringify(r)}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.onset-tmp.jpg';
    try {
      const ran = await t.runAsync(ffmpeg, ['-v', 'error', '-y', '-i', source, '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y}`, '-frames:v', '1', '-q:v', '3', tmp], {
        signal,
        captureStderr: true,
      });
      if (ran.error) throw new Error(`裁切 ${source} 失败：${ran.error}：${ran.stderr.toString('utf8').trim()}`);
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}
