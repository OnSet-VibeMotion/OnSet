import { atomicWrite } from '../fsutil';
import { goRound } from '../gofmt';
import { units } from '../reads';
import type { Script } from './script';
import type { TimedToken } from './timing';

/**
 * MaxCueUnits 是一条字幕的显示长度上限（阅读单位，口径同 reads.units）。
 * 句子超过它时在逗号、顿号处再切。
 */
export const MaxCueUnits = 32;

/** Cue 是 voice.srt 的一条：显示文本，时间来自其中朗读单元的起止。 */
export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  /** from/to 是 piece 区间，tok0/tok1 是朗读单元区间，都左闭右开。 */
  from: number;
  to: number;
  tok0: number;
  tok1: number;
}

const containsAny = (s: string, chars: string): boolean => s !== '' && [...s].some((c) => chars.includes(c));
const isSentenceEnd = (s: string): boolean => containsAny(s, '。！？!?；;');
const isClauseEnd = (s: string): boolean => containsAny(s, '，、,');
const isCloser = (s: string): boolean => containsAny(s, '”’」』）)】》"\'');

type Range = [number, number];

/** sentences 按句末标点与分段切句。句末标点后紧跟的右引号、右括号归前一句。 */
function sentences(s: Script): Range[] {
  const out: Range[] = [];
  let start = 0;
  let pending = false;
  s.pieces.forEach((p, i) => {
    if (i > start && p.para !== s.pieces[i - 1].para) {
      out.push([start, i]);
      start = i;
      pending = false;
    }
    if (pending && !(p.plain && isCloser(p.display))) {
      out.push([start, i]);
      start = i;
      pending = false;
    }
    if (p.plain && isSentenceEnd(p.display)) pending = true;
  });
  if (start < s.pieces.length) out.push([start, s.pieces.length]);
  return out;
}

/** splitLong 把显示长度超限的句子在逗号、顿号处切开，尽量让每段贴近上限。 */
function splitLong(s: Script, sentence: Range): Range[] {
  if (units(s.displayText(sentence[0], sentence[1])) <= MaxCueUnits) return [sentence];
  const clauses: Range[] = [];
  let start = sentence[0];
  for (let i = sentence[0]; i < sentence[1]; i++) {
    if (s.pieces[i].plain && isClauseEnd(s.pieces[i].display)) {
      clauses.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < sentence[1]) clauses.push([start, sentence[1]]);
  const out: Range[] = [];
  let current: Range = [...clauses[0]];
  for (const clause of clauses.slice(1)) {
    if (units(s.displayText(current[0], clause[1])) <= MaxCueUnits) {
      current[1] = clause[1];
      continue;
    }
    out.push(current);
    current = [...clause];
  }
  out.push(current);
  return out;
}

/** buildCues 切出字幕并定时。没有朗读单元的片段（纯标点、只显示不朗读）并进前一条。 */
export function buildCues(s: Script, timed: TimedToken[]): Cue[] {
  const ranges: Range[] = [];
  for (const sentence of sentences(s)) ranges.push(...splitLong(s, sentence));
  let cues: Cue[] = [];
  const blank = (from: number, to: number, tok0: number, tok1: number): Cue => ({ index: 0, startMs: 0, endMs: 0, text: '', from, to, tok0, tok1 });
  for (const r of ranges) {
    const [tok0, tok1] = s.tokenRange(r[0], r[1]);
    if (tok1 === tok0) {
      if (cues.length > 0) cues[cues.length - 1].to = r[1];
      else if (ranges.length > 1) {
        // 开头的纯显示片段留给下一条：记成空 cue，下一条吸收它。
        cues.push(blank(r[0], r[1], -1, 0));
      }
      continue;
    }
    if (cues.length > 0 && cues[cues.length - 1].tok0 < 0) {
      const last = cues[cues.length - 1];
      last.to = r[1];
      last.tok0 = tok0;
      last.tok1 = tok1;
      continue;
    }
    cues.push(blank(r[0], r[1], tok0, tok1));
  }
  if (cues.length > 0 && cues[cues.length - 1].tok0 < 0) cues = cues.slice(0, -1);
  // 只有不显示的朗读（<|嗯>）的一条没有字幕文字，SRT 写不出空条目：并进相邻的一条。
  for (let i = 0; i < cues.length && cues.length > 1; ) {
    if (s.displayText(cues[i].from, cues[i].to) !== '') {
      i++;
      continue;
    }
    if (i > 0) {
      cues[i - 1].to = cues[i].to;
      cues[i - 1].tok1 = cues[i].tok1;
    } else {
      cues[1].from = cues[0].from;
      cues[1].tok0 = cues[0].tok0;
    }
    cues.splice(i, 1);
  }
  let previousEnd = 0;
  cues.forEach((c, i) => {
    c.index = i + 1;
    c.text = s.displayText(c.from, c.to);
    let start = Infinity;
    let end = -Infinity;
    for (const t of timed.slice(c.tok0, c.tok1)) {
      start = Math.min(start, t.start);
      end = Math.max(end, t.end);
    }
    c.startMs = toMs(start);
    c.endMs = toMs(end);
    // 取整后可能与上一条重叠：把起点推到上一条终点，再保证至少 1 毫秒。
    if (i > 0 && c.startMs < previousEnd) c.startMs = previousEnd;
    if (c.endMs <= c.startMs) c.endMs = c.startMs + 1;
    previousEnd = c.endMs;
  });
  return cues;
}

/** cueOfPiece 返回包含该 piece 的字幕编号（从 1 开始），找不到返回 0。 */
export function cueOfPiece(cues: Cue[], piece: number): number {
  for (const c of cues) if (piece >= c.from && piece < c.to) return c.index;
  return 0;
}

/** int64(math.Round(seconds * 1000))；+ 0 把 -0 变成 0（Go 的整数没有负零）。 */
export function toMs(seconds: number): number {
  return goRound(seconds * 1000) + 0;
}

/** FormatSRT 把字幕写成 SRT 文本，毫秒精度。 */
export function formatSRT(cues: Cue[]): string {
  let b = '';
  cues.forEach((c, i) => {
    if (i > 0) b += '\n';
    b += `${c.index}\n${srtClock(c.startMs)} --> ${srtClock(c.endMs)}\n${c.text}\n`;
  });
  return b;
}

/** WriteSRT 原子写出字幕文件。 */
export function writeSRT(file: string, cues: Cue[]): void {
  atomicWrite(file, Buffer.from(formatSRT(cues), 'utf8'), 0o644);
}

/** Go 的整数除法向零截断；%02d 对负数写成「-1」后补零到两位。 */
function pad(value: number, width: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(negative ? width - 1 : width, '0');
  return negative ? '-' + digits : digits;
}

function srtClock(ms: number): string {
  const h = Math.trunc(ms / 3_600_000);
  const m = Math.trunc(ms / 60_000) % 60;
  const sec = Math.trunc(ms / 1000) % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)},${pad(ms % 1000, 3)}`;
}
