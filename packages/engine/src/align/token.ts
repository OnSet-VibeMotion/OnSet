// Package align 把强制对齐工具的逐字时间戳映射回终稿原文，产出句级字幕与短语时间轴。
// 移植自 internal/align。
//
// 过去这一步由操作者手工完成：对齐工具只认送进 TTS 的文本（年份写成逐位汉字、
// 英文缩写拆成字母），输出的又是丢了标点的逐字时间，要「按替换清单映射回终稿
// 原文」「按顺序逐字对回」，再手写 phrase-timeline.json。几千个字靠眼睛对，
// 错一个字后面整串错位，而且错得悄无声息。
//
// 本包把映射交给代码：终稿用轻量标记同时写出显示文本与朗读文本，朗读文本送
// TTS 与对齐；对齐结果与朗读文本做动态规划匹配（移植自 hypit 的
// speech-alignment），每个朗读单元都带着匹配标签，漏读、多读、读错都进报告。
//
// 文本在本包里按码点（Go 的 rune）处理：runes() 把字符串拆成码点数组，
// 下标与 Go 的 []rune 下标一一对应。

/** Token 是一个匹配单元：一个汉字，或一串连续的字母数字（一个英文词、一个数）。 */
export interface Token {
  /** text 是原样文本，norm 是用于比对的规范化文本（全角转半角、小写、去掉词内连接符）。 */
  text: string;
  norm: string;
}

/** span 是 tokenize 在码点序列里找到的一个单元，左闭右开。 */
export interface Span {
  start: number;
  end: number;
}

/** 字符串 → 码点数组（Go 的 []rune）。 */
export function runes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}

/** 码点数组 → 字符串（Go 的 string([]rune)）。 */
export function runeString(rs: number[]): string {
  let out = '';
  for (const r of rs) out += String.fromCodePoint(r);
  return out;
}

const cjkPattern = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const letterPattern = /^\p{L}$/u;
const digitPattern = /^\p{Nd}$/u;
const markPattern = /^\p{Mn}$/u;

/** unicode.IsLetter。 */
export function isLetter(r: number): boolean {
  if (r < 0x80) return (r >= 0x41 && r <= 0x5a) || (r >= 0x61 && r <= 0x7a);
  return letterPattern.test(String.fromCodePoint(r));
}

/** unicode.IsDigit。 */
export function isDigit(r: number): boolean {
  if (r < 0x80) return r >= 0x30 && r <= 0x39;
  return digitPattern.test(String.fromCodePoint(r));
}

function isMark(r: number): boolean {
  return r >= 0x300 && markPattern.test(String.fromCodePoint(r));
}

/** isCJK 判断是否按单字成词：汉字、假名、谚文。 */
export function isCJK(r: number): boolean {
  return r >= 0x1100 && cjkPattern.test(String.fromCodePoint(r));
}

/**
 * unicode.ToLower：逐码点一对一映射。JS 的 toLowerCase 可能把一个字符变成多个
 * （İ → i̇），那种情况按 Go 的单码点映射处理：İ → i，其余保持原样。
 */
export function toLower(r: number): number {
  if (r < 0x80) return r >= 0x41 && r <= 0x5a ? r + 0x20 : r;
  if (r === 0x130) return 0x69;
  const lower = String.fromCodePoint(r).toLowerCase();
  const cps = runes(lower);
  return cps.length === 1 ? cps[0] : r;
}

/**
 * normRune 把全角 ASCII 转成半角并转小写。只做逐码点的一对一映射，
 * 保证规范化前后下标不变，单元位置可以直接回指原文。
 */
export function normRune(r: number): number {
  if (r >= 0xff01 && r <= 0xff5e) r -= 0xfee0;
  else if (r === 0x3000) r = 0x20;
  return toLower(r);
}

/** isWordRune 是可以组成英文词或数的字符（非 CJK 的字母、数字）。 */
export function isWordRune(r: number): boolean {
  return !isCJK(r) && (isLetter(r) || isDigit(r));
}

/** isJoiner 是词内连接符：3.5、GPT-4、don't 里的那个字符，只在两侧都是字母数字时算词内。 */
function isJoiner(r: number): boolean {
  return r === 0x27 || r === 0x2e || r === 0x2d || r === 0x2019;
}

/** tokenize 在码点序列中切出匹配单元。标点和空白不成单元。 */
export function tokenizeRunes(rs: number[]): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < rs.length; ) {
    const r = normRune(rs[i]);
    if (isCJK(r)) {
      spans.push({ start: i, end: i + 1 });
      i++;
    } else if (isWordRune(r)) {
      let j = i + 1;
      while (j < rs.length) {
        const next = normRune(rs[j]);
        if (isWordRune(next)) {
          j++;
          continue;
        }
        if (isJoiner(next) && j + 1 < rs.length && isWordRune(normRune(rs[j + 1]))) {
          j += 2;
          continue;
        }
        break;
      }
      spans.push({ start: i, end: j });
      i = j;
    } else {
      i++;
    }
  }
  return spans;
}

/** normalize 返回比对用文本：逐码点规范化后只保留字母与数字。 */
export function normalizeRunes(rs: number[]): string {
  const out: number[] = [];
  for (let r of rs) {
    r = normRune(r);
    if (isLetter(r) || isDigit(r) || isMark(r)) out.push(r);
  }
  return runeString(out);
}

/** Tokenize 把一段文本切成匹配单元。 */
export function tokenize(text: string): Token[] {
  const rs = runes(text);
  return tokenizeRunes(rs).map((s) => ({ text: runeString(rs.slice(s.start, s.end)), norm: normalizeRunes(rs.slice(s.start, s.end)) }));
}

/** unicode.IsSpace（与 strings.TrimSpace 同一个空白集合）。 */
export function isSpace(r: number): boolean {
  switch (r) {
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x20:
    case 0x85:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true;
  }
  return r >= 0x2000 && r <= 0x200a;
}
