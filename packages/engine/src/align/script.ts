import fs from 'node:fs';
import path from 'node:path';
import { hasRoster } from '../cast/roster';
import { goPathError, goQuote, goTrimSpace } from '../gofmt';
import { isWordRune, normRune, normalizeRunes, runeString, runes, tokenizeRunes, type Token } from './token';

// 终稿标记语法（production/script-final.md）：
//
//	<显示|朗读>         显示文本与朗读文本不同：<2024年|二零二四年>、<API|A P I>
//	<|嗯>               只朗读、不显示
//	<显示|>             只显示、不朗读（没有时间，随所在字幕）
//	@{id}……@{/id}       受保护短语，进 phrase-timeline.json；可以嵌套，不能交叉
//	# 开头的行          标题，忽略；正文要以 # 开头（话题 #OiiOii）时写 \#
//	空行                分段
//	\< \> \@ \| \\ \#   转义
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
  /** event 是声音事件（<|[笑]>）：送进 TTS，但不显示、不是朗读单元、不交给对齐工具。 */
  event?: boolean;
}

/**
 * 声音事件：Breeze TTS 2 读到这些写法时发出笑声、叹气这类非语音的声音（中文用方括号，英文用圆括号）。
 * 官方列出的是下面几个，写法上「如」字开头，所以 <|…> 里任何方括号或圆括号括起来的一小段都按事件处理；
 * 正文里直接写这几个则报错，免得它们出现在字幕里。
 *
 * 事件不交给对齐工具：2026-11 实测把「[叹气]」「[笑]」留在对齐文本里，对齐器会把「叹」「气」「笑」
 * 塞进几十毫秒、产生零长度的字；去掉之后每个字的位置一样准（笑声、叹气落在前后两个字之间的空档里）。
 */
export const VocalEvents: readonly string[] = ['[笑]', '[叹气]', '[咳嗽]', '[清嗓子]', '(laugh)', '(sigh)', '(cough)', '(clears throat)'];

const vocalEventPattern = /^(\[[^\[\]\s]{1,10}\]|\([a-z][a-z ]{0,30}\))$/;

/** 朗读侧整段是一个声音事件。 */
export function isVocalEvent(spoken: string): boolean {
  return vocalEventPattern.test(spoken);
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

const badEscape = '无效转义：只能转义 \\< \\> \\@ \\| \\\\ \\#';

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
  /** 对话体终稿中每段的说话人。角色不占正文位置，也不进朗读文本。 */
  speakers = new Map<number, string>();

  /**
   * SpokenText 返回送进 TTS 的文本：标记取朗读侧，标题行丢掉，标点保留；
   * 普通段间用单换行 `\n`，中间隔着 `#` 章节标题的段间留一个空行 `\n\n`，
   * 供 voice_synthesize 自动区分段间停顿与更长的章间停顿。
   */
  spokenText(): string {
    const headingAt = new Set(this.headings.map((h) => h.atPiece));
    const paras: { text: string; afterChapter: boolean }[] = [];
    let current = '';
    let pendingChapter = false;
    const flush = () => {
      const t = goTrimSpace(current);
      if (t !== '') {
        paras.push({ text: t, afterChapter: paras.length > 0 && pendingChapter });
        pendingChapter = false;
      }
      current = '';
    };
    this.pieces.forEach((p, i) => {
      if (i > 0 && p.para !== this.pieces[i - 1].para) flush();
      if (headingAt.has(i)) pendingChapter = true;
      current += p.spoken;
    });
    flush();
    if (paras.length === 0) return '';
    let out = paras[0].text;
    for (let i = 1; i < paras.length; i++) {
      out += (paras[i].afterChapter ? '\n\n' : '\n') + paras[i].text;
    }
    return out + '\n';
  }

  /**
   * alignText 返回交给强制对齐工具的文本：与 spokenText 相同，只是去掉声音事件——
   * 事件发出的是笑声、叹气，不是字，留着会让对齐工具把它们当字硬塞进去。
   */
  alignText(): string {
    let b = '';
    this.pieces.forEach((p, i) => {
      if (i > 0 && p.para !== this.pieces[i - 1].para) b += '\n';
      if (!p.event) b += p.spoken;
    });
    const out: string[] = [];
    for (const para of b.split('\n')) {
      const t = goTrimSpace(para.replace(/ {2,}/g, ' '));
      if (t !== '') out.push(t);
    }
    if (out.length === 0) return '';
    return out.join('\n') + '\n';
  }

  /** hasVocalEvents 表示终稿里写了声音事件。 */
  hasVocalEvents(): boolean {
    return this.pieces.some((p) => p.event);
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
export function loadScript(file: string, dialogue = false): Script {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`无法读取终稿：${goPathError('open', file, err)}`, { cause: err });
  }
  try {
    return parseScript(body, dialogue);
  } catch (err) {
    throw new Error(`${file} ${(err as Error).message}`, { cause: err });
  }
}

/** 项目终稿跟随班底设置，单独传入的对齐稿仍按普通文本解析。 */
export function loadProjectScript(root: string, file: string): Script {
  let dialogue = false;
  if (hasRoster(root)) {
    try {
      dialogue = fs.realpathSync(file) === fs.realpathSync(path.join(root, 'production/script-final.md'));
    } catch { /* loadScript reports file errors using the original path. */ }
  }
  return loadScript(file, dialogue);
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
export function parseScript(text: string, dialogue = false): Script {
  const s = new Script();
  if (text.startsWith('﻿')) text = text.slice(1);
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const stack: OpenPhrase[] = [];
  const seen = new Set<string>();
  let para = 0;
  let paraHasContent = false;
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    let line = trimRightSet(raw, '\r');
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
    let columnOffset = 0;
    if (dialogue) {
      const prefix = /^[ \t　]*([a-z][a-z0-9-]*)[ \t　]*[:：][ \t　]*/.exec(line);
      if (!prefix || line.slice(prefix[0].length).trim() === '') {
        throw new ParseError(lineNo, 1, '对白请写成「角色 id: 台词」，一行一轮发言');
      }
      const last = s.pieces.at(-1);
      if (stack.length && last && s.speakers.get(last.para) !== prefix[1]) {
        throw new ParseError(lineNo, 1, '受保护短语不能跨说话人');
      }
      if (paraHasContent) para++;
      paraHasContent = false;
      s.speakers.set(para, prefix[1]);
      columnOffset = prefix[0].length;
      line = line.slice(columnOffset);
    }
    if (paraHasContent) s.pieces.push({ display: '', spoken: '', line: lineNo, col: 1, para, plain: false, softBreak: true });
    paraHasContent = true;
    const rs = runes(line);
    const add = (p: Omit<Piece, 'para' | 'softBreak'>) => s.pieces.push({ ...p, para, softBreak: false });
    for (let i = 0; i < rs.length; ) {
      const col = columnOffset + i + 1;
      const r = rs[i];
      if (r === 0x5c) {
        if (i + 1 >= rs.length || !isEscapable(rs[i + 1])) throw new ParseError(lineNo, col, badEscape);
        const ch = String.fromCodePoint(rs[i + 1]);
        add({ display: ch, spoken: ch, line: lineNo, col, plain: true });
        i += 2;
      } else if (r === 0x3c) {
        const [display, spoken, next] = parseAlternative(rs, i, lineNo, columnOffset);
        const event = display === '' && isVocalEvent(spoken);
        add({ display, spoken, line: lineNo, col, plain: false, ...(event ? { event } : {}) });
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
        if (r === 0x5b || r === 0x28) {
          const rest = runeString(rs.slice(i));
          const bare = VocalEvents.find((e) => rest.startsWith(e));
          if (bare) throw new ParseError(lineNo, col, `声音事件 ${bare} 要写成 <|${bare}>：直接写会原样出现在字幕里`);
        }
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

/** \# 也能转义：行首的 # 会被当成标题整行丢掉，话题 #OiiOii 写在行首时要写成 \#OiiOii。 */
function isEscapable(r: number): boolean {
  return r === 0x3c || r === 0x3e || r === 0x40 || r === 0x7c || r === 0x5c || r === 0x23;
}

function indexRune(rs: number[], from: number, target: number): number {
  for (let i = from; i < rs.length; i++) if (rs[i] === target) return i;
  return -1;
}

/** parseAlternative 解析从 rs[start] == '<' 开始的 <显示|朗读>，返回下一个待读下标。 */
function parseAlternative(rs: number[], start: number, lineNo: number, columnOffset: number): [string, string, number] {
  const parts: [number[], number[]] = [[], []];
  let part = 0;
  for (let i = start + 1; i < rs.length; i++) {
    const r = rs[i];
    switch (r) {
      case 0x5c:
        if (i + 1 >= rs.length || !isEscapable(rs[i + 1])) throw new ParseError(lineNo, columnOffset + i + 1, badEscape);
        parts[part].push(rs[i + 1]);
        i++;
        break;
      case 0x7c:
        if (part === 1) throw new ParseError(lineNo, columnOffset + i + 1, '<显示|朗读> 里只能有一个 |，字面的 | 写成 \\|');
        part = 1;
        break;
      case 0x3c:
        throw new ParseError(lineNo, columnOffset + i + 1, '<显示|朗读> 不能嵌套，字面的 < 写成 \\<');
      case 0x3e: {
        if (part === 0) throw new ParseError(lineNo, columnOffset + start + 1, '<显示|朗读> 缺少 |；字面的 < 写成 \\<');
        const display = runeString(parts[0]);
        const spoken = runeString(parts[1]);
        if (display === '' && spoken === '') throw new ParseError(lineNo, columnOffset + start + 1, '<|> 两侧都是空的');
        return [display, spoken, i + 1];
      }
      default:
        parts[part].push(r);
    }
  }
  throw new ParseError(lineNo, columnOffset + start + 1, '<显示|朗读> 没有在本行闭合');
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
      // 声音事件不是朗读单元：配音里那一段是笑声、叹气，对齐结果里也没有它。
      if (s.pieces[p].event) continue;
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
