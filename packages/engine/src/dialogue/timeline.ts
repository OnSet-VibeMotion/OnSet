import { atomicWrite } from '../fsutil';
import { formatG, goQuote, goRound } from '../gofmt';
import { marshalIndent } from '../gojson';
import { resultToJSON, SchemaVersion, type Line, type Plan, type Result } from './plan';

/** isFinite 检查浮点数是否有限（既不是 NaN 也不是 ±Inf）。 */
export function isFinite(value: number): boolean {
  return Number.isFinite(value);
}

/** Go 的 %v 打印 float64。 */
function v(n: number): string {
  return formatG(n);
}

/**
 * rebuild 用实测时长把各段拼成全局时间轴。
 *
 * 段内行时间按 实测时长 / 声明时长 等比拉伸：TTS 声明的段内时间戳与实际
 * 音频长度常有几十毫秒出入，不拉伸就会一段段累积到片尾。
 */
export function rebuild(plan: Plan, measured: number[]): Result {
  if (plan.schema !== SchemaVersion) throw new Error(`plan schema 必须是 ${SchemaVersion}，收到 ${goQuote(plan.schema)}`);
  const segments = plan.segments ?? [];
  if (segments.length === 0) throw new Error('plan 里没有任何分段');
  if (measured.length !== segments.length) throw new Error(`实测时长数量 ${measured.length} 与分段数量 ${segments.length} 不一致`);

  const result: Result = { schema: SchemaVersion, segments: null, lines: null };
  let cursor = 0.0;
  let srtIndex = 0;
  segments.forEach((segment, i) => {
    if (segment.speaker === '') throw new Error(`第 ${i + 1} 段没有说话人`);
    if (segment.gapAfterMs < 0) throw new Error(`第 ${i + 1} 段的间隔不得为负：${segment.gapAfterMs}`);
    const lines = segment.lines ?? [];
    if (lines.length === 0) throw new Error(`第 ${i + 1} 段没有字幕行`);
    const duration = measured[i];
    if (!isFinite(duration)) throw new Error(`第 ${i + 1} 段的实测时长无效：${v(duration)}`);
    if (duration <= 0) throw new Error(`第 ${i + 1} 段的实测时长无效：${v(duration)}`);
    const declared = lines[lines.length - 1].endSeconds;
    if (!isFinite(declared)) throw new Error(`第 ${i + 1} 段声明的时长无效：${v(declared)}`);
    if (declared <= 0) throw new Error(`第 ${i + 1} 段声明的时长无效：${v(declared)}`);
    const scale = duration / declared;

    let previousEnd = 0.0;
    lines.forEach((line, j) => {
      if (!isFinite(line.startSeconds)) throw new Error(`第 ${i + 1} 段第 ${j + 1} 行的起始时间无效：${v(line.startSeconds)}`);
      if (!isFinite(line.endSeconds)) throw new Error(`第 ${i + 1} 段第 ${j + 1} 行的结束时间无效：${v(line.endSeconds)}`);
      if (line.endSeconds <= line.startSeconds) {
        throw new Error(`第 ${i + 1} 段第 ${j + 1} 行时间倒挂：[${v(line.startSeconds)}, ${v(line.endSeconds)}]`);
      }
      if (Math.abs(line.startSeconds - previousEnd) > 1e-9) {
        throw new Error(`第 ${i + 1} 段第 ${j + 1} 行与上一行不连续：上行止于 ${v(previousEnd)}，本行起于 ${v(line.startSeconds)}`);
      }
      previousEnd = line.endSeconds;
      srtIndex++;
      (result.lines ??= []).push({
        srtIndex,
        speaker: segment.speaker,
        startSeconds: cursor + line.startSeconds * scale,
        endSeconds: cursor + line.endSeconds * scale,
        text: line.text,
      });
    });
    (result.segments ??= []).push({
      index: segment.index,
      speaker: segment.speaker,
      voiceId: segment.voiceId,
      audio: segment.audio,
      startSeconds: cursor,
      endSeconds: cursor + duration,
      gapAfterMs: segment.gapAfterMs,
    });
    cursor += duration + segment.gapAfterMs / 1000;
  });
  return result;
}

/**
 * writeSRT 写出标准 SRT。
 *
 * 刻意不带说话人：SRT 没有说话人字段，塞前缀会进成片字幕，塞注释各家播放器
 * 行为不一。说话人映射走 dialogue.json。
 */
export function writeSRT(file: string, lines: Line[] | null): void {
  const list = lines ?? [];
  if (list.length === 0) throw new Error('没有任何字幕行');
  let builder = '';
  list.forEach((line, i) => {
    builder += `${line.srtIndex}\n${clock(line.startSeconds)} --> ${clock(line.endSeconds)}\n${line.text}\n`;
    // 最后一行不加空行
    if (i < list.length - 1) builder += '\n';
  });
  atomicWrite(file, builder, 0o644);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * clock 把秒转成 SRT 的 HH:MM:SS,mmm。四舍五入到毫秒，不截断：
 * 截断会让每一行都提前最多 1ms，累积起来是可见的字幕偏移。
 */
export function clock(seconds: number): string {
  let total = goRound(seconds * 1000);
  if (total < 0) total = 0;
  const ms = total % 1000;
  total = Math.trunc(total / 1000);
  return `${pad(Math.trunc(total / 3600), 2)}:${pad(Math.trunc((total % 3600) / 60), 2)}:${pad(total % 60, 2)},${pad(ms, 3)}`;
}

/**
 * writeResultJSON 写出 dialogue.json。
 *
 * JSON 里不带字幕正文（text 字段）：字幕正文的唯一真相是 SRT 文件。JSON 里只有说话人、
 * 时间戳和 SRT 索引，便于外部系统进行说话人识别和时间同步。
 */
export function writeResultJSON(r: Result, file: string): void {
  let body: string;
  try {
    body = marshalIndent(resultToJSON(r));
  } catch (err) {
    throw new Error(`序列化对话数据失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  atomicWrite(file, body + '\n', 0o644);
}
