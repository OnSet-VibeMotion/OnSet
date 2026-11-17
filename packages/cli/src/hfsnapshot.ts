/**
 * hyperframes snapshot 的单帧截图缩小：给渲染器看图省 token。
 *
 * snapshot 写出的单帧是画布原尺寸的 PNG（1920×1080 在 Claude 新模型上每张约 2,700 token，按 28×28 像素一块计），
 * 渲染器自检时一个镜头要看 8–74 张，看过的图还一直留在上下文里被后面每一步重读（2026-11 统计 101 个镜头，
 * 读图占渲染器上下文增长的五分之一）。自检看的是构图、有没有画面、字幕在不在，960 宽足够，每张约 700 token；
 * 要看小字与对齐，HyperFrames 有 --zoom（按局部高密度截图），那种不缩。联系表本来就是给看图用的网格，也不缩。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 截图之后给渲染器的一句提醒。2026-11 统计 101 个镜头：渲染器用 ffmpeg 自己裁剪、放大截图与解码成片复查共 475 次，
 * 占它读入的 11%，做的是 --zoom 与 onset 渲染后校验已经在做的事。只写在工具输出里，不改渲染提示词
 * （提示词在镜头指纹里，一改所有已渲染的镜头都变 Stale）。
 */
export const SnapshotAdvice = '先看联系表，有疑问再看单帧；看小字与细节用 snapshot 的 --zoom 截局部，不要自己用 ffmpeg 裁剪、放大截图';

/** render 成功后的提醒：规格、帧数、音轨与确定性 onset 在渲染结束后自己核对，渲染器不必解码成片复查。 */
export const RenderAdvice =
  'onset 会在你结束后自己核对产物：画幅、帧率、时长、逐帧解码的总帧数、没有音轨、确定性扫描与共享资源，不合格这一镜判为失败。' +
  '不必再用 ffprobe / ffmpeg 解码成片复查这些；画面对不对用 snapshot 看。';

/** 单帧截图缩到的最大宽度。 */
export const SnapshotMaxWidth = 960;

/** 单帧截图的文件名：缺省 frame-00-at-1.5s.png，--keep 时 at-1.5s.png。 */
const stillName = /^(frame-\d+[^/\\]*|at-[^/\\]*)\.png$/;

/** 输出里出现的 PNG 路径（绝对路径，POSIX 或 Windows 写法）。 */
const pngPath = /(?:[A-Za-z]:)?[\\/][^\s"'<>|]*?\.png/g;

/** 这次调用要缩小吗：只有 snapshot，且不是 --zoom（那是专门取原始像素看细节的）。 */
export function shouldShrinkSnapshot(argv: readonly string[]): boolean {
  return argv[0] === 'snapshot' && !argv.some((arg) => arg === '--zoom' || arg.startsWith('--zoom='));
}

/**
 * 从 snapshot 的输出里认出这次写出的单帧截图：文件名是单帧的、文件存在、真实路径在 dir（镜头目录）里。
 * 只动镜头目录里的文件：-o 指到别处的不碰。
 */
export function snapshotStills(output: string, dir: string): string[] {
  let root: string;
  try {
    root = fs.realpathSync(dir);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const match of output.matchAll(pngPath)) {
    const file = match[0];
    if (!stillName.test(path.basename(file))) continue;
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      continue;
    }
    const rel = path.relative(root, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    seen.add(real);
  }
  return [...seen];
}
