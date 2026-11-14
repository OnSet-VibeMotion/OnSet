import type { Item } from './evidence';
import { alignCharacters, type Group } from './match';
import type { ScriptToken } from './script';
import { runes, tokenize, type Token } from './token';

/**
 * evToken 是对齐结果切出的一个匹配单元。一个条目里有多个单元时（例如一条里
 * 是整句英文），按字符数比例分时间。
 */
export interface EvToken extends Token {
  start: number;
  end: number;
  segment: number;
}

export function evidenceTokens(items: Item[]): EvToken[] {
  const out: EvToken[] = [];
  for (const item of items) {
    const tokens = tokenize(item.text);
    let total = 0;
    for (const t of tokens) total += runes(t.norm).length;
    let consumed = 0;
    for (const t of tokens) {
      const width = runes(t.norm).length;
      const start = item.start + ((item.end - item.start) * consumed) / total;
      consumed += width;
      const end = item.start + ((item.end - item.start) * consumed) / total;
      out.push({ text: t.text, norm: t.norm, start, end, segment: item.segment });
    }
  }
  return out;
}

/** TimedToken 是带时间与匹配标签的终稿朗读单元。 */
export interface TimedToken extends ScriptToken {
  label: string;
  /** heard 是同组对齐单元的文本，供报告对照。 */
  heard: string;
  start: number;
  end: number;
  /** interpolated 表示时间不是测出来的，而是在前后已定时单元之间按字数插值。 */
  interpolated: boolean;
}

interface Window {
  start: number;
  end: number;
  ok: boolean;
}

/** locate 按匹配路径给每个朗读单元定时，没配上的单元插值补齐。 */
export function locate(source: ScriptToken[], evidence: EvToken[], groups: Group[]): TimedToken[] {
  const timed: TimedToken[] = source.map((t) => ({ ...t, label: '', heard: '', start: 0, end: 0, interpolated: false }));
  const located: Window[] = source.map(() => ({ start: 0, end: 0, ok: false }));
  for (const g of groups) {
    const heard = evidence.slice(g.e0, g.e1).map((e) => e.text);
    for (let i = g.s0; i < g.s1; i++) timed[i] = { ...source[i], label: g.label, heard: heard.join(' '), start: 0, end: 0, interpolated: false };
    if (g.s1 > g.s0 && g.e1 > g.e0) locateGroup(g, source, evidence, located);
  }
  let startBound = 0;
  let endBound = 0;
  if (evidence.length > 0) {
    startBound = evidence[0].start;
    endBound = evidence[0].end;
    for (const e of evidence) {
      startBound = Math.min(startBound, e.start);
      endBound = Math.max(endBound, e.end);
    }
  }
  fillMissing(located, source, startBound, endBound, timed);
  timed.forEach((t, i) => {
    t.start = located[i].start;
    t.end = located[i].end;
  });
  return timed;
}

/**
 * locateGroup 在一个分组内做字符级对齐：每个朗读单元取它配上的对齐字符的起止，
 * 首单元的起点与末单元的终点贴到分组窗口的边上。
 */
function locateGroup(g: Group, source: ScriptToken[], evidence: EvToken[], located: Window[]): void {
  const evChars: number[] = [];
  const evTimes: { start: number; end: number }[] = [];
  const win: Window = { start: evidence[g.e0].start, end: evidence[g.e0].end, ok: true };
  for (const e of evidence.slice(g.e0, g.e1)) {
    win.start = Math.min(win.start, e.start);
    win.end = Math.max(win.end, e.end);
    const rs = runes(e.norm);
    rs.forEach((r, k) => {
      const step = (e.end - e.start) / rs.length;
      evChars.push(r);
      evTimes.push({ start: e.start + step * k, end: e.start + step * (k + 1) });
    });
  }
  if (g.s1 - g.s0 === 1) {
    located[g.s0] = win;
    return;
  }
  const srcChars: number[] = [];
  const owner: number[] = [];
  for (let i = g.s0; i < g.s1; i++) {
    for (const r of runes(source[i].norm)) {
      srcChars.push(r);
      owner.push(i);
    }
  }
  for (const p of alignCharacters(srcChars, evChars)) {
    const i = owner[p.source];
    const t = evTimes[p.evidence];
    if (!located[i].ok) located[i] = { start: t.start, end: t.end, ok: true };
    else located[i].end = Math.max(located[i].end, t.end);
  }
  if (located[g.s0].ok) located[g.s0].start = win.start;
  if (located[g.s1 - 1].ok) located[g.s1 - 1].end = win.end;
}

/**
 * fillMissing 把没定时的连续单元铺在左右已定时邻居之间的空隙里，按字数分配；
 * 开头和结尾的缺口以整段对齐结果的起止为界。
 */
function fillMissing(values: Window[], source: ScriptToken[], startBound: number, endBound: number, timed: TimedToken[]): void {
  for (let cursor = 0; cursor < values.length; ) {
    if (values[cursor].ok) {
      cursor++;
      continue;
    }
    const runStart = cursor;
    while (cursor < values.length && !values[cursor].ok) cursor++;
    const runEnd = cursor;
    let left = startBound;
    let right = endBound;
    if (runStart > 0) left = values[runStart - 1].end;
    if (runEnd < values.length) right = values[runEnd].start;
    right = Math.max(left, right);
    let total = 0;
    for (let i = runStart; i < runEnd; i++) total += Math.max(1, runes(source[i].norm).length);
    let consumed = 0;
    for (let i = runStart; i < runEnd; i++) {
      const start = left + ((right - left) * consumed) / total;
      consumed += Math.max(1, runes(source[i].norm).length);
      const end = left + ((right - left) * consumed) / total;
      values[i] = { start, end, ok: true };
      timed[i].interpolated = true;
    }
  }
}
