// --- ffprobe / ffmpeg 调用 ---
import fs from 'node:fs';
import path from 'node:path';
import { find } from '../toolpath';
import { decodeAnalysisWAV, clickTrack } from './beat';
import { contactSheetRegion, nonEmpty } from './contact';
import { formatFixed } from './gofmt';
import { loudness, measureProgramLoudness, type ProgramLoudness } from './loudness';
import {
  checkSpec,
  isBlank,
  isDark,
  parse,
  parseIntField,
  regionFilter,
  ReportSchemaVersion,
  validateSpec,
  meanAbsoluteDifference,
  formatSeconds,
  type ExtractedFrame,
  type FrameReport,
  type FrameStats,
  type Media,
  type RawProbe,
  type Region,
  type Report,
  type Spec,
} from './mediaprobe';
import { combined, commandError, firstLine, run, runAsync, type Ran } from './run';
import { muxSong, prepareAlignment } from './song';

/**
 * VerifyOptions 描述一次完整校验除规格比对外还要做哪些检查。
 *
 * 三项都默认关闭，因为它们的代价和 probe 不在一个量级：
 * exactFrames 与 decode 都要完整解码一遍文件，checkFrameZero 要解一帧。
 */
export interface VerifyOptions {
  spec?: Spec;
  /**
   * 用 countFrames 解码统计精确帧数，取代容器声明的 nb_frames。
   * 需要断言「总帧数等于冻结时间轴」时必须打开：容器声明可能缺失或不准。
   */
  exactFrames?: boolean;
  /** 完整解码一遍，确认文件没有截断或损坏。 */
  decode?: boolean;
  /**
   * 检查第 0 帧是否是空白帧，对应 frame.md 的
   * black_or_blank_frame_zero 禁令。
   */
  checkFrameZero?: boolean;
}

/** 计算统计量时的缩放边长。缩放到固定尺寸让阈值与画幅无关，也让代价与视频分辨率无关。 */
const statsSampleSize = 128;

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

/**
 * 比对两帧时的缩放边长。取得很小是刻意的：交接时物件
 * 在交界两侧挪动几像素、描边粗细差一点都属于接上了，缩到 32 像素后这类差异
 * 几乎消失，剩下的只有「两张不同的画面」这种量级的差别。
 */
const differenceSampleSize = 32;

/** 用于文件名的时间戳，去掉尾随零。 */
function formatSecondsShort(value: number): string {
  let text = formatFixed(value, 3).replace(/0+$/, '');
  if (text.endsWith('.')) text = text.slice(0, -1);
  return text;
}

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
  runAsync(command: string, args: string[], options: { signal?: AbortSignal; captureStdout?: boolean; captureStderr?: boolean } = {}): Promise<Ran> {
    return runAsync(command, args, this.env, options);
  }

  /** 读取媒体文件的实测规格。不解码，只读容器和流头，代价与文件长度无关。 */
  probe(file: string): Media {
    const ran = run(this.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], this.env);
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
      ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-print_format', 'json', file],
      this.env,
    );
    if (ran.error) throw new Error(`无法统计帧数：${file}（${commandError(ran)}）`);
    let raw: RawProbe;
    try {
      raw = JSON.parse(ran.stdout.toString('utf8')) as RawProbe;
    } catch (err) {
      throw new Error(`ffprobe 帧数输出不是合法 JSON：${err instanceof Error ? err.message : String(err)}`, { cause: err });
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
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // -ss 放在 -i 前面：转码时 ffmpeg 默认精确定位（accurate_seek），取到的就是
    // 「第 N 秒那一帧」，与放在 -i 后面逐字节相同，但不必从片头解码过来。
    const ffmpeg = this.ffmpegPath();
    const argv = ['-v', 'error', '-y', '-ss', formatSeconds(atSeconds), '-i', file, '-frames:v', '1'];
    const filter = regionFilter(region);
    if (filter !== '') argv.push('-vf', filter);
    const ran = run(ffmpeg, [...argv, '-f', 'image2', '-c:v', 'png', dest], this.env);
    if (ran.error) throw new Error(`抽帧失败：${file} @ ${formatFixed(atSeconds, 3)} 秒（${firstLine(combined(ran))}）`);
    if (!nonEmpty(dest)) {
      // 时间点超出时长时 ffmpeg 会返回 0 但什么都不写。静默产出空文件
      // 比报错更危险：调用方会以为抽到了帧。
      fs.rmSync(dest, { force: true });
      throw new Error(`抽帧没有产出内容：${file} @ ${formatFixed(atSeconds, 3)} 秒（时间点可能超出视频时长）`);
    }
  }

  /**
   * 抽取 atSeconds 处的一帧，缩放成灰度小图后在本进程里计算均值和标准差。
   *
   * 不用 ffmpeg 的 signalstats/blackdetect：它们把结果写进 stderr 的文本日志，
   * 格式随版本变化，解析起来比自己算更脆。裸灰度像素是稳定接口。
   */
  frameStats(file: string, atSeconds: number): FrameStats {
    const ffmpeg = this.ffmpegPath();
    const output = this.rawFrame(ffmpeg, file, atSeconds, statsSampleSize, 'gray');
    return grayStats(atSeconds, output);
  }

  /** 一次定位与解码同时写 PNG 和统计像素；统计仍取整帧，不能被裁剪区域改变。 */
  private extractFrameAndStats(file: string, atSeconds: number, region: Region | null, dest: string, maxWidth = 0): FrameStats {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 沿用 extractFrameRegion / frameStats 的自动选流：多视频流文件未必以第一条为主画面。
    const argv = ['-v', 'error', '-y', '-ss', formatSeconds(atSeconds), '-i', file, '-frames:v', '1'];
    // 只缩写出去的 PNG（给看图的一方省 token）；灰度统计是另一路输出，照旧按原帧算。裁了区域就是要看原始像素，不缩。
    const filter = region === null && maxWidth > 0 ? `scale='min(${maxWidth},iw)':-2` : regionFilter(region);
    if (filter !== '') argv.push('-vf', filter);
    const ran = run(this.ffmpegPath(), [
      ...argv, '-f', 'image2', '-c:v', 'png', dest,
      '-frames:v', '1', '-vf', `scale=${statsSampleSize}:${statsSampleSize},format=gray`, '-f', 'rawvideo', '-',
    ], this.env);
    if (ran.error) throw new Error(`抽帧失败：${file} @ ${formatFixed(atSeconds, 3)} 秒（${firstLine(ran.stderr.toString('utf8'))}）`);
    if (!nonEmpty(dest) || ran.stdout.length === 0) {
      fs.rmSync(dest, { force: true });
      throw new Error(`抽帧没有产出内容：${file} @ ${formatFixed(atSeconds, 3)} 秒（时间点可能超出视频时长）`);
    }
    return grayStats(atSeconds, ran.stdout);
  }

  /** 抽取 atSeconds 处的一帧，缩放成 size×size 的指定像素格式后返回裸像素。 */
  private rawFrame(ffmpeg: string, file: string, atSeconds: number, size: number, pixelFormat: string): Buffer {
    // 输入端定位，理由同 contactSheet：整片复查要对每个镜头交界各取两帧。
    const ran = run(
      ffmpeg,
      ['-v', 'error', '-ss', formatSeconds(atSeconds), '-i', file, '-frames:v', '1', '-vf', `scale=${size}:${size},format=${pixelFormat}`, '-f', 'rawvideo', '-'],
      this.env,
    );
    if (ran.error) throw new Error(`读取帧像素失败：${file} @ ${formatFixed(atSeconds, 3)} 秒（${commandError(ran)}）`);
    if (ran.stdout.length === 0) throw new Error(`该时间点没有帧：${file} @ ${formatFixed(atSeconds, 3)} 秒`);
    return ran.stdout;
  }

  /**
   * 抽取 a、b 两个时间点的帧，缩放成 32×32 的 RGB 小图，返回逐通道
   * 绝对差的均值（0–255）。0 是完全相同，两张无关画面通常在 40 以上。
   */
  frameDifference(file: string, a: number, b: number): number {
    const ffmpeg = this.ffmpegPath();
    const first = this.rawFrame(ffmpeg, file, a, differenceSampleSize, 'rgb24');
    const second = this.rawFrame(ffmpeg, file, b, differenceSampleSize, 'rgb24');
    return meanAbsoluteDifference(first, second);
  }

  /**
   * 两个文件各取一帧比较，口径与 frameDifference 相同（32×32 RGB 逐通道绝对差的均值）。
   * 镜头交界：前一镜的末帧对后一镜的首帧，拼接前就能量出哪道交界没接上。
   */
  frameDifferenceBetween(a: string, atA: number, b: string, atB: number): number {
    const ffmpeg = this.ffmpegPath();
    return meanAbsoluteDifference(this.rawFrame(ffmpeg, a, atA, differenceSampleSize, 'rgb24'), this.rawFrame(ffmpeg, b, atB, differenceSampleSize, 'rgb24'));
  }

  /**
   * 跑完整的校验流程并返回机器可读报告。
   *
   * 抛出的错误只表示「检查没跑成」（文件读不了、工具缺失），
   * 「检查跑了但不合格」体现为 report.ok 为 false 和 problems 非空——
   * 两者对调用方的含义完全不同，混在一起会让退出码失去区分度。
   */
  verify(file: string, opts: VerifyOptions = {}): Report {
    const spec = opts.spec ?? {};
    validateSpec(spec);
    const media = this.probe(file);
    const report: Report = { schema_version: ReportSchemaVersion, path: file, ok: false, media, problems: [] };

    // media.video 为 null 时（纯音频文件）跳过整个精确帧数统计：既没有视频流
    // 可数，硬调用 countFrames 也只会拿到「未能统计出帧数」这种无意义的错误，
    // 不如直接放行到下面的 checkSpec，由它给出「文件没有视频流」这条可读问题。
    if (opts.exactFrames && media.video) {
      // 用精确值覆盖容器声明，让 checkSpec 与报告读到的是同一个数。
      media.video.nb_frames = this.countFrames(file);
    }
    report.problems = checkSpec(spec, media);

    if (opts.decode) {
      try {
        this.decode(file);
      } catch (err) {
        report.problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (opts.checkFrameZero && media.video) {
      const stats = this.frameStats(file, 0);
      report.frame_zero = stats;
      if (isBlank(stats)) {
        report.problems.push(`第 0 帧是空白帧，不能作为封面：灰度均值 ${formatFixed(stats.mean, 1)}、标准差 ${formatFixed(stats.stddev, 2)}`);
      } else if (isDark(stats)) {
        // 只提示不判失败：深色背景配浅色标题是常见设计。
        (report.hints ??= []).push(`第 0 帧整体偏暗（灰度均值 ${formatFixed(stats.mean, 1)}），确认标题在目标平台可读`);
      }
    }
    report.ok = report.problems.length === 0;
    return report;
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
  extractFramesRegion(file: string, atSeconds: number[], region: Region | null, destDir: string, maxWidth = 0): FrameReport {
    const report: FrameReport = { schema_version: ReportSchemaVersion, path: file, ok: false, frames: [], problems: [] };
    for (const at of atSeconds) {
      const image = path.join(destDir, `frame-${formatSecondsShort(at).replaceAll('.', '_')}.png`);
      const stats = this.extractFrameAndStats(file, at, region, image, maxWidth);
      const frame: ExtractedFrame = { at_seconds: at, image, stats, blank: isBlank(stats), dark: isDark(stats) };
      report.frames.push(frame);
      if (frame.blank) {
        report.problems.push(
          `${formatFixed(at, 3)} 秒处是空白帧：灰度均值 ${formatFixed(stats.mean, 1)}、标准差 ${formatFixed(stats.stddev, 2)}（${image}）`,
        );
      } else if (frame.dark) {
        (report.hints ??= []).push(`${formatFixed(at, 3)} 秒处整体偏暗（灰度均值 ${formatFixed(stats.mean, 1)}），确认内容可读（${image}）`);
      }
    }
    report.ok = report.problems.length === 0;
    return report;
  }

  /** 见 contact.ts 的 contactSheetRegion。 */
  contactSheet(file: string, atSeconds: number[], columns: number, thumbWidth: number, dest: string): void {
    contactSheetRegion(this, file, atSeconds, null, columns, thumbWidth, dest);
  }

  contactSheetRegion(file: string, atSeconds: number[], region: Region | null, columns: number, thumbWidth: number, dest: string): void {
    contactSheetRegion(this, file, atSeconds, region, columns, thumbWidth, dest);
  }

  /** 见 loudness.ts。 */
  loudness(file: string, windowSeconds: number): number[] {
    return loudness(this, file, windowSeconds);
  }

  measureProgramLoudness(file: string): ProgramLoudness {
    return measureProgramLoudness(this, file);
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

  muxSong(video: string, audio: string, dest: string, duration: number, fps: number, signal?: AbortSignal): Promise<void> {
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
