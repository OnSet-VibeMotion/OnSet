/**
 * 媒体操作共用的时间点、画幅、裁剪区域与逐帧条带解析辅助函数。
 */
import { formatFixed, goQuote, goRound, goTrimSpace } from '@onset/engine/gofmt';
import type * as mediaprobe from '@onset/engine/mediaprobe';
import * as scene from '@onset/engine/scene';

/** strconv.ParseFloat 的常用子集：十进制、科学计数法、inf / infinity / nan（不区分大小写，可带正负号）。失败返回 null。 */
function parseGoFloat(s: string): number | null {
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return null;
}

/** strconv.Atoi：可带正负号的十进制整数。失败返回 null。 */
function parseGoInt(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const value = Number(s);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * parseTimePoints 解析 --at 的时间点列表，支持秒数、百分比和 end。
 *
 * 百分比和 end 都要先知道时长，所以 duration 必须是实测值而不是 scene.json 的
 * 声明值：产物时长和声明时长不一致正是要靠抽帧去看的情况之一。
 *
 * end 取 duration - 一帧，而不是 duration：后者已经超出最后一帧，
 * ffmpeg 会返回成功但什么都不输出。
 */
export function parseTimePoints(spec: string, duration: number, fps: number): number[] {
  if (fps <= 0) fps = 30;
  let lastFrame = duration - 1.0 / fps;
  if (lastFrame < 0) lastFrame = 0;
  const points: number[] = [];
  for (const raw of spec.split(',')) {
    const item = goTrimSpace(raw);
    if (item === '') continue;
    let value: number;
    if (item.toLowerCase() === 'end') {
      value = lastFrame;
    } else if (item.endsWith('%')) {
      const percent = parseGoFloat(item.slice(0, -1));
      // 与 Go 一致：NaN 不小于 0 也不大于 100，会被放行。
      if (percent === null || percent < 0 || percent > 100) {
        throw new Error(`at 的百分比必须是 0..100，实际收到 ${goQuote(item)}`);
      }
      value = (duration * percent) / 100;
      if (value > lastFrame) value = lastFrame;
    } else {
      const parsed = parseGoFloat(item);
      if (parsed === null || !Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`at 的时间点必须是非负秒数、百分比或 end，实际收到 ${goQuote(item)}`);
      }
      if (parsed > lastFrame) throw new Error(`at 的时间点 ${item} 秒超出视频时长 ${formatFixed(duration, 3)} 秒`);
      value = parsed;
    }
    points.push(value);
  }
  if (points.length === 0) throw new Error('at 至少要给一个时间点');
  return points;
}

/** parseCanvas 解析 "1080x1440" 形式的画幅覆盖值。 */
export function parseCanvas(value: string): [number, number] {
  const lowered = goTrimSpace(value).toLowerCase();
  const i = lowered.indexOf('x');
  if (i < 0) throw new Error(`canvas 必须写成 宽x高，例如 1080x1440，实际收到 ${goQuote(value)}`);
  const w = parseGoInt(goTrimSpace(lowered.slice(0, i)));
  const h = parseGoInt(goTrimSpace(lowered.slice(i + 1)));
  if (w === null || h === null || w <= 0 || h <= 0)
    throw new Error(`canvas 的宽高必须是正整数，实际收到 ${goQuote(value)}`);
  return [w, h];
}

/**
 * maxStripFrames 是一张逐帧条带的帧数上限：30fps 下 3 秒。条带是用来看一个
 * 动作或一次转场的，更长的区间应拆成几段，否则缩略图小到看不出差别。
 */
const maxStripFrames = 90;

/** parseRegion 解析 --crop 的 x,y,w,h，并要求区域落在画面内。 */
export function parseRegion(value: string, canvas: scene.Canvas): mediaprobe.Region {
  const parts = value.split(',');
  if (parts.length !== 4) throw new Error(`crop 必须写成 x,y,宽,高（像素），实际收到 ${goQuote(value)}`);
  const numbers = parts.map((part) => {
    const n = parseGoInt(goTrimSpace(part));
    if (n === null || n < 0) throw new Error(`crop 的每一项都必须是非负整数，实际收到 ${goQuote(value)}`);
    return n;
  });
  const r: mediaprobe.Region = { x: numbers[0], y: numbers[1], w: numbers[2], h: numbers[3] };
  if (r.w < 2 || r.h < 2 || r.x + r.w > canvas.widthPx || r.y + r.h > canvas.heightPx) {
    throw new Error(`crop ${value} 超出 ${canvas.widthPx}x${canvas.heightPx} 画面或宽高小于 2`);
  }
  return r;
}

/** parseStrip 把 --strip a:b 换算成区间内的全部帧时间点。 */
export function parseStrip(spec: string, duration: number, fps: number): number[] {
  const i = spec.indexOf(':');
  if (i < 0) throw new Error(`strip 必须写成 开始:结束（秒），实际收到 ${goQuote(spec)}`);
  let bounds: number[];
  try {
    bounds = parseTimePoints(spec.slice(0, i) + ',' + spec.slice(i + 1), duration, fps);
  } catch (err) {
    throw new Error(`strip：${(err as Error).message}`);
  }
  const first = Math.trunc(goRound(bounds[0] * fps));
  const last = Math.trunc(goRound(bounds[1] * fps));
  if (last < first) throw new Error(`strip 的结束早于开始：${goQuote(spec)}`);
  const count = last - first + 1;
  if (count > maxStripFrames) throw new Error(`strip 覆盖 ${count} 帧，超过上限 ${maxStripFrames} 帧；请拆成几段`);
  const points: number[] = [];
  for (let frame = first; frame <= last; frame++) points.push(frame / fps);
  return points;
}

export function canvasFromProject(rootDir: string): scene.Canvas {
  try {
    return scene.canvasOf(rootDir, 'frame.md');
  } catch (err) {
    throw new Error(
      `无法从 ${rootDir} 的 frame.md 确定画幅：${(err as Error).message}；` +
        '脱离项目使用时请显式传 canvas（宽x高）与 fps',
    );
  }
}
