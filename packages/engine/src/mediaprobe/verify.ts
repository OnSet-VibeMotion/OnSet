// 成片完整校验流程与 seek 关键帧解码校验。
import fs from 'node:fs';
import { formatFixed } from './gofmt';
import {
  checkSpec,
  type FrameStats,
  formatSeconds,
  isBlank,
  isDark,
  type Media,
  type Report,
  ReportSchemaVersion,
  type Spec,
  validateSpec,
} from './mediaprobe';
import { commandError, firstLine, run } from './run';

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
  /**
   * 在首帧、中点、末帧三个代表时间点做 framemd5 seek 解码校验，
   * 拦下关键帧索引损坏导致播放器拖动卡死或花屏的成片。
   */
  checkSeek?: boolean;
  /** 校验前后比对文件大小、修改时间与 inode，防止验证期间文件被并发改写。 */
  checkFileStable?: boolean;
}

export interface VerifyRunner {
  readonly env: Record<string, string>;
  ffmpegPath(): string;
  probe(file: string): Media;
  countFrames(file: string): number;
  decode(file: string): void;
  frameStats(file: string, atSeconds: number): FrameStats;
  verifySeekPoints(file: string, durationSeconds: number, fps: number): string[];
}

/**
 * 在首帧、中点、末帧三个代表时间点做 framemd5 seek 解码校验，
 * 确保关键帧索引正常、播放器随机跳转不会卡死或报解码错。
 */
export function verifySeekPoints(
  runner: Pick<VerifyRunner, 'env' | 'ffmpegPath'>,
  file: string,
  durationSeconds: number,
  fps: number,
): string[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(fps) || fps <= 0) return [];
  const ffmpeg = runner.ffmpegPath();
  const lastFrame = Math.max(0, Math.ceil(durationSeconds * fps - 1e-8) - 1);
  const targets: [string, number][] = [
    ['首帧', 0],
    ['中点', Math.floor((durationSeconds * fps) / 2) / fps],
    ['末帧', lastFrame / fps],
  ];
  const problems: string[] = [];
  for (const [label, at] of targets) {
    const ran = run(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-xerror',
        '-err_detect',
        'explode',
        '-ss',
        formatSeconds(at),
        '-i',
        file,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-an',
        '-f',
        'framemd5',
        'pipe:1',
      ],
      runner.env,
    );
    const stderr = ran.stderr.toString('utf8').trim();
    const stdout = ran.stdout.toString('utf8');
    if (ran.error || stderr !== '' || !/^\s*\d+,/m.test(stdout)) {
      problems.push(
        `${label}（${formatFixed(at, 3)} 秒）seek 解码失败：${firstLine(stderr || commandError(ran) || '未产出帧校验数据')}`,
      );
    }
  }
  return problems;
}

/**
 * 跑完整的校验流程并返回机器可读报告。
 *
 * 抛出的错误只表示「检查没跑成」（文件读不了、工具缺失），
 * 「检查跑了但不合格」体现为 report.ok 为 false 和 problems 非空——
 * 两者对调用方的含义完全不同，混在一起会让退出码失去区分度。
 */
export function verifyMedia(runner: VerifyRunner, file: string, opts: VerifyOptions = {}): Report {
  const spec = opts.spec ?? {};
  validateSpec(spec);
  const beforeStat = opts.checkFileStable ? fs.statSync(file) : null;
  const media = runner.probe(file);
  const report: Report = { schema_version: ReportSchemaVersion, path: file, ok: false, media, problems: [] };

  // media.video 为 null 时（纯音频文件）跳过整个精确帧数统计：既没有视频流
  // 可数，硬调用 countFrames 也只会拿到「未能统计出帧数」这种无意义的错误，
  // 不如直接放行到下面的 checkSpec，由它给出「文件没有视频流」这条可读问题。
  if (opts.exactFrames && media.video) {
    // 用精确值覆盖容器声明，让 checkSpec 与报告读到的是同一个数。
    media.video.nb_frames = runner.countFrames(file);
  }
  report.problems = checkSpec(spec, media);

  if (opts.decode) {
    try {
      runner.decode(file);
    } catch (err) {
      report.problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (opts.checkSeek && media.video) {
    const fps = media.video.fps_den > 0 ? media.video.fps_num / media.video.fps_den : 0;
    const duration = media.video.duration_seconds > 0 ? media.video.duration_seconds : media.duration_seconds;
    report.problems.push(...runner.verifySeekPoints(file, duration, fps));
  }
  if (opts.checkFrameZero && media.video) {
    const stats = runner.frameStats(file, 0);
    report.frame_zero = stats;
    if (isBlank(stats)) {
      report.problems.push(
        `第 0 帧是空白帧，不能作为封面：灰度均值 ${formatFixed(stats.mean, 1)}、标准差 ${formatFixed(stats.stddev, 2)}`,
      );
    } else if (isDark(stats)) {
      // 只提示不判失败：深色背景配浅色标题是常见设计。
      (report.hints ??= []).push(`第 0 帧整体偏暗（灰度均值 ${formatFixed(stats.mean, 1)}），确认标题在目标平台可读`);
    }
  }
  if (beforeStat) {
    const afterStat = fs.statSync(file);
    if (
      beforeStat.size !== afterStat.size ||
      beforeStat.mtimeMs !== afterStat.mtimeMs ||
      beforeStat.ino !== afterStat.ino
    ) {
      report.problems.push(`校验过程中文件发生变化：${file}`);
    }
  }
  report.ok = report.problems.length === 0;
  return report;
}
