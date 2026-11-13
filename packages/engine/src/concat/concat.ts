// Package concat 把一组镜头产物按顺序拼成静音母版。移植自 internal/concat。
//
// 对应 PROMPT-PRODUCTION.md 第八阶段。放进二进制而不是留给渲染 agent 现场拼
// ffmpeg 命令，图的是这一句：
//
//	「规范化只用于编码、像素格式、色彩和封装统一，不得承担语义重定时。
//	 禁止通过 setpts 或改变帧率让镜头追赶配音；源时间轴有误时必须回到镜头工程重渲染。」
//
// 提示词里的禁令可以被忽略，不存在的能力不能。所以这里根本不提供重定时：
// 分辨率或帧率对不上时直接失败并要求重渲染，而不是悄悄缩放或改帧率。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { find } from '../toolpath';
import { atomicWrite } from '../fsutil';
import { formatFixed, goTrimSpace } from '../gofmt';
import { videoFPS, videoResolution, type Toolchain } from '../mediaprobe';

/** Target 是母版的目标规格。 */
export interface Target {
  widthPx: number;
  heightPx: number;
  fps: number;
  codec: string;
  pixelFormat: string;
}

// DefaultCodec 与 DefaultPixelFormat 来自 PROMPT 第八阶段的检查表。
export const DefaultCodec = 'h264';
export const DefaultPixelFormat = 'yuv420p';

/** Input 是参与拼接的一个片段。 */
export interface Input {
  /** id 用于错误信息，通常是镜头编号。 */
  id: string;
  /** path 是片段文件路径。 */
  path: string;
}

/** Plan 是拼接前的分析结果。 */
export interface Plan {
  /** blocking 是必须先修复才能拼接的问题，通常意味着要回去重渲染。 */
  blocking: string[];
  /** normalize 列出需要规范化副本的片段。 */
  normalize: Input[];
  /** totalSeconds 是各片段实测时长之和。 */
  totalSeconds: number;
}

/** strings.EqualFold 的常用近似：按 Unicode 小写比较。 */
const equalFold = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Analyze 逐个探测片段，判断能否直接 -c copy 拼接，以及哪些需要规范化。
 *
 * 分辨率与帧率不符归入 blocking 而不是 normalize：把 720p 拉伸到 1080 是画质
 * 损失而不是格式统一，改帧率则会动到时间轴。这两类只能回镜头工程重渲染。
 */
export function analyze(toolchain: Pick<Toolchain, 'probe'>, inputs: Input[] | null, target: Target): Plan {
  const plan: Plan = { blocking: [], normalize: [], totalSeconds: 0 };
  if (!inputs || inputs.length === 0) {
    plan.blocking.push('没有可拼接的片段');
    return plan;
  }
  for (const input of inputs) {
    const media = toolchain.probe(input.path);
    plan.totalSeconds += media.duration_seconds;
    const video = media.video;

    // mediaprobe.probe 现在也放行纯音频文件（video 可以是 null）：观察阶段
    // 不再替判定阶段拦掉这种输入。母版拼接的输入本该都是有画面的镜头产物，
    // 混进一个没有视频流的文件说明上游渲染出了错，这里按 blocking 处理。
    if (video === null) {
      plan.blocking.push(`${input.id} 没有视频流，无法作为母版片段——请回镜头工程重渲染`);
      continue;
    }
    if (video.width_px !== target.widthPx || video.height_px !== target.heightPx) {
      plan.blocking.push(
        `${input.id} 分辨率是 ${videoResolution(video)}，母版要求 ${target.widthPx}x${target.heightPx}——缩放会损失画质，请回镜头工程按正确画幅重渲染`,
      );
      continue;
    }
    if (target.fps > 0 && !sameFPS(videoFPS(video), target.fps)) {
      plan.blocking.push(`${input.id} 帧率是 ${formatFPS(videoFPS(video))}，母版要求 ${target.fps}——改帧率会动到时间轴，请回镜头工程重渲染`);
      continue;
    }
    if (media.audio !== null) {
      plan.blocking.push(`${input.id} 带有 ${media.audio.codec} 音轨，静音母版不允许有音轨`);
      continue;
    }
    // 只有编码和像素格式的差异才靠规范化统一。
    if (!equalFold(video.codec, target.codec) || !equalFold(video.pixel_format, target.pixelFormat)) plan.normalize.push(input);
  }
  return plan;
}

function sameFPS(actual: number, want: number): boolean {
  const diff = actual - want;
  return diff < 0.02 && diff > -0.02;
}

function formatFPS(value: number): string {
  if (value === Math.trunc(value)) return String(Math.trunc(value));
  return formatFixed(value, 3);
}

/** NewRunner 解析 ffmpeg 并返回可用的执行器。缺失时抛 MissingToolError。 */
export function newRunner(env: Record<string, string>, toolchain: Toolchain): Runner {
  const ffmpeg = find('ffmpeg', env);
  return new Runner(toolchain, ffmpeg, { ...env });
}

/** Runner 执行拼接。 */
export class Runner {
  /** 用 newRunner 构造。 */
  constructor(
    readonly toolchain: Toolchain,
    readonly ffmpeg: string,
    readonly env: Record<string, string>,
  ) {}

  /**
   * Normalize 生成一个只统一编码、像素格式与封装的副本，保留原始文件。
   *
   * 显式带上 -fps_mode passthrough 与不设 -r：任何隐式的帧率协商都可能悄悄增删帧，
   * 那正是这个函数不该做的事。不用旧写法 -vsync：它在 ffmpeg 5.1 起被标为弃用、
   * 8.x 已删除，新版 ffmpeg 会直接报 Unrecognized option 'vsync'，拼接前的规范化
   * 整个失败。-fps_mode 自 5.1 起可用。
   */
  async normalize(source: string, dest: string, target: Target, signal?: AbortSignal): Promise<void> {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const codec = 'libx264';
    if (!equalFold(target.codec, 'h264')) throw new Error(`规范化目前只支持 h264，收到 ${target.codec}`);
    const ran = await combinedOutput(
      this.ffmpeg,
      ['-v', 'error', '-y', '-i', source, '-c:v', codec, '-pix_fmt', target.pixelFormat, '-fps_mode', 'passthrough', '-an', '-movflags', '+faststart', dest],
      this.env,
      signal,
    );
    if (!ran.ok) throw new Error(`规范化失败：${source}（${firstLine(ran.output)}）`);
  }

  /**
   * Concat 按给定顺序把片段拼成 dest，全程 -c copy，不重新编码。
   *
   * 用 concat demuxer 而不是 concat filter：后者会重新编码，把已经规范化好的
   * 片段再解一遍又编一遍，既慢又掉画质。
   */
  async concat(paths: string[] | null, dest: string, signal?: AbortSignal): Promise<void> {
    if (!paths || paths.length === 0) throw new Error('没有可拼接的片段');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 用 CreateTemp 式的唯一清单文件名：固定文件名在同一目录并发跑
    // 多个 concat 时会互相覆盖对方还没读完的清单（与 internal/dialogue/audio.go
    // 的 Concat 同样的问题、同样的修法）。
    const listPath = createTemp(path.dirname(dest), '.am-concat-list-', '.txt');
    try {
      let list = '';
      for (const p of paths) {
        // concat demuxer 的清单里单引号要转义成 '\'' ，否则路径含单引号会截断。
        list += "file '" + path.resolve(p).replaceAll("'", "'\\''") + "'\n";
      }
      atomicWrite(listPath, Buffer.from(list, 'utf8'), 0o644);
      const ran = await combinedOutput(
        this.ffmpeg,
        ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', dest],
        this.env,
        signal,
      );
      if (!ran.ok) throw new Error(`拼接失败：${dest}（${firstLine(ran.output)}）`);
    } finally {
      fs.rmSync(listPath, { force: true });
    }
  }
}

/** os.CreateTemp(dir, prefix + "*" + suffix)：独占创建一个随机名文件并返回路径。 */
function createTemp(dir: string, prefix: string, suffix: string): string {
  for (let attempt = 0; ; attempt++) {
    const name = path.join(dir, `${prefix}${crypto.randomInt(0, 2 ** 32)}${suffix}`);
    try {
      fs.closeSync(fs.openSync(name, 'wx', 0o600));
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 10000) throw err;
    }
  }
}

/** exec.CommandContext(...).CombinedOutput()：stdout 与 stderr 按到达顺序写进同一份输出。 */
function combinedOutput(command: string, args: string[], env: Record<string, string>, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, output: '' });
      return;
    }
    const child = spawn(command, args, { env, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
    let settled = false;
    const settle = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve({ ok, output: Buffer.concat(chunks).toString('utf8') });
      }
    };
    child.on('error', () => {
      if (child.pid === undefined) settle(false);
    });
    child.on('close', (status) => settle(status === 0));
  });
}

/** 第一行，去掉首尾空白，最多 200 字节；空串写成「无输出」。 */
export function firstLine(value: string): string {
  let trimmed = goTrimSpace(value);
  const index = trimmed.indexOf('\n');
  if (index >= 0) trimmed = trimmed.slice(0, index);
  const bytes = Buffer.from(trimmed, 'utf8');
  if (bytes.length > 200) trimmed = bytes.subarray(0, 200).toString('utf8');
  return trimmed === '' ? '无输出' : trimmed;
}
