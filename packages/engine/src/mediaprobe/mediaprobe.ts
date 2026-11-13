// 把 ffprobe / ffmpeg 的实测结果解析成结构体，并按期望规格断言。移植自 internal/mediaprobe。
//
// 存在的理由：PROMPT-PRODUCTION.md 的第八、十一阶段列出了一整张成片机器检查表
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

/** VideoStream 是视频流的实测规格。 */
export interface VideoStream {
  codec: string;
  width_px: number;
  height_px: number;
  pixel_format: string;
  fps_num: number;
  fps_den: number;
  /**
   * 容器声明的帧数。0 表示容器没声明，不代表 0 帧——
   * 精确帧数要用 countFrames 解码统计。
   */
  nb_frames: number;
  /** 以下三项为空串时写 JSON 省略（omitempty）。 */
  color_space: string;
  color_primaries: string;
  color_transfer: string;
  /**
   * 该流自己声明的时长，0 表示没声明（写 JSON 时省略）。
   * 与容器时长分开记：成片的音画是否等长只能按流比。
   */
  duration_seconds: number;
}

/** 补齐 VideoStream 的零值字段，方便手工构造（Go 里未写的字段就是零值）。 */
export function videoStream(fields: Partial<VideoStream> = {}): VideoStream {
  return {
    codec: '',
    width_px: 0,
    height_px: 0,
    pixel_format: '',
    fps_num: 0,
    fps_den: 0,
    nb_frames: 0,
    color_space: '',
    color_primaries: '',
    color_transfer: '',
    duration_seconds: 0,
    ...fields,
  };
}

/** 帧率。ffprobe 用分数表示帧率，29.97 写成 30000/1001。 */
export function videoFPS(v: VideoStream): number {
  if (v.fps_den === 0) return 0;
  return v.fps_num / v.fps_den;
}

/** "宽x高" 形式，供错误信息直接引用。 */
export function videoResolution(v: VideoStream): string {
  return `${v.width_px}x${v.height_px}`;
}

/** AudioStream 是音频流的实测规格。 */
export interface AudioStream {
  codec: string;
  sample_rate: number;
  channels: number;
  /** 该流自己声明的时长，0 表示没声明（写 JSON 时省略）。 */
  duration_seconds: number;
}

/** 补齐 AudioStream 的零值字段。 */
export function audioStream(fields: Partial<AudioStream> = {}): AudioStream {
  return { codec: '', sample_rate: 0, channels: 0, duration_seconds: 0, ...fields };
}

/** Media 是一个媒体文件的实测规格。没有音轨时 audio 为 null，没有视频流时 video 为 null。 */
export interface Media {
  path: string;
  duration_seconds: number;
  video: VideoStream | null;
  audio: AudioStream | null;
}

/** 按 Go 的 struct 字段顺序与 omitempty 规则构造 Media 的 JSON 值。 */
export function mediaToJSON(m: Media): unknown {
  return {
    path: m.path,
    duration_seconds: m.duration_seconds,
    video: m.video
      ? {
          codec: m.video.codec,
          width_px: m.video.width_px,
          height_px: m.video.height_px,
          pixel_format: m.video.pixel_format,
          fps_num: m.video.fps_num,
          fps_den: m.video.fps_den,
          nb_frames: m.video.nb_frames,
          color_space: m.video.color_space || undefined,
          color_primaries: m.video.color_primaries || undefined,
          color_transfer: m.video.color_transfer || undefined,
          duration_seconds: m.video.duration_seconds || undefined,
        }
      : null,
    audio: m.audio
      ? {
          codec: m.audio.codec,
          sample_rate: m.audio.sample_rate,
          channels: m.audio.channels,
          duration_seconds: m.audio.duration_seconds || undefined,
        }
      : null,
  };
}

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
 * FrameStats 是单帧的灰度统计量，用于判定黑帧和空白帧。
 */
export interface FrameStats {
  at_seconds: number;
  mean: number;
  stddev: number;
}

// 判定阈值。刻意取得极保守——误判「设计上就是深色的正常画面」为空白帧，
// 比漏判一个真空白帧更糟：前者会让人很快不再信任这个检查。

/**
 * flatStdDev 之下视为空白帧。
 *
 * 阈值不能凭「真实帧标准差通常很高」来定：深色背景上只有一行标题时，
 * 亮部占比可能不到 1%，标准差会低到 20 出头。取 2.0 意味着只拦几乎完全
 * 均匀的画面，把误判概率压到最低——纯色帧的标准差本来就接近 0。
 */
const flatStdDev = 2.0;
/** darkMean 之下视为整体过暗。这是提示信号而不是判定依据，见 isBlank。 */
const darkMean = 16.0;

/** 该帧是否几乎是纯色。黑、白和任何单色都算。 */
export function isFlat(f: FrameStats): boolean {
  return f.stddev < flatStdDev;
}

/**
 * 该帧整体是否过暗。
 *
 * 这是提示而不是结论：深色背景配浅色标题是常见设计，整帧灰度均值可以很低，
 * 但画面完全可读。所以 isDark 不参与 isBlank 判定，只用于让人多看一眼。
 */
export function isDark(f: FrameStats): boolean {
  return f.mean < darkMean;
}

/**
 * 该帧是否命中 frame.md 的 black_or_blank_frame_zero 禁令。
 *
 * 只看 isFlat：纯黑帧的标准差本来就是 0，会被 isFlat 抓到，无需再叠加亮度条件。
 * 叠加了反而会把「深色背景 + 稀疏文字」的合法封面误判成空白帧。
 */
export function isBlank(f: FrameStats): boolean {
  return isFlat(f);
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
        ? r.frames.map((f) => ({ at_seconds: f.at_seconds, image: f.image, stats: frameStatsToJSON(f.stats), blank: f.blank, dark: f.dark }))
        : null,
    problems: r.problems.length > 0 ? r.problems : null,
    hints: r.hints && r.hints.length > 0 ? r.hints : undefined,
  };
}

/** 原子写出抽帧报告。 */
export function writeFrameReportJSON(r: FrameReport, file: string): void {
  atomicWrite(file, marshalIndent(frameReportToJSON(r)) + '\n', 0o644);
}

/** Region 是画面上的一个矩形区域（像素，原始分辨率）。 */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 裁剪该区域的 ffmpeg 滤镜；region 为 null 时返回空串。 */
export function regionFilter(r: Region | null | undefined): string {
  if (!r) return '';
  return `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
}

/** 把非空滤镜用逗号串起来。 */
export function joinFilters(...filters: string[]): string {
  return filters.filter((f) => f !== '').join(',');
}

export function formatSeconds(value: number): string {
  return formatFixed(value, 6);
}

/** 两段等长裸像素逐字节绝对差的均值。 */
export function meanAbsoluteDifference(first: Uint8Array, second: Uint8Array): number {
  if (first.length !== second.length || first.length === 0) {
    throw new Error(`两帧像素长度不同（${first.length} 与 ${second.length}），无法比对`);
  }
  let sum = 0;
  for (let i = 0; i < first.length; i++) sum += Math.abs(first[i] - second[i]);
  return sum / first.length;
}

// --- ffprobe 输出解析 ---

interface RawStream {
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_frames?: string;
  sample_rate?: string;
  channels?: number;
  color_space?: string;
  color_primaries?: string;
  color_transfer?: string;
  duration?: string;
}

export interface RawProbe {
  streams?: RawStream[];
  format?: { duration?: string };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const int = (value: unknown): number => (typeof value === 'number' ? Math.trunc(value) : 0);

/**
 * 把 ffprobe 的 JSON 输出解析成 Media。
 *
 * ffprobe 的字段类型是混着来的：width / height / channels 是数字，
 * nb_frames / duration / sample_rate 是字符串。照直觉写解析必然出错，
 * 所以这里逐个字段按实际类型读，并由 realProbeOutput 那条测试守着。
 */
export function parse(body: string, file: string): Media {
  let raw: RawProbe;
  try {
    raw = JSON.parse(body) as RawProbe;
  } catch (err) {
    throw new Error(`ffprobe 输出不是合法 JSON：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const media: Media = { path: file, duration_seconds: parseFloatField(str(raw?.format?.duration)), video: null, audio: null };
  for (const stream of raw?.streams ?? []) {
    switch (stream.codec_type) {
      case 'video': {
        if (media.video) continue;
        let rate = str(stream.r_frame_rate);
        if (parseRational(rate) === 0) rate = str(stream.avg_frame_rate);
        const [num, den] = splitRational(rate);
        let frames = parseIntField(str(stream.nb_frames));
        if (frames === 0) frames = parseIntField(str(stream.nb_read_frames));
        media.video = {
          codec: str(stream.codec_name),
          width_px: int(stream.width),
          height_px: int(stream.height),
          pixel_format: str(stream.pix_fmt),
          fps_num: num,
          fps_den: den,
          nb_frames: frames,
          color_space: str(stream.color_space),
          color_primaries: str(stream.color_primaries),
          color_transfer: str(stream.color_transfer),
          duration_seconds: parseFloatField(str(stream.duration)),
        };
        break;
      }
      case 'audio':
        if (media.audio) continue;
        media.audio = {
          codec: str(stream.codec_name),
          sample_rate: parseIntField(str(stream.sample_rate)),
          channels: int(stream.channels),
          duration_seconds: parseFloatField(str(stream.duration)),
        };
        break;
    }
  }
  // video 和 audio 都为 null 说明 ffprobe 没认出任何可用流（通常是探测了非
  // 媒体文件），这种情况才报错。纯音频文件（如 dialogue 的 TTS 片段/静音/
  // 拼接产物）没有视频流是合法形态，video 保持 null 交给调用方按需处理——
  // checkSpec 早就按这个约定写了（video 为 null 时报「文件没有视频流」），
  // 只是 parse 一直没跟上，把这条合法路径提前堵死了。
  if (!media.video && !media.audio) throw new Error(`${file} 没有可识别的音视频流`);
  return media;
}

const decimalFloat = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function parseFloatField(value: string): number {
  const trimmed = value.trim();
  if (!decimalFloat.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseIntField(value: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  return parsed < 0 || !Number.isSafeInteger(parsed) ? 0 : parsed;
}

function atoi(value: string): number | null {
  if (!/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function splitRational(value: string): [number, number] {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash < 0) return [0, 0];
  const n = atoi(trimmed.slice(0, slash));
  const d = atoi(trimmed.slice(slash + 1));
  if (n === null || d === null || d === 0) return [0, 0];
  return [n, d];
}

export function parseRational(value: string): number {
  const [n, d] = splitRational(value);
  if (d === 0) return 0;
  return n / d;
}
