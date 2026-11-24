// --- ffprobe 输出解析 ---
import type { Media } from './model';

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
  const media: Media = {
    path: file,
    duration_seconds: parseFloatField(str(raw?.format?.duration)),
    video: null,
    audio: null,
  };
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
