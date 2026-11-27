import { LabelExact, LabelMerge, LabelSplit, matchTokens } from './match';
import { round3 } from './phrase';
import { type PhraseSpan, type Script, type ScriptToken, trimLeftSet, trimRightSet } from './script';
import { evidenceTokens, locate, type TimedToken } from './timing';
import { normalizeRunes, runeString, runes, tokenizeRunes } from './token';

export interface CharacterTime {
  start: number;
  end: number;
}

export interface DisplayCueInput {
  text: string;
  start_seconds: number;
  end_seconds: number;
}

export interface DisplayCueAlignment {
  blocks: ViewBlock[];
  tokens: number;
  match_rate: number;
  interpolated_tokens: number;
  speech_start_seconds: number;
  speech_end_seconds: number;
}

/**
 * ViewBlock 是终稿给人看的一块：标题或一段正文。kind 为 heading 或 para。
 * 字段按 Go 的 omitempty：level 为 0、text 为空、nodes 为空时不出现。
 */
export interface ViewBlock {
  kind: string;
  level?: number;
  text?: string;
  nodes?: ViewNode[];
  speaker?: string;
  time?: CharacterTime;
}

/**
 * ViewNode 是正文里的一段：
 *
 *	text    普通文字（显示即朗读）
 *	alt     <显示|朗读>，text 是显示侧，spoken 是朗读侧；两侧之一可以为空
 *	phrase  受保护短语 @{ID}…@{/ID}，内容在 children 里，可以嵌套
 *
 * 空值字段不出现（Go 的 omitempty）。
 */
export interface ViewNode {
  kind: string;
  text?: string;
  spoken?: string;
  id?: string;
  children?: ViewNode[];
  /** 跟读用的显示字符时间；标点与没有朗读的字为 null。按 Unicode 字符计数。 */
  timings?: (CharacterTime | null)[];
}

/**
 * ViewStats 是终稿的规模：朗读单元数（一个汉字、一个英文词或一个数算一个）、
 * 段数与受保护短语数。
 */
export interface ViewStats {
  units: number;
  paragraphs: number;
  phrases: number;
}

/** 构造期的节点：字段齐全，最后经 finish 去掉空值。 */
interface Draft {
  kind: string;
  text: string;
  spoken: string;
  id: string;
  children: Draft[];
  timings?: (CharacterTime | null)[];
}

const draft = (kind: string, fields: Partial<Draft> = {}): Draft => ({
  kind,
  text: '',
  spoken: '',
  id: '',
  children: [],
  ...fields,
});

function finish(d: Draft): ViewNode {
  const out: ViewNode = { kind: d.kind };
  if (d.text !== '') out.text = d.text;
  if (d.spoken !== '') out.spoken = d.spoken;
  if (d.id !== '') out.id = d.id;
  if (d.children.length > 0) out.children = d.children.map(finish);
  if (d.timings) out.timings = d.timings;
  return out;
}

/**
 * View 把解析后的终稿整理成给人读的结构：保留标题与分段，标记原样标出，不丢任何
 * 一处显示与朗读的差别。短语跨段时在每段里各标一次。
 */
export function view(s: Script, timed?: TimedToken[]): { blocks: ViewBlock[]; stats: ViewStats } {
  const times = timed ? pieceTimes(s, timed) : undefined;
  const stats: ViewStats = { units: s.tokens.length, paragraphs: 0, phrases: s.phrases.length };
  const blocks: ViewBlock[] = [];
  let nextHeading = 0;
  const flushHeadings = (upTo: number): void => {
    while (nextHeading < s.headings.length && s.headings[nextHeading].atPiece <= upTo) {
      const h = s.headings[nextHeading];
      const block: ViewBlock = { kind: 'heading' };
      if (h.level !== 0) block.level = h.level;
      if (h.text !== '') block.text = h.text;
      blocks.push(block);
      nextHeading++;
    }
  };
  for (let start = 0; start < s.pieces.length; ) {
    let end = start;
    while (end < s.pieces.length && s.pieces[end].para === s.pieces[start].para) end++;
    flushHeadings(start);
    const nodes = viewNodes(s, start, end, times);
    const block: ViewBlock = { kind: 'para' };
    const speaker = s.speakers.get(s.pieces[start].para);
    if (speaker) block.speaker = speaker;
    if (nodes.length > 0) block.nodes = nodes;
    blocks.push(block);
    stats.paragraphs++;
    start = end;
  }
  flushHeadings(s.pieces.length);
  return { blocks, stats };
}

/** viewNodes 把 piece 区间 [from, to) 排成节点树。短语按嵌套关系开合，越过区间边界的截断。 */
function viewNodes(s: Script, from: number, to: number, times?: (CharacterTime | null)[][]): ViewNode[] {
  const spans: PhraseSpan[] = s.phrases.filter((p) => p.startPiece < to && p.endPiece > from);
  // 外层在前：开始早的在前，同一处开始的结束晚的在前。（Array.prototype.sort 是稳定排序，同 sort.SliceStable。）
  spans.sort((a, b) => {
    const sa = Math.max(a.startPiece, from);
    const sb = Math.max(b.startPiece, from);
    if (sa !== sb) return sa - sb;
    return b.endPiece - a.endPiece;
  });

  const root = draft('');
  const stack: { node: Draft; end: number }[] = [{ node: root, end: to }];
  let next = 0;
  const appendText = (parent: Draft, text: string, timings?: (CharacterTime | null)[]): void => {
    if (text === '') return;
    const n = parent.children.length;
    if (n > 0 && parent.children[n - 1].kind === 'text') {
      parent.children[n - 1].text += text;
      if (timings) parent.children[n - 1].timings!.push(...timings);
      return;
    }
    parent.children.push(draft('text', { text, timings }));
  };
  const closeTop = (): void => {
    const top = stack.pop()!;
    stack[stack.length - 1].node.children.push(top.node);
  };
  for (let p = from; p < to; p++) {
    while (stack.length > 1 && stack[stack.length - 1].end <= p) closeTop();
    while (next < spans.length && Math.max(spans[next].startPiece, from) === p) {
      stack.push({ node: draft('phrase', { id: spans[next].id }), end: spans[next].endPiece });
      next++;
    }
    const parent = stack[stack.length - 1].node;
    const piece = s.pieces[p];
    if (piece.softBreak || piece.plain) appendText(parent, piece.display, times?.[p]);
    else parent.children.push(draft('alt', { text: piece.display, spoken: piece.spoken, timings: times?.[p] }));
  }
  while (stack.length > 1) closeTop();
  const nodes = root.children;
  // 段首段尾的空白不显示。
  if (nodes.length > 0 && nodes[0].kind === 'text') {
    const node = nodes[0],
      text = trimLeftSet(node.text, ' \t　');
    node.timings = node.timings?.slice([...node.text].length - [...text].length);
    node.text = text;
  }
  if (nodes.length > 0 && nodes[nodes.length - 1].kind === 'text') {
    const node = nodes[nodes.length - 1];
    node.text = trimRightSet(node.text, ' \t　');
    node.timings = node.timings?.slice(0, [...node.text].length);
  }
  return nodes.map(finish);
}

/** 先回到源稿 piece，再映射显示字符，避免年份、读音标记和嵌套短语把后文高亮错位。 */
function pieceTimes(s: Script, timed: TimedToken[]): (CharacterTime | null)[][] {
  const spans: (CharacterTime | undefined)[] = new Array(s.pieces.length);
  for (const token of timed) {
    if (token.interpolated || token.end <= token.start) continue;
    const count = token.lastPiece - token.firstPiece + 1;
    for (let p = token.firstPiece; p <= token.lastPiece; p++) {
      const start = token.start + ((token.end - token.start) * (p - token.firstPiece)) / count;
      const end = token.start + ((token.end - token.start) * (p - token.firstPiece + 1)) / count;
      spans[p] = spans[p]
        ? { start: Math.min(spans[p]!.start, start), end: Math.max(spans[p]!.end, end) }
        : { start, end };
    }
  }
  return s.pieces.map((piece, index) => {
    const chars = [...(piece.display || piece.spoken)];
    const span = spans[index];
    return chars.map((_, i) =>
      span
        ? {
            start: span.start + ((span.end - span.start) * i) / chars.length,
            end: span.start + ((span.end - span.start) * (i + 1)) / chars.length,
          }
        : null,
    );
  });
}

function tokenizeDisplay(s: Script): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  for (let start = 0; start < s.pieces.length; ) {
    let end = start;
    while (end < s.pieces.length && s.pieces[end].para === s.pieces[start].para) end++;
    const rs: number[] = [];
    const owner: number[] = [];
    for (let p = start; p < end; p++) {
      if (s.pieces[p].display === '') continue;
      for (const r of runes(s.pieces[p].display)) {
        rs.push(r);
        owner.push(p);
      }
    }
    for (const sp of tokenizeRunes(rs)) {
      const first = owner[sp.start];
      const last = owner[sp.end - 1];
      tokens.push({
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
  return tokens;
}

/**
 * 把句级字幕（显示侧文本 + 起止秒数）匹配回终稿 piece 并生成逐字时间。
 * 当字级 align.json 缺失但已有 voice.srt 时，供口播稿页保持句级精确同步。
 */
export function alignDisplayCues(s: Script, cues: DisplayCueInput[]): DisplayCueAlignment | null {
  const displayTokens = tokenizeDisplay(s);
  if (displayTokens.length === 0 || cues.length === 0) return null;
  const items: { text: string; start: number; end: number; segment: number }[] = [];
  let prevStart = 0;
  for (const cue of cues) {
    if (
      !Number.isFinite(cue.start_seconds) ||
      !Number.isFinite(cue.end_seconds) ||
      cue.start_seconds < 0 ||
      cue.end_seconds < cue.start_seconds ||
      cue.start_seconds < prevStart - 0.05
    ) {
      return null;
    }
    prevStart = cue.start_seconds;
    if (cue.end_seconds > cue.start_seconds && cue.text.trim() !== '') {
      items.push({ text: cue.text, start: cue.start_seconds, end: cue.end_seconds, segment: 0 });
    }
  }
  const evidence = evidenceTokens(items);
  if (evidence.length === 0) return null;
  const groups = matchTokens(
    displayTokens.map((t) => t.norm),
    evidence.map((e) => e.norm),
  );
  const timed = locate(displayTokens, evidence, groups);
  let matched = 0;
  let interpolated = 0;
  for (const t of timed) {
    if (t.label === LabelExact || t.label === LabelSplit || t.label === LabelMerge) matched++;
    if (t.interpolated) interpolated++;
  }
  let speechStart = evidence[0].start;
  let speechEnd = evidence[0].end;
  for (const e of evidence) {
    speechStart = Math.min(speechStart, e.start);
    speechEnd = Math.max(speechEnd, e.end);
  }
  if (speechEnd <= speechStart) return null;
  return {
    blocks: view(s, timed).blocks,
    tokens: timed.length,
    match_rate: round3(matched / timed.length),
    interpolated_tokens: interpolated,
    speech_start_seconds: speechStart,
    speech_end_seconds: speechEnd,
  };
}
