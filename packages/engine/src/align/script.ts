// 移植自 internal/align/script.go。
import fs from 'node:fs';
import { goPathError, goQuote, goTrimSpace } from '../gofmt';
import { isWordRune, normRune, normalizeRunes, runeString, runes, tokenizeRunes, type Token } from './token';

// 终稿标记语法（production/script-final.md）：
//
//	<显示|朗读>         显示文本与朗读文本不同：<2024年|二零二四年>、<API|A P I>
//	<|嗯>               只朗读、不显示
//	<显示|>             只显示、不朗读（没有时间，随所在字幕）
//	@{id}……@{/id}       受保护短语，进 phrase-timeline.json；可以嵌套，不能交叉
//	# 开头的行          标题，忽略
//	空行                分段
//	\< \> \@ \| \\      转义
//
// 同一段内的换行不产生文字；两侧都是字母数字时补一个空格，免得两个英文词粘成一个。

/** phraseIDPattern 是短语 id 的合法形式。 */
const phraseIDPattern = /^[a-z0-9][a-z0-9_-]*$/;

/** piece 是终稿的最小显示单位：一个普通字符，或一个 <显示|朗读> 标记。 */
export interface Piece {
  display: string;
  spoken: string;
  line: number;
  col: number;
  para: number;
  /** plain 表示来自普通文本（显示即朗读），只有它参与断句判断。 */
  plain: boolean;
  /** softBreak 是段内换行留下的占位，解析结束后决定是否变成空格。 */
  softBreak: boolean;
}

/** ScriptToken 是终稿朗读侧的一个匹配单元，记着它落在哪几个 piece 上。 */
export interface ScriptToken extends Token {
  firstPiece: number;
  lastPiece: number;
  line: number;
  col: number;
}

/** PhraseSpan 是一个受保护短语在终稿里的位置，piece 下标左闭右开。 */
export interface PhraseSpan {
  id: string;
  startPiece: number;
  endPiece: number;
  line: number;
  col: number;
  /** order 是按开始位置排出的出现顺序，从 1 开始。 */
  order: number;
}

/** heading 是一行 # 标题，落在第 atPiece 个 piece 之前。 */
export interface Heading {
  atPiece: number;
  level: number;
  text: string;
}

/** ParseError 带着出错位置（行、列都从 1 开始，列按字符计）。 */
export class ParseError extends Error {
  constructor(
    readonly line: number,
    readonly col: number,
    readonly msg: string,
  ) {
    super(`第 ${line} 行第 ${col} 列：${msg}`);
  }
}

const badEscape = '无效转义：只能转义 \\< \\> \\@ \\| \\\\';

/**
 * Script 是解析后的终稿。Go 里的 SpokenText / View 是它的方法；pieces、pieceToken、
 * headings 在 Go 里是未导出字段，这里照样公开（测试与同包代码要读），包外不要依赖。
 */
export class Script {
  pieces: Piece[] = [];
  tokens: ScriptToken[] = [];
  phrases: PhraseSpan[] = [];
  /** pieceToken 是每个 piece 上第一个开始的朗读单元下标，没有时为 -1。 */
  pieceToken: number[] = [];
  /** headings 是标题行，只给 view 用：不进配音、不进字幕。 */
  headings: Heading[] = [];

  /** SpokenText 返回送进 TTS 与对齐工具的文本：标记取朗读侧，标题行丢掉，段与段之间换行，标点保留。 */
  spokenText(): string {
    let b = '';
    this.pieces.forEach((p, i) => {
      if (i > 0 && p.para !== this.pieces[i - 1].para) b += '\n';
      b += p.spoken;
    });
    const out: string[] = [];
    for (const para of b.split('\n')) {
      const t = goTrimSpace(para);
      if (t !== '') out.push(t);
    }
    if (out.length === 0) return '';
    return out.join('\n') + '\n';
  }

  /** displayText 拼出 piece 区间 [from, to) 的显示文本。 */
  displayText(from: number, to: number): string {
    let b = '';
    for (const p of this.pieces.slice(from, to)) b += p.display;
    return goTrimSpace(b);
  }

  /**
   * tokenRange 返回首 piece 落在 [from, to) 内的朗读单元下标区间，左闭右开。
   * 区间里没有朗读单元时返回空区间 (k, k)，k 是其后第一个单元的下标。
   */
  tokenRange(from: number, to: number): [number, number] {
    const first = search(this.tokens.length, (i) => this.tokens[i].firstPiece >= from);
    const end = search(this.tokens.length, (i) => this.tokens[i].firstPiece >= to);
    return [first, Math.max(first, end)];
  }
}

/** sort.Search。 */
export function search(n: number, f: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (!f(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** LoadScript 读取并解析终稿文件。 */
export function loadScript(file: string): Script {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`无法读取终稿：${goPathError('open', file, err)}`, { cause: err });
  }
  try {
    return parseScript(body);
  } catch (err) {
    throw new Error(`${file} ${(err as Error).message}`, { cause: err });
  }
}

interface OpenPhrase {
  id: string;
  startPiece: number;
  line: number;
  col: number;
}

/** strings.TrimLeft / TrimRight 的 cutset 版本（按码点）。 */
export function trimLeftSet(s: string, cutset: string): string {
  const set = new Set(cutset);
  const cs = [...s];
  let i = 0;
  while (i < cs.length && set.has(cs[i])) i++;
  return cs.slice(i).join('');
}

export function trimRightSet(s: string, cutset: string): string {
  const set = new Set(cutset);
  const cs = [...s];
  let end = cs.length;
  while (end > 0 && set.has(cs[end - 1])) end--;
  return cs.slice(0, end).join('');
}

/** ParseScript 解析终稿标记。 */
export function parseScript(text: string): Script {
  const s = new Script();
  if (text.startsWith('﻿')) text = text.slice(1);
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const stack: OpenPhrase[] = [];
  const seen = new Set<string>();
  let para = 0;
  let paraHasContent = false;
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = trimRightSet(raw, '\r');
    const trimmed = trimLeftSet(line, ' \t　');
    if (goTrimSpace(trimmed) === '' || trimmed.startsWith('#')) {
      if (trimmed.startsWith('#')) {
        const body = trimLeftSet(trimmed, '#');
        s.headings.push({ atPiece: s.pieces.length, level: trimmed.length - body.length, text: goTrimSpace(body) });
      }
      if (paraHasContent) {
        para++;
        paraHasContent = false;
      }
      return;
    }
    if (paraHasContent) s.pieces.push({ display: '', spoken: '', line: lineNo, col: 1, para, plain: false, softBreak: true });
    paraHasContent = true;
    const rs = runes(line);
    const add = (p: Omit<Piece, 'para' | 'softBreak'>) => s.pieces.push({ ...p, para, softBreak: false });
    for (let i = 0; i < rs.length; ) {
      const col = i + 1;
      const r = rs[i];
      if (r === 0x5c) {
        if (i + 1 >= rs.length || !isEscapable(rs[i + 1])) throw new ParseError(lineNo, col, badEscape);
        const ch = String.fromCodePoint(rs[i + 1]);
        add({ display: ch, spoken: ch, line: lineNo, col, plain: true });
        i += 2;
      } else if (r === 0x3c) {
        const [display, spoken, next] = parseAlternative(rs, i, lineNo);
        add({ display, spoken, line: lineNo, col, plain: false });
        i = next;
      } else if (r === 0x40 && i + 1 < rs.length && rs[i + 1] === 0x7b) {
        const end = indexRune(rs, i + 2, 0x7d);
        if (end < 0) throw new ParseError(lineNo, col, '短语标记缺少 }');
        const body = runeString(rs.slice(i + 2, end));
        if (body.startsWith('/')) {
          const id = body.slice(1);
          if (stack.length === 0) throw new ParseError(lineNo, col, `@{/${id}} 没有对应的 @{${id}}`);
          const top = stack[stack.length - 1];
          if (top.id !== id) {
            throw new ParseError(lineNo, col, `@{/${id}} 与未闭合的 @{${top.id}}（第 ${top.line} 行第 ${top.col} 列）交叉：短语只能嵌套，不能交叉`);
          }
          stack.pop();
          if (top.startPiece === s.pieces.length) throw new ParseError(top.line, top.col, `短语 ${id} 是空的`);
          s.phrases.push({ id, startPiece: top.startPiece, endPiece: s.pieces.length, line: top.line, col: top.col, order: 0 });
        } else {
          if (!phraseIDPattern.test(body)) {
            throw new ParseError(lineNo, col, `短语 id ${goQuote(body)} 不合法：只能用小写字母、数字、_ 和 -，且以字母或数字开头`);
          }
          if (seen.has(body)) throw new ParseError(lineNo, col, `短语 id ${body} 重复`);
          seen.add(body);
          stack.push({ id: body, startPiece: s.pieces.length, line: lineNo, col });
        }
        i = end + 1;
      } else {
        const ch = String.fromCodePoint(r);
        add({ display: ch, spoken: ch, line: lineNo, col, plain: true });
        i++;
      }
    }
  });
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    throw new ParseError(top.line, top.col, `短语 @{${top.id}} 没有闭合`);
  }
  resolveSoftBreaks(s);
  sortPhrases(s);
  tokenizeScript(s);
  return s;
}

function isEscapable(r: number): boolean {
  return r === 0x3c || r === 0x3e || r === 0x40 || r === 0x7c || r === 0x5c;
}

function indexRune(rs: number[], from: number, target: number): number {
  for (let i = from; i < rs.length; i++) if (rs[i] === target) return i;
  return -1;
}

/** parseAlternative 解析从 rs[start] == '<' 开始的 <显示|朗读>，返回下一个待读下标。 */
function parseAlternative(rs: number[], start: number, lineNo: number): [string, string, number] {
  const parts: [number[], number[]] = [[], []];
  let part = 0;
  for (let i = start + 1; i < rs.length; i++) {
    const r = rs[i];
    switch (r) {
      case 0x5c:
        if (i + 1 >= rs.length || !isEscapable(rs[i + 1])) throw new ParseError(lineNo, i + 1, badEscape);
        parts[part].push(rs[i + 1]);
        i++;
        break;
      case 0x7c:
        if (part === 1) throw new ParseError(lineNo, i + 1, '<显示|朗读> 里只能有一个 |，字面的 | 写成 \\|');
        part = 1;
        break;
      case 0x3c:
        throw new ParseError(lineNo, i + 1, '<显示|朗读> 不能嵌套，字面的 < 写成 \\<');
      case 0x3e: {
        if (part === 0) throw new ParseError(lineNo, start + 1, '<显示|朗读> 缺少 |；字面的 < 写成 \\<');
        const display = runeString(parts[0]);
        const spoken = runeString(parts[1]);
        if (display === '' && spoken === '') throw new ParseError(lineNo, start + 1, '<|> 两侧都是空的');
        return [display, spoken, i + 1];
      }
      default:
        parts[part].push(r);
    }
  }
  throw new ParseError(lineNo, start + 1, '<显示|朗读> 没有在本行闭合');
}

/** resolveSoftBreaks 把段内换行变成空格或什么都不是：只有两侧都是字母数字时才需要空格。 */
function resolveSoftBreaks(s: Script): void {
  for (let i = 0; i < s.pieces.length; i++) {
    if (!s.pieces[i].softBreak || i === 0 || i + 1 >= s.pieces.length) continue;
    const before = runes(s.pieces[i - 1].spoken);
    const after = runes(s.pieces[i + 1].spoken);
    if (before.length > 0 && after.length > 0 && isWordRune(normRune(before[before.length - 1])) && isWordRune(normRune(after[0]))) {
      s.pieces[i].display = ' ';
      s.pieces[i].spoken = ' ';
    }
  }
}

/** sortPhrases 按开始位置排出现顺序；同一位置开始的按开标记先后（外层在前）。 */
function sortPhrases(s: Script): void {
  // 闭合顺序是内层先、外层后，这里按开始 piece 稳定排序后外层仍可能排在后面，
  // 所以同位置时按开标记的行列再排一次。
  const phrases = s.phrases;
  for (let i = 1; i < phrases.length; i++) {
    for (let j = i; j > 0 && phraseBefore(phrases[j], phrases[j - 1]); j--) {
      [phrases[j], phrases[j - 1]] = [phrases[j - 1], phrases[j]];
    }
  }
  phrases.forEach((p, i) => (p.order = i + 1));
}

function phraseBefore(a: PhraseSpan, b: PhraseSpan): boolean {
  if (a.startPiece !== b.startPiece) return a.startPiece < b.startPiece;
  if (a.line !== b.line) return a.line < b.line;
  return a.col < b.col;
}

/** tokenize 按段切出朗读侧单元，并记下每个单元覆盖的 piece。 */
function tokenizeScript(s: Script): void {
  s.pieceToken = new Array<number>(s.pieces.length).fill(-1);
  for (let start = 0; start < s.pieces.length; ) {
    let end = start;
    while (end < s.pieces.length && s.pieces[end].para === s.pieces[start].para) end++;
    const rs: number[] = [];
    const owner: number[] = [];
    for (let p = start; p < end; p++) {
      for (const r of runes(s.pieces[p].spoken)) {
        rs.push(r);
        owner.push(p);
      }
    }
    for (const sp of tokenizeRunes(rs)) {
      const first = owner[sp.start];
      const last = owner[sp.end - 1];
      if (s.pieceToken[first] < 0) s.pieceToken[first] = s.tokens.length;
      s.tokens.push({
        text: runeString(rs.slice(sp.start, sp.end)),
        norm: normalizeRunes(rs.slice(sp.start, sp.end)),
        firstPiece: first,
        lastPiece: last,
        line: s.pieces[first].line,
        col: s.pieces[first].col,
      });
    }
    start = end;
  }
}
