// --- ffprobe / ffmpeg 调用 ---
import fs from 'node:fs';
import path from 'node:path';
import { find } from '../toolpath';
import { clickTrack, decodeAnalysisWAV } from './beat';
import { contactSheetRegion } from './contact';
import { extractFrameRegion, extractFramesRegion, frameDifference, frameDifferenceBetween, frameStats } from './frames';
import {
  type AudioLevels,
  loudness,
  measureAudioLevels,
  measureProgramLoudness,
  type ProgramLoudness,
} from './loudness';
import {
  type FrameReport,
  type FrameStats,
  type Media,
  parse,
  parseIntField,
  type RawProbe,
  type Region,
  type Report,
} from './mediaprobe';
import { combined, commandError, firstLine, type Ran, run, runAsync } from './run';
import { muxSong, prepareAlignment } from './song';
import { type VerifyOptions, verifyMedia, verifySeekPoints } from './verify';

export type { VerifyOptions } from './verify';

/**
 * 从给定环境的 PATH 里解析 ffprobe（Go 的 mediaprobe.New）。
 * 缺失时抛 MissingToolError（带 envutil.MissingToolPrefix），调用方据此返回退出码 127。
 *
 * ffmpeg 惰性解析：只读规格（probe / countFrames）用不上它，
 * 在这里一并要求会让「装了 ffprobe 没装 ffmpeg」的机器连镜头校验都跑不了。
 */
export function newToolchain(env: Record<string, string>): Toolchain {
  // onset setup 下载的、客户端自带的优先，其次 PATH（toolpath.find）。
  const ffprobe = find('ffprobe', env);
  return new Toolchain(ffprobe, env.PATH ?? '', { ...env });
}

/**
 * Toolchain 持有已解析的 ffprobe 路径和调用外部命令时使用的环境。
 *
 * 二进制路径在这里按给定环境的 PATH 解析，而不是按本进程的：安全模式下子进程的 PATH 是
 * 受控白名单，按父进程 PATH 找到的二进制未必是同一个。
 */
export class Toolchain {
  /** 用 newToolchain 构造。 */
  constructor(
    readonly ffprobe: string,
    readonly pathValue: string,
    readonly env: Record<string, string>,
  ) {}

  /** 在真正需要 ffmpeg 的操作里解析它。 */
  ffmpegPath(): string {
    return find('ffmpeg', { ...this.env, PATH: this.pathValue });
  }

  /** 异步跑一条命令（Go 的 exec.CommandContext）。 */
  runAsync(
    command: string,
    args: string[],
    options: { signal?: AbortSignal; captureStdout?: boolean; captureStderr?: boolean } = {},
  ): Promise<Ran> {
    return runAsync(command, args, this.env, options);
  }

  /** 读取媒体文件的实测规格。不解码，只读容器和流头，代价与文件长度无关。 */
  probe(file: string): Media {
    const ran = run(
      this.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      this.env,
    );
    if (ran.error) throw new Error(`无法读取媒体规格：${file}（${commandError(ran)}）`);
    return parse(ran.stdout.toString('utf8'), file);
  }

  /**
   * 解码整个文件精确统计帧数。
   *
   * 与 probe 读到的 nb_frames 不同：容器声明的帧数可能缺失或不准，
   * 而验收要断言的是「总帧数等于冻结时间轴的总帧数」。代价是完整解码一遍，
   * 所以只在确实需要精确帧数时调用。
   */
  countFrames(file: string): number {
    const ran = run(
      this.ffprobe,
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=nb_read_frames',
        '-print_format',
        'json',
        file,
      ],
      this.env,
    );
    if (ran.error) throw new Error(`无法统计帧数：${file}（${commandError(ran)}）`);
    let raw: RawProbe;
    try {
      raw = JSON.parse(ran.stdout.toString('utf8')) as RawProbe;
    } catch (err) {
      throw new Error(`ffprobe 帧数输出不是合法 JSON：${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    for (const stream of raw?.streams ?? []) {
      const frames = parseIntField(typeof stream.nb_read_frames === 'string' ? stream.nb_read_frames : '');
      if (frames > 0) return frames;
    }
    throw new Error(`ffprobe 未能统计出帧数：${file}`);
  }

  /** 完整解码一遍，确认文件没有截断或损坏。产物丢弃。 */
  decode(file: string): void {
    const ffmpeg = this.ffmpegPath();
    const ran = run(ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], this.env);
    const output = combined(ran);
    if (ran.error) throw new Error(`无法完整解码：${file}（${firstLine(output)}）`);
    // -xerror 之外，ffmpeg 遇到部分错误仍会返回 0 但往 stderr 写内容。
    const trimmed = output.trim();
    if (trimmed !== '') throw new Error(`解码过程中报错：${file}（${firstLine(trimmed)}）`);
  }

  /** 抽取 atSeconds 处的一帧写成 PNG，自动建立目标目录。 */
  extractFrame(file: string, atSeconds: number, dest: string): void {
    this.extractFrameRegion(file, atSeconds, null, dest);
  }

  /**
   * 同 extractFrame，region 非空时只保留该区域的原始像素，
   * 用于在全分辨率下看小字、细线这类缩略图上看不清的细节。
   */
  extractFrameRegion(file: string, atSeconds: number, region: Region | null, dest: string): void {
    extractFrameRegion(this, file, atSeconds, region, dest);
  }

  /** 抽取 atSeconds 处的一帧，缩放成灰度小图后在本进程里计算均值和标准差。 */
  frameStats(file: string, atSeconds: number): FrameStats {
    return frameStats(this, file, atSeconds);
  }

  /** 抽取 a、b 两个时间点的帧，返回 32×32 RGB 逐通道绝对差的均值（0–255）。 */
  frameDifference(file: string, a: number, b: number): number {
    return frameDifference(this, file, a, b);
  }

  /** 两个文件各取一帧比较，口径与 frameDifference 相同。 */
  frameDifferenceBetween(a: string, atA: number, b: string, atB: number): number {
    return frameDifferenceBetween(this, a, atA, b, atB);
  }

  /** 在首帧、中点、末帧三个代表时间点做 framemd5 seek 解码校验。 */
  verifySeekPoints(file: string, durationSeconds: number, fps: number): string[] {
    return verifySeekPoints(this, file, durationSeconds, fps);
  }

  /** 跑完整的校验流程并返回机器可读报告。 */
  verify(file: string, opts: VerifyOptions = {}): Report {
    return verifyMedia(this, file, opts);
  }

  /**
   * 按给定时间点批量抽帧到 destDir，并统计每帧的灰度分布。
   *
   * 抽帧本身不判定对错——画面对不对只有能看图的一方说了算。这个方法的职责是
   * 把「渲染完的 mp4」变成「可以逐张看的 PNG」，顺带把纯色帧这种机器能判的
   * 情况标出来，省得靠人眼去发现一张全黑的图。
   */
  extractFrames(file: string, atSeconds: number[], destDir: string): FrameReport {
    return this.extractFramesRegion(file, atSeconds, null, destDir);
  }

  /**
   * 同 extractFrames，PNG 只保留 region 区域；空白帧判定仍按整帧。
   * maxWidth 大于 0 且没有 region 时，PNG 缩到不超过这个宽度（等比，统计不受影响）。
   */
  extractFramesRegion(
    file: string,
    atSeconds: number[],
    region: Region | null,
    destDir: string,
    maxWidth = 0,
  ): FrameReport {
    return extractFramesRegion(this, file, atSeconds, region, destDir, maxWidth);
  }

  /** 见 contact.ts 的 contactSheetRegion。 */
  contactSheet(file: string, atSeconds: number[], columns: number, thumbWidth: number, dest: string): void {
    contactSheetRegion(this, file, atSeconds, null, columns, thumbWidth, dest);
  }

  contactSheetRegion(
    file: string,
    atSeconds: number[],
    region: Region | null,
    columns: number,
    thumbWidth: number,
    dest: string,
  ): void {
    contactSheetRegion(this, file, atSeconds, region, columns, thumbWidth, dest);
  }

  /** 见 loudness.ts。 */
  loudness(file: string, windowSeconds: number): number[] {
    return loudness(this, file, windowSeconds);
  }

  measureProgramLoudness(file: string): ProgramLoudness {
    return measureProgramLoudness(this, file);
  }

  measureAudioLevels(file: string): AudioLevels {
    return measureAudioLevels(this, file);
  }

  /** 见 beat.ts。 */
  decodeAnalysisWAV(source: string, dest: string, sampleRate: number, signal?: AbortSignal): Promise<void> {
    return decodeAnalysisWAV(this, source, dest, sampleRate, signal);
  }

  clickTrack(music: string, dest: string, beats: number[], downbeats: number[], signal?: AbortSignal): Promise<void> {
    return clickTrack(this, music, dest, beats, downbeats, signal);
  }

  /** 见 song.ts。 */
  prepareAlignment(source: string, dest: string, signal?: AbortSignal): Promise<void> {
    return prepareAlignment(this, source, dest, signal);
  }

  muxSong(
    video: string,
    audio: string,
    dest: string,
    duration: number,
    fps: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return muxSong(this, video, audio, dest, duration, fps, signal);
  }

  /**
   * 在 dest 同目录的临时文件里转码，成功后改名到位；失败时删掉临时文件。
   * 与 Go 一样不接管 ffmpeg 的输出，错误只有「exit status N」。
   */
  async transcode(dest: string, args: string[], signal?: AbortSignal): Promise<void> {
    const binary = this.ffmpegPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const ext = path.extname(dest);
    const name = path.join(path.dirname(dest), `.song-${Math.floor(Math.random() * 1e10)}${ext}`);
    fs.writeFileSync(name, '', { flag: 'wx', mode: 0o600 });
    try {
      const ran = await this.runAsync(binary, ['-v', 'error', '-nostdin', '-y', ...args, name], { signal });
      if (ran.error) throw new Error(`媒体处理失败：${commandError(ran, false)}`);
      fs.renameSync(name, dest);
    } finally {
      fs.rmSync(name, { force: true });
    }
  }
}
