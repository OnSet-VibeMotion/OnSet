import fs from 'node:fs';
import path from 'node:path';
import { hasRoster } from '../cast/roster';
import { goPathError, goQuote, goTrimSpace } from '../gofmt';
import {
  type Heading,
  isVocalEvent,
  ParseError,
  type PhraseSpan,
  type Piece,
  Script,
  type ScriptToken,
  search,
  stripVocalEvents,
  trimLeftSet,
  trimRightSet,
  VocalEvents,
} from './script_model';
import { isWordRune, normalizeRunes, normRune, runeString, runes, tokenizeRunes } from './token';

export {
  type Heading,
  isVocalEvent,
  ParseError,
  type PhraseSpan,
  type Piece,
  Script,
  type ScriptToken,
  search,
  stripVocalEvents,
  trimLeftSet,
  trimRightSet,
  VocalEvents,
};

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
const badEscape = '无效转义：只能转义 \\< \\> \\@ \\| \\\\ \\#';

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
    } catch {
      /* loadScript reports file errors using the original path. */
    }
  }
  return loadScript(file, dialogue);
}

interface OpenPhrase {
  id: string;
  startPiece: number;
  line: number;
  col: number;
}

/** ParseScript 解析终稿标记。 */
export function parseScript(text: string, dialogue = false): Script {
  const s = new Script();
  if (text.startsWith(String.fromCodePoint(0xfeff))) text = text.slice(1);
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
    if (paraHasContent) {
      s.pieces.push({ display: '', spoken: '', line: lineNo, col: 1, para, plain: false, softBreak: true });
    }
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
            throw new ParseError(
              lineNo,
              col,
              `@{/${id}} 与未闭合的 @{${top.id}}（第 ${top.line} 行第 ${top.col} 列）交叉：短语只能嵌套，不能交叉`,
            );
          }
          stack.pop();
          if (top.startPiece === s.pieces.length) throw new ParseError(top.line, top.col, `短语 ${id} 是空的`);
          s.phrases.push({
            id,
            startPiece: top.startPiece,
            endPiece: s.pieces.length,
            line: top.line,
            col: top.col,
            order: 0,
          });
        } else {
          if (!phraseIDPattern.test(body)) {
            throw new ParseError(
              lineNo,
              col,
              `短语 id ${goQuote(body)} 不合法：只能用小写字母、数字、_ 和 -，且以字母或数字开头`,
            );
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
          if (bare) {
            throw new ParseError(lineNo, col, `声音事件 ${bare} 要写成 <|${bare}>：直接写会原样出现在字幕里`);
          }
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
        if (i + 1 >= rs.length || !isEscapable(rs[i + 1]))
          throw new ParseError(lineNo, columnOffset + i + 1, badEscape);
        parts[part].push(rs[i + 1]);
        i++;
        break;
      case 0x7c:
        if (part === 1)
          throw new ParseError(lineNo, columnOffset + i + 1, '<显示|朗读> 里只能有一个 |，字面的 | 写成 \\|');
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
    if (
      before.length > 0 &&
      after.length > 0 &&
      isWordRune(normRune(before[before.length - 1])) &&
      isWordRune(normRune(after[0]))
    ) {
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
