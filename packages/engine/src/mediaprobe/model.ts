// 媒体流、帧统计与画面区域的数据模型及纯函数工具。
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
