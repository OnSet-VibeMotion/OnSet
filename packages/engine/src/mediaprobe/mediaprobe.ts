// 把 ffprobe / ffmpeg 的实测结果解析成结构体，并按期望规格断言。
//
// 存在的理由：制作提示词的拼接与最终验收两个阶段列出了一整张成片机器检查表
// （画幅、30fps、H.264、yuv420p、帧数、音轨、采样率、可完整解码），但这些检查过去
// 只写在提示词里——每次运行都由 AI CLI 现场自己拼 ffprobe 参数，拼法每次不同、
// 漏检不报错。把这张表变成代码，检查项才有单一实现和单一真相源。
//
// 设计上的两条硬约束：
//
//   - Spec 的零值字段表示「不检查」，调用方只想查一件事时不必把全部字段填满。
//   - checkSpec 返回全部不符项而不是第一条。验收门每次只报一条，调用方就得
//     「修一条、重跑一次、再发现下一条」，一次成片检查要循环好几轮。
//
// ffprobe / ffmpeg 的调用都在 Toolchain 上（toolchain.ts 及同目录的 beat / contact / loudness / song）。

import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { formatFixed } from './gofmt';
import { type FrameStats, type Media, mediaToJSON, videoFPS, videoResolution } from './model';

export {
  type AudioStream,
  audioStream,
  type FrameStats,
  formatSeconds,
  isBlank,
  isDark,
  isFlat,
  joinFilters,
  type Media,
  meanAbsoluteDifference,
  mediaToJSON,
  type Region,
  regionFilter,
  type VideoStream,
  videoFPS,
  videoResolution,
  videoStream,
} from './model';
export { parse, parseIntField, parseRational, type RawProbe } from './parse';

/** Audio 表示对音轨存在与否的期望。 */
export type Audio = 0 | 1 | 2;
/** 不检查音轨。 */
export const AudioIgnore: Audio = 0;
/** 要求没有音轨，用于镜头产物和静音母版。 */
export const AudioAbsent: Audio = 1;
/** 要求有音轨，用于混音后的成片。 */
export const AudioPresent: Audio = 2;

/** Spec 是期望规格。零值（或省略）字段表示不检查该项。 */
export interface Spec {
  widthPx?: number;
  heightPx?: number;
  fps?: number;
  codec?: string;
  pixelFormat?: string;
  durationSeconds?: number;
  tolerance?: number;
  /** 期望的总帧数。与实测值比较前要先确认实测值已知。 */
  frames?: number;
  audio?: Audio;
  sampleRate?: number;
  channels?: number;
}

/** 检查 Spec 自身是否自洽，在跑任何外部命令之前调用。 */
export function validateSpec(s: Spec): void {
  const duration = s.durationSeconds ?? 0;
  const tolerance = s.tolerance ?? 0;
  if (duration !== 0) {
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('时长容差必须是有限且非负的数字');
    if (!Number.isFinite(duration) || duration < 0) throw new Error('期望时长必须是有限且非负的数字');
  }
}

/**
 * fpsTolerance 容纳 29.97 这类分数帧率与整数声明之间的差。
 * 取 0.05：29.97 与 30 相差 0.03 会被判定为「不是 30fps」，
 * 而 25 与 30 相差 5 显然超出——两者之间没有需要区分的真实帧率。
 */
const fpsTolerance = 0.02;

function formatFPS(value: number): string {
  if (value === Math.trunc(value)) return String(Math.trunc(value));
  return formatFixed(value, 3);
}

function orUnknown(value: string): string {
  return value === '' ? '未知' : value;
}

/**
 * 逐项比对并返回全部不符项。相符时返回空数组。
 *
 * 每条不符项都带实测值：只说「分辨率不符」的话，调用方还得自己再跑一次
 * ffprobe 才知道差在哪，等于把这个包的价值抵消掉一半。
 */
export function checkSpec(s: Spec, m: Media): string[] {
  const problems: string[] = [];
  const v = m.video;
  if (!v) return ['文件没有视频流'];
  const widthPx = s.widthPx ?? 0;
  const heightPx = s.heightPx ?? 0;
  const fps = s.fps ?? 0;
  const duration = s.durationSeconds ?? 0;
  const tolerance = s.tolerance ?? 0;
  const frames = s.frames ?? 0;
  if (widthPx > 0 && heightPx > 0 && (v.width_px !== widthPx || v.height_px !== heightPx)) {
    problems.push(`分辨率不符：期望 ${widthPx}x${heightPx}，实测 ${videoResolution(v)}`);
  }
  if (fps > 0 && Math.abs(videoFPS(v) - fps) > fpsTolerance) {
    problems.push(`帧率不符：期望 ${fps}，实测 ${formatFPS(videoFPS(v))}`);
  }
  if (s.codec && !equalFold(v.codec, s.codec)) {
    problems.push(`视频编码不符：期望 ${s.codec}，实测 ${orUnknown(v.codec)}`);
  }
  if (s.pixelFormat && !equalFold(v.pixel_format, s.pixelFormat)) {
    problems.push(`像素格式不符：期望 ${s.pixelFormat}，实测 ${orUnknown(v.pixel_format)}`);
  }
  if (duration > 0 && Math.abs(m.duration_seconds - duration) > tolerance) {
    problems.push(
      `时长不符：期望 ${formatFixed(duration, 3)} 秒（容差 ${formatFixed(tolerance, 3)}），实测 ${formatFixed(m.duration_seconds, 3)} 秒`,
    );
  }
  // nb_frames == 0 是「容器没声明」，不是「0 帧」。把未知当成不符会让
  // 所有不声明 nb_frames 的容器一律失败。
  if (frames > 0 && v.nb_frames > 0 && v.nb_frames !== frames) {
    problems.push(`总帧数不符：期望 ${frames}，实测 ${v.nb_frames}`);
  }
  switch (s.audio ?? AudioIgnore) {
    case AudioAbsent:
      if (m.audio) problems.push(`应当没有音轨，实测存在 ${orUnknown(m.audio.codec)} 音轨`);
      break;
    case AudioPresent:
      if (!m.audio) problems.push('应当有音轨，实测没有音轨');
      break;
  }
  if (m.audio) {
    const sampleRate = s.sampleRate ?? 0;
    const channels = s.channels ?? 0;
    if (sampleRate > 0 && m.audio.sample_rate !== sampleRate) {
      problems.push(`音频采样率不符：期望 ${sampleRate}，实测 ${m.audio.sample_rate}`);
    }
    if (channels > 0 && m.audio.channels !== channels) {
      problems.push(`音频声道数不符：期望 ${channels}，实测 ${m.audio.channels}`);
    }
  }
  return problems;
}

/** strings.EqualFold 的近似：按 Unicode 小写比较（编码名、像素格式都是 ASCII）。 */
function equalFold(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Report 是一次校验的机器可读结果。
 *
 * 与 schedule.Report 同样的取向：调用方应当读这份 JSON 判断结果，
 * 而不是解析给人看的中文输出。字段一旦发布就不再删改，只做向后兼容的追加。
 */
export interface Report {
  schema_version: number;
  path: string;
  /** 只由 problems 决定。hints 不影响判定。 */
  ok: boolean;
  media: Media;
  /** Go 里没有问题时是 nil，写 JSON 时为 null。 */
  problems: string[];
  /**
   * 值得人看一眼、但不构成失败的观察项。
   * 混进 problems 会让「提示」把退出码变成非 0，调用方就得靠字符串匹配区分。
   */
  hints?: string[];
  frame_zero?: FrameStats;
}

/** Report 的结构版本。 */
export const ReportSchemaVersion = 1;

/** 按 Go 的 struct 字段顺序与 nil / omitempty 规则构造 Report 的 JSON 值。 */
export function reportToJSON(r: Report): unknown {
  return {
    schema_version: r.schema_version,
    path: r.path,
    ok: r.ok,
    media: mediaToJSON(r.media),
    problems: r.problems.length > 0 ? r.problems : null,
    hints: r.hints && r.hints.length > 0 ? r.hints : undefined,
    frame_zero: r.frame_zero ? frameStatsToJSON(r.frame_zero) : undefined,
  };
}

function frameStatsToJSON(f: FrameStats): unknown {
  return { at_seconds: f.at_seconds, mean: f.mean, stddev: f.stddev };
}

/** 原子写出报告。 */
export function writeReportJSON(r: Report, file: string): void {
  atomicWrite(file, marshalIndent(reportToJSON(r)) + '\n', 0o644);
}

/** ExtractedFrame 是一次抽帧的结果。 */
export interface ExtractedFrame {
  at_seconds: number;
  image: string;
  stats: FrameStats;
  blank: boolean;
  dark: boolean;
}

/** FrameReport 是一次抽帧检查的机器可读结果。 */
export interface FrameReport {
  schema_version: number;
  path: string;
  ok: boolean;
  /** Go 里没有帧时是 nil，写 JSON 时为 null。 */
  frames: ExtractedFrame[];
  /** Go 里没有问题时是 nil，写 JSON 时为 null。 */
  problems: string[];
  hints?: string[];
}

/** 按 Go 的 struct 字段顺序与 nil / omitempty 规则构造 FrameReport 的 JSON 值。 */
export function frameReportToJSON(r: FrameReport): unknown {
  return {
    schema_version: r.schema_version,
    path: r.path,
    ok: r.ok,
    frames:
      r.frames.length > 0
        ? r.frames.map((f) => ({
            at_seconds: f.at_seconds,
            image: f.image,
            stats: frameStatsToJSON(f.stats),
            blank: f.blank,
            dark: f.dark,
          }))
        : null,
    problems: r.problems.length > 0 ? r.problems : null,
    hints: r.hints && r.hints.length > 0 ? r.hints : undefined,
  };
}

/** 原子写出抽帧报告。 */
export function writeFrameReportJSON(r: FrameReport, file: string): void {
  atomicWrite(file, marshalIndent(frameReportToJSON(r)) + '\n', 0o644);
}
