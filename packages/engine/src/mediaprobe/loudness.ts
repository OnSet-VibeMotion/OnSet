import { formatG, goQuote, goRound } from './gofmt';
import { commandError, run } from './run';
import type { Toolchain } from './toolchain';

/**
 * 响度采样前统一重采样到的采样率。语音能量集中在 4kHz
 * 以下，16kHz 足够，也让五分钟配音的 PCM 只有十来 MB。
 */
const loudnessSampleRate = 16000;

/**
 * 全静音窗口的电平。数字静音的真实值是负无穷，
 * 用一个有限值代替，让下游比较与 JSON 序列化都不必特判。
 */
export const SilenceFloorDB = -120.0;

/**
 * 把音频解码成 16kHz 单声道 16 位 PCM，按 windowSeconds 切窗，
 * 返回每窗的 RMS 电平（dBFS）。
 *
 * 不用 ffmpeg 的 silencedetect：它把结果写进 stderr 的文本日志，格式随版本
 * 变化，而且阈值在命令行里写死，改判据就得重跑一遍解码。裸 PCM 是稳定接口，
 * 判据留给调用方——与 frameStats 取原始灰度像素是同一个取舍。
 */
export function loudness(t: Toolchain, file: string, windowSeconds: number): number[] {
  if (!(windowSeconds > 0) || !Number.isFinite(windowSeconds)) {
    throw new Error(`响度窗口必须是正数，收到 ${formatG(windowSeconds)}`);
  }
  const window = goRound(windowSeconds * loudnessSampleRate);
  if (window < 1) throw new Error(`响度窗口太短：${formatG(windowSeconds)} 秒`);
  const ffmpeg = t.ffmpegPath();
  const ran = run(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(loudnessSampleRate), '-f', 's16le', '-acodec', 'pcm_s16le', '-'], t.env);
  if (ran.error) throw new Error(`无法解码音频：${file}（${commandError(ran)}）`);
  const output = ran.stdout;
  const samples = Math.floor(output.length / 2);
  if (samples === 0) throw new Error(`音频里没有可解码的采样：${file}`);
  const levels: number[] = [];
  for (let start = 0; start < samples; start += window) {
    const end = Math.min(start + window, samples);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const value = output.readInt16LE(2 * i) / 32768;
      sum += value * value;
    }
    levels.push(rmsToDB(Math.sqrt(sum / (end - start))));
  }
  return levels;
}

export function rmsToDB(rms: number): number {
  if (rms <= 0) return SilenceFloorDB;
  return Math.max(SilenceFloorDB, 20 * Math.log10(rms));
}

/** ProgramLoudness 是整段节目的 EBU R128 实测值，取自解码后的音频。 */
export interface ProgramLoudness {
  integrated_lufs: number;
  true_peak_dbtp: number;
  range_lu: number;
}

/**
 * 用 loudnorm 的测量通道量积分响度、真峰与响度范围。
 *
 * 量的必须是编码后的成片，不是混音导出的 WAV：AAC 会把采样之间的峰值再抬高，
 * 波形文件 -2.5 dBTP 的素材编解码一趟可以到 0 dBFS 以上。loudnorm 的真峰做了
 * 过采样，正是要查的那个数。
 *
 * 结果从 stderr 里的 JSON 块读，不读 ebur128 的文本摘要：JSON 的字段名是
 * loudnorm 两遍规范化的输入契约，比随版本变化的日志排版稳定。全静音时 ffmpeg
 * 给 "-inf"，按 SilenceFloorDB 记，让报告仍能写成 JSON。
 */
export function measureProgramLoudness(t: Toolchain, file: string): ProgramLoudness {
  const ffmpeg = t.ffmpegPath();
  const ran = run(ffmpeg, ['-hide_banner', '-nostats', '-nostdin', '-i', file, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], t.env);
  // Go 里 stderr 接到了自己的缓冲区，ExitError 不带 stderr，错误只有「exit status N」。
  if (ran.error) throw new Error(`无法测量响度：${file}（${commandError(ran, false)}）`);
  return parseLoudnorm(ran.stderr.toString('utf8'));
}

/** Go 的 strconv.ParseFloat：十进制小数、inf / infinity / nan（不分大小写）；不是数字时返回 null。 */
function goParseFloat(value: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return Number(value);
  const special = /^([+-]?)(inf|infinity)$/i.exec(value);
  if (special) return special[1] === '-' ? -Infinity : Infinity;
  if (/^nan$/i.test(value)) return NaN;
  return null;
}

export function parseLoudnorm(log: string): ProgramLoudness {
  const start = log.lastIndexOf('{');
  const end = log.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('loudnorm 没有输出测量结果');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(log.slice(start, end + 1)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`loudnorm 测量结果无法解析：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const fields = ['input_i', 'input_tp', 'input_lra'].map((key) => {
    const value = raw?.[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new Error(`loudnorm 测量结果无法解析：json: cannot unmarshal ${typeof value} into Go struct field .${key} of type string`);
    }
    return value ?? '';
  });
  const values = fields.map((field) => {
    const value = goParseFloat(field.trim());
    if (value === null || Number.isNaN(value)) throw new Error(`loudnorm 测量值 ${goQuote(field)} 不是数字`);
    return Math.max(SilenceFloorDB, value);
  });
  return { integrated_lufs: values[0], true_peak_dbtp: values[1], range_lu: values[2] };
}
