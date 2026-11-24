import { goTrimSpace } from '../gofmt';
import type { Token } from './token';

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
export const VocalEvents: readonly string[] = [
  '[笑]',
  '[叹气]',
  '[咳嗽]',
  '[清嗓子]',
  '(laugh)',
  '(sigh)',
  '(cough)',
  '(clears throat)',
];

const vocalEventPattern = /^(\[[^\[\]\s]{1,10}\]|\([a-z][a-z ]{0,30}\))$/;
const vocalEventGlobalPattern = /(\[[^\[\]\s]{1,10}\]|\([a-z][a-z ]{0,30}\))/g;

/** 朗读侧整段是一个声音事件。 */
export function isVocalEvent(spoken: string): boolean {
  return vocalEventPattern.test(spoken);
}

/** 去掉送入 TTS 文本中的声音事件标记（与 alignText() 的剔除规则保持一致）。 */
export function stripVocalEvents(text: string): string {
  return text.replace(vocalEventGlobalPattern, '');
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
