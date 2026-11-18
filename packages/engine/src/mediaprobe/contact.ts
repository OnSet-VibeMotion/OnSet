import fs from 'node:fs';
import path from 'node:path';
import { formatFixed } from './gofmt';
import { formatSeconds, joinFilters, regionFilter, type Region } from './mediaprobe';
import { combined, commandError, firstLine, run } from './run';
import type { Toolchain } from './toolchain';

/**
 * contactSheetPadding 与 contactSheetBackground 让缩略图之间留出可辨认的分隔，
 * 否则深色风格的相邻两帧会连成一片，看不出镜头交界。
 */
export const contactSheetPadding = 8;
const contactSheetBackground = '0x303030';

/**
 * 把 atSeconds 处的帧缩成 thumbWidth 宽的缩略图，按 columns 列拼成一张 PNG 写到 dest；
 * region 非空时每格先裁出该区域再缩放，用于逐帧看同一处细节（文字、接触点、转场边缘）。
 * 缩略图按传入顺序从左到右、从上到下排列。
 *
 * 不在图上叠时间戳文字：drawtext 依赖 ffmpeg 编译时带 freetype，发行版之间
 * 不一致，缺了就整条命令失败。格子与时间点的对应关系由调用方写进报告。
 */
export function contactSheetRegion(
  t: Toolchain,
  file: string,
  atSeconds: number[],
  region: Region | null,
  columns: number,
  thumbWidth: number,
  dest: string,
): void {
  if (atSeconds.length === 0) throw new Error('联系表至少需要一个时间点');
  if (columns < 1 || thumbWidth < 16) {
    throw new Error(`联系表列数必须 ≥ 1、缩略图宽度必须 ≥ 16，收到 ${columns} 列、${thumbWidth} 像素`);
  }
  const ffmpeg = t.ffmpegPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const workDir = fs.mkdtempSync(path.join(path.dirname(dest), '.contact-'));
  try {
    atSeconds.forEach((at, i) => {
      const thumb = path.join(workDir, `thumb-${String(i + 1).padStart(4, '0')}.png`);
      // 宽度固定、高度按比例且取偶数，同一张联系表里的格子尺寸一致。
      // -ss 放在 -i 前面：转码时 ffmpeg 默认精确定位（accurate_seek），取到的帧
      // 与放在后面逐字节相同，但不必每格都从片头解码，长片的联系表快一个量级。
      const ran = run(
        ffmpeg,
        ['-v', 'error', '-y', '-ss', formatSeconds(at), '-i', file, '-frames:v', '1', '-vf', joinFilters(regionFilter(region), `scale=${thumbWidth}:-2`), '-f', 'image2', '-c:v', 'png', thumb],
        t.env,
      );
      if (ran.error) throw new Error(`联系表抽帧失败：${file} @ ${formatFixed(at, 3)} 秒（${firstLine(combined(ran))}）`);
      if (!nonEmpty(thumb)) throw new Error(`联系表抽帧没有产出内容：${file} @ ${formatFixed(at, 3)} 秒（时间点可能超出视频时长）`);
    });
    const rows = Math.floor((atSeconds.length + columns - 1) / columns);
    const ran = run(
      ffmpeg,
      [
        '-v', 'error', '-y', '-framerate', '1', '-start_number', '1',
        '-i', path.join(workDir, 'thumb-%04d.png'),
        '-vf', `tile=${columns}x${rows}:padding=${contactSheetPadding}:margin=${contactSheetPadding}:color=${contactSheetBackground}`,
        '-frames:v', '1', '-f', 'image2', '-c:v', 'png', dest,
      ],
      t.env,
    );
    if (ran.error) throw new Error(`拼接联系表失败：${dest}（${firstLine(combined(ran))}）`);
    if (!nonEmpty(dest)) throw new Error(`联系表没有产出内容：${dest}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function nonEmpty(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/** Snapshot 的原始 PNG 已经在磁盘上；上游无法拼表时，用相同的网格接着拼。 */
export async function contactSheetImages(t: Toolchain, files: readonly string[], dest: string, signal?: AbortSignal): Promise<void> {
  const columns = Math.min(files.length, 3);
  if (columns === 0) throw new Error('联系表至少需要一张截图');
  const rows = Math.ceil(files.length / columns);
  const work = fs.mkdtempSync(path.join(path.dirname(dest), '.contact-'));
  try {
    files.forEach((file, i) => fs.copyFileSync(file, path.join(work, `frame-${i}.png`)));
    const ran = await t.runAsync(t.ffmpegPath(), [
      '-v', 'error', '-y', '-framerate', '1', '-start_number', '0', '-i', path.join(work, 'frame-%d.png'),
      '-vf', `scale=320:-2,tile=${columns}x${rows}:padding=${contactSheetPadding}:margin=${contactSheetPadding}:color=${contactSheetBackground}`,
      '-frames:v', '1', '-f', 'image2', '-c:v', 'png', dest,
    ], { signal, captureStderr: true });
    if (ran.error) throw new Error(`拼接截图联系表失败：${commandError(ran)}`);
    if (!nonEmpty(dest)) throw new Error(`截图联系表没有产出内容：${dest}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
