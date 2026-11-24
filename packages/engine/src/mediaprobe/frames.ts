// 基于 ffmpeg 的单帧抽取、灰度统计、两帧差异与批量抽帧检查。
import fs from 'node:fs';
import path from 'node:path';
import { formatFixed } from './gofmt';
import {
  type ExtractedFrame,
  type FrameReport,
  type FrameStats,
  formatSeconds,
  isBlank,
  isDark,
  meanAbsoluteDifference,
  type Region,
  ReportSchemaVersion,
  regionFilter,
} from './mediaprobe';
import { combined, commandError, firstLine, run } from './run';

export interface FrameRunner {
  readonly env: Record<string, string>;
  ffmpegPath(): string;
}

/** 计算统计量时的缩放边长。缩放到固定尺寸让阈值与画幅无关，也让代价与视频分辨率无关。 */
const statsSampleSize = 128;

/**
 * 比对两帧时的缩放边长。取得很小是刻意的：交接时物件
 * 在交界两侧挪动几像素、描边粗细差一点都属于接上了，缩到 32 像素后这类差异
 * 几乎消失，剩下的只有「两张不同的画面」这种量级的差别。
 */
const differenceSampleSize = 32;

function nonEmpty(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function grayStats(atSeconds: number, pixels: Buffer): FrameStats {
  let sum = 0;
  for (const pixel of pixels) sum += pixel;
  const mean = sum / pixels.length;
  let variance = 0;
  for (const pixel of pixels) {
    const delta = pixel - mean;
    variance += delta * delta;
  }
  return { at_seconds: atSeconds, mean, stddev: Math.sqrt(variance / pixels.length) };
}

/** 用于文件名的时间戳，去掉尾随零。 */
function formatSecondsShort(value: number): string {
  let text = formatFixed(value, 3).replace(/0+$/, '');
  if (text.endsWith('.')) text = text.slice(0, -1);
  return text;
}

/**
 * 抽取 atSeconds 处的一帧写成 PNG，region 非空时只保留该区域的原始像素，
 * 用于在全分辨率下看小字、细线这类缩略图上看不清的细节。
 */
export function extractFrameRegion(
  runner: FrameRunner,
  file: string,
  atSeconds: number,
  region: Region | null,
  dest: string,
): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // -ss 放在 -i 前面：转码时 ffmpeg 默认精确定位（accurate_seek），取到的就是
  // 「第 N 秒那一帧」，与放在 -i 后面逐字节相同，但不必从片头解码过来。
  const ffmpeg = runner.ffmpegPath();
  const argv = ['-v', 'error', '-y', '-ss', formatSeconds(atSeconds), '-i', file, '-frames:v', '1'];
  const filter = regionFilter(region);
  if (filter !== '') argv.push('-vf', filter);
  const ran = run(ffmpeg, [...argv, '-f', 'image2', '-c:v', 'png', dest], runner.env);
  if (ran.error) {
    throw new Error(`抽帧失败：${file} @ ${formatFixed(atSeconds, 3)} 秒（${firstLine(combined(ran))}）`);
  }
  if (!nonEmpty(dest)) {
    // 时间点超出时长时 ffmpeg 会返回 0 但什么都不写。静默产出空文件
    // 比报错更危险：调用方会以为抽到了帧。
    fs.rmSync(dest, { force: true });
    throw new Error(`抽帧没有产出内容：${file} @ ${formatFixed(atSeconds, 3)} 秒（时间点可能超出视频时长）`);
  }
}

/** 抽取 atSeconds 处的一帧，缩放成 size×size 的指定像素格式后返回裸像素。 */
function rawFrame(
  env: Record<string, string>,
  ffmpeg: string,
  file: string,
  atSeconds: number,
  size: number,
  pixelFormat: string,
): Buffer {
  // 输入端定位，理由同 contactSheet：整片复查要对每个镜头交界各取两帧。
  const ran = run(
    ffmpeg,
    [
      '-v',
      'error',
      '-ss',
      formatSeconds(atSeconds),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `scale=${size}:${size},format=${pixelFormat}`,
      '-f',
      'rawvideo',
      '-',
    ],
    env,
  );
  if (ran.error) throw new Error(`读取帧像素失败：${file} @ ${formatFixed(atSeconds, 3)} 秒（${commandError(ran)}）`);
  if (ran.stdout.length === 0) throw new Error(`该时间点没有帧：${file} @ ${formatFixed(atSeconds, 3)} 秒`);
  return ran.stdout;
}

/**
 * 抽取 atSeconds 处的一帧，缩放成灰度小图后在本进程里计算均值和标准差。
 *
 * 不用 ffmpeg 的 signalstats/blackdetect：它们把结果写进 stderr 的文本日志，
 * 格式随版本变化，解析起来比自己算更脆。裸灰度像素是稳定接口。
 */
export function frameStats(runner: FrameRunner, file: string, atSeconds: number): FrameStats {
  const ffmpeg = runner.ffmpegPath();
  const output = rawFrame(runner.env, ffmpeg, file, atSeconds, statsSampleSize, 'gray');
  return grayStats(atSeconds, output);
}

/** 一次定位与解码同时写 PNG 和统计像素；统计仍取整帧，不能被裁剪区域改变。 */
function extractFrameAndStats(
  runner: FrameRunner,
  file: string,
  atSeconds: number,
  region: Region | null,
  dest: string,
  maxWidth = 0,
): FrameStats {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 沿用 extractFrameRegion / frameStats 的自动选流：多视频流文件未必以第一条为主画面。
  const argv = ['-v', 'error', '-y', '-ss', formatSeconds(atSeconds), '-i', file, '-frames:v', '1'];
  // 只缩写出去的 PNG（给看图的一方省 token）；灰度统计是另一路输出，照旧按原帧算。裁了区域就是要看原始像素，不缩。
  const filter = region === null && maxWidth > 0 ? `scale='min(${maxWidth},iw)':-2` : regionFilter(region);
  if (filter !== '') argv.push('-vf', filter);
  const ran = run(
    runner.ffmpegPath(),
    [
      ...argv,
      '-f',
      'image2',
      '-c:v',
      'png',
      dest,
      '-frames:v',
      '1',
      '-vf',
      `scale=${statsSampleSize}:${statsSampleSize},format=gray`,
      '-f',
      'rawvideo',
      '-',
    ],
    runner.env,
  );
  if (ran.error) {
    throw new Error(`抽帧失败：${file} @ ${formatFixed(atSeconds, 3)} 秒（${firstLine(ran.stderr.toString('utf8'))}）`);
  }
  if (!nonEmpty(dest) || ran.stdout.length === 0) {
    fs.rmSync(dest, { force: true });
    throw new Error(`抽帧没有产出内容：${file} @ ${formatFixed(atSeconds, 3)} 秒（时间点可能超出视频时长）`);
  }
  return grayStats(atSeconds, ran.stdout);
}

/**
 * 抽取 a、b 两个时间点的帧，缩放成 32×32 的 RGB 小图，返回逐通道
 * 绝对差的均值（0–255）。0 是完全相同，两张无关画面通常在 40 以上。
 */
export function frameDifference(runner: FrameRunner, file: string, a: number, b: number): number {
  const ffmpeg = runner.ffmpegPath();
  const first = rawFrame(runner.env, ffmpeg, file, a, differenceSampleSize, 'rgb24');
  const second = rawFrame(runner.env, ffmpeg, file, b, differenceSampleSize, 'rgb24');
  return meanAbsoluteDifference(first, second);
}

/**
 * 两个文件各取一帧比较，口径与 frameDifference 相同（32×32 RGB 逐通道绝对差的均值）。
 * 镜头交界：前一镜的末帧对后一镜的首帧，拼接前就能量出哪道交界没接上。
 */
export function frameDifferenceBetween(runner: FrameRunner, a: string, atA: number, b: string, atB: number): number {
  const ffmpeg = runner.ffmpegPath();
  return meanAbsoluteDifference(
    rawFrame(runner.env, ffmpeg, a, atA, differenceSampleSize, 'rgb24'),
    rawFrame(runner.env, ffmpeg, b, atB, differenceSampleSize, 'rgb24'),
  );
}

/**
 * 按给定时间点批量抽帧到 destDir，并统计每帧的灰度分布；PNG 只保留 region 区域，空白帧判定仍按整帧。
 * maxWidth 大于 0 且没有 region 时，PNG 缩到不超过这个宽度（等比，统计不受影响）。
 */
export function extractFramesRegion(
  runner: FrameRunner,
  file: string,
  atSeconds: number[],
  region: Region | null,
  destDir: string,
  maxWidth = 0,
): FrameReport {
  const report: FrameReport = {
    schema_version: ReportSchemaVersion,
    path: file,
    ok: false,
    frames: [],
    problems: [],
  };
  for (const at of atSeconds) {
    const image = path.join(destDir, `frame-${formatSecondsShort(at).replaceAll('.', '_')}.png`);
    const stats = extractFrameAndStats(runner, file, at, region, image, maxWidth);
    const frame: ExtractedFrame = { at_seconds: at, image, stats, blank: isBlank(stats), dark: isDark(stats) };
    report.frames.push(frame);
    if (frame.blank) {
      report.problems.push(
        `${formatFixed(at, 3)} 秒处是空白帧：灰度均值 ${formatFixed(stats.mean, 1)}、标准差 ${formatFixed(stats.stddev, 2)}（${image}）`,
      );
    } else if (frame.dark) {
      (report.hints ??= []).push(
        `${formatFixed(at, 3)} 秒处整体偏暗（灰度均值 ${formatFixed(stats.mean, 1)}），确认内容可读（${image}）`,
      );
    }
  }
  report.ok = report.problems.length === 0;
  return report;
}
