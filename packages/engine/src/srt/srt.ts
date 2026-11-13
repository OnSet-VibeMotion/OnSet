// 读取字幕的时间信息：整体跨度（readSpan）与逐条时间码（readCues）。移植自 internal/srt。
//
// 跨度用来核对镜头拆分有没有漏掉或重复覆盖时间轴；逐条时间码用来与实际语音
// 比对。两者都不做样式、位置等 SRT 扩展语法的解析。
import fs from 'node:fs';
import { formatFixed, pathError } from './gofmt';

// timecodeLine 匹配 "00:00:01,234 --> 00:00:05,678"。
//
// 分隔符同时接受逗号和点号：规范写逗号，但不少工具（尤其是从 VTT 转过来的）
// 产出点号，一律拒绝会让合法字幕被判成格式错误。
// （Go 正则的 \s 只认 ASCII 空白，这里显式写出，不用 JS 的 Unicode \s。）
const timecodeLine =
  /^[\t\n\f\r ]*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})[\t\n\f\r ]*-->[\t\n\f\r ]*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/** Span 是一份字幕的时间跨度。 */
export class Span {
  constructor(
    /** 第一条字幕的开始时间。 */
    public startSeconds = 0,
    /** 最后一条字幕的结束时间。 */
    public endSeconds = 0,
    /** 解析到的字幕条数。 */
    public cues = 0,
  ) {}

  /** 跨度长度，即镜头总时长应当匹配的目标值。 */
  seconds(): number {
    return this.endSeconds - this.startSeconds;
  }
}

/** bufio.Scanner 的单行上限（scanner.Buffer 的第二个参数）。 */
const maxLineBytes = 1024 * 1024;

/**
 * 读文件并按 bufio.ScanLines 的规则切行：以 \n 分隔、去掉行尾的 \r，末尾的空行不算一行。
 * 错误文案对应 Go 的两个阶段：os.Open 失败与 scanner.Err()（读到目录、单行超过上限）。
 */
function readLines(file: string): string[] {
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    // Go 里打开目录会成功，读的时候才失败，落在「读取字幕失败」那一支。
    if ((err as NodeJS.ErrnoException).code === 'EISDIR') {
      throw new Error(`读取字幕失败：${pathError('read', file, err)}`, { cause: err });
    }
    throw new Error(`无法读取字幕：${pathError('open', file, err)}`, { cause: err });
  }
  const text = body.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => {
    if (Buffer.byteLength(line) >= maxLineBytes) throw new Error('读取字幕失败：bufio.Scanner: token too long');
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  });
}

/**
 * 从 SRT 文件读出时间跨度。
 *
 * 取的是所有时间码里的最小开始与最大结束，而不是第一行和最后一行：
 * 字幕条目乱序或时间重叠时，按出现顺序取会得到一个偏小甚至为负的跨度。
 */
export function readSpan(file: string): Span {
  const span = new Span();
  for (const line of readLines(file)) {
    const match = timecodeLine.exec(line);
    if (!match) continue;
    const start = clockSeconds(match[1], match[2], match[3], match[4]);
    const end = clockSeconds(match[5], match[6], match[7], match[8]);
    if (span.cues === 0 || start < span.startSeconds) span.startSeconds = start;
    if (span.cues === 0 || end > span.endSeconds) span.endSeconds = end;
    span.cues++;
  }
  if (span.cues === 0) throw new Error(`字幕里没有任何时间码：${file}`);
  if (span.seconds() <= 0) {
    throw new Error(`字幕跨度非正：开始 ${formatFixed(span.startSeconds, 3)} 秒、结束 ${formatFixed(span.endSeconds, 3)} 秒`);
  }
  return span;
}

/** 把时分秒毫秒转成秒。 */
function clockSeconds(hours: string, minutes: string, seconds: string, millis: string): number {
  const h = Number(hours);
  const m = Number(minutes);
  const s = Number(seconds);
  // 毫秒位数不足时要右补零而不是左补：",5" 是 500 毫秒，不是 5 毫秒。
  const ms = Number(millis + '0'.repeat(3 - millis.length));
  if (m > 59 || s > 59) {
    throw new Error(`时间码的分或秒超出范围：${hours}:${minutes}:${seconds},${millis}`);
  }
  // 与 Go 的 time.Duration.Seconds() 同一算法：整秒加上纳秒部分除以 1e9。
  // ms 至多三位，不会进位到整秒。
  return h * 3600 + m * 60 + s + (ms * 1e6) / 1e9;
}

/**
 * Cue 是一条字幕。index 是它在文件中的出现顺序（从 1 开始），不取文件里写的
 * 序号：那一行常被手工编辑弄乱，报错时按出现顺序定位才可靠。
 */
export interface Cue {
  index: number;
  start_seconds: number;
  end_seconds: number;
  text: string;
}

/** 按出现顺序读出全部字幕条目。时间码之后、空行之前的非空行是正文。 */
export function readCues(file: string): Cue[] {
  const cues: Cue[] = [];
  let current: Cue | null = null;
  let text: string[] = [];
  const flush = () => {
    if (current) {
      current.text = text.join('\n');
      cues.push(current);
    }
    current = null;
    text = [];
  };
  for (const raw of readLines(file)) {
    const line = raw.startsWith('﻿') ? raw.slice(1) : raw;
    const match = timecodeLine.exec(line);
    if (match) {
      flush();
      const start = clockSeconds(match[1], match[2], match[3], match[4]);
      const end = clockSeconds(match[5], match[6], match[7], match[8]);
      // 零时长条目照收：对齐器常给纯标点条目输出 start == end，判对错是
      // 调用方的事；结束早于开始则是文件本身坏了。
      if (end < start) {
        throw new Error(`第 ${cues.length + 1} 条字幕的结束时间早于开始时间：${line.trim()}`);
      }
      current = { index: cues.length + 1, start_seconds: start, end_seconds: end, text: '' };
      continue;
    }
    const trimmed = line.trim();
    if (!current) continue;
    if (trimmed === '') {
      flush();
      continue;
    }
    text.push(trimmed);
  }
  flush();
  if (cues.length === 0) throw new Error(`字幕里没有任何时间码：${file}`);
  return cues;
}
