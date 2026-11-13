// 移植自 internal/determinism/strip.go。
//
// Go 版按字节处理，这里按 UTF-16 码元处理：所有判定字符（引号、斜杠、反斜杠、换行、标识符字符）
// 都是 ASCII，多字节字符在两边都只会被整体抹成空格或原样保留；偏移只在同一份 JS 字符串内换算行号，
// 与 Go 的行号一致。

/** blank 把 [start, end) 区间替换成空格，保留换行，使行号与偏移不变。 */
export function blank(text: string[], start: number, end: number): void {
  for (let i = start; i < end && i < text.length; i++) {
    if (text[i] !== '\n') {
      text[i] = ' ';
    }
  }
}

/**
 * lexJS 对 JS 源码做最小词法处理，返回两份与原文等长的文本：
 *
 *   - withStrings：剥掉注释，字符串原样保留。网络规则要看 fetch 的 URL 字面量。
 *   - codeOnly：再把字符串、模板字符串与正则字面量的内容也抹成空格。
 *     时钟、随机数等规则只在这份上匹配：画面文案写着「Date.now() 已禁用」
 *     不是违规，误判一次这道门就没人信了。
 *
 * 正则字面量必须识别：`/["']/` 里的引号会被当成字符串开头，把后面的注释整段
 * 吞掉，注释里提到的禁用 API 就成了违规。判定沿用常见启发式：`/` 前一个有效
 * 字符是运算符或开括号、或前一个词是 return 等关键字时，它开始一个正则。
 */
export function lexJS(source: string): { withStrings: string; codeOnly: string } {
  const text = source.split('');
  const code = source.split('');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i);
      blank(code, i + 1, end);
      i = end;
    } else if (c === '/' && i + 1 < text.length && text[i + 1] === '/') {
      let end = i;
      while (end < text.length && text[end] !== '\n') {
        end++;
      }
      blank(text, i, end);
      blank(code, i, end);
      i = end;
    } else if (c === '/' && i + 1 < text.length && text[i + 1] === '*') {
      let end = i + 2;
      while (end + 1 < text.length && !(text[end] === '*' && text[end + 1] === '/')) {
        end++;
      }
      end = Math.min(end + 2, text.length);
      blank(text, i, end);
      blank(code, i, end);
      i = end - 1;
    } else if (c === '/' && regexAllowed(text, i)) {
      const end = skipRegex(text, i);
      blank(code, i + 1, end);
      i = end;
    }
  }
  return { withStrings: text.join(''), codeOnly: code.join('') };
}

/** regexKeywords 之后的 `/` 开始正则而不是除号。 */
const regexKeywords = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await'];

/** regexAllowed 判断 pos 处的 `/` 是否开始一个正则字面量。 */
function regexAllowed(text: string[], pos: number): boolean {
  let j = pos - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) {
    j--;
  }
  if (j < 0 || text[j] === '\n') {
    return true;
  }
  if ('(,=:[!&|?{};+-*%<>~^'.includes(text[j])) {
    return true;
  }
  const end = j + 1;
  while (j >= 0 && isIdent(text[j])) {
    j--;
  }
  const word = text.slice(j + 1, end).join('');
  return regexKeywords.includes(word);
}

function isIdent(c: string): boolean {
  return c === '_' || c === '$' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * skipRegex 从开头的 `/` 跳到结尾的 `/`，字符类 [...] 里的 `/` 不算结尾。
 * 行内找不到结尾时退回到开头之后：说明判断错了，它其实是除号。
 */
function skipRegex(text: string[], start: number): number {
  let inClass = false;
  for (let i = start + 1; i < text.length; i++) {
    switch (text[i]) {
      case '\\':
        i++;
        break;
      case '[':
        inClass = true;
        break;
      case ']':
        inClass = false;
        break;
      case '/':
        if (!inClass) {
          return i;
        }
        break;
      case '\n':
        return start;
    }
  }
  return start;
}

/** skipString 从引号位置跳到字符串结尾，返回结尾引号的下标。 */
function skipString(text: string[], start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    switch (text[i]) {
      case '\\':
        i++;
        break;
      case quote:
        return i;
      case '\n':
        // 普通引号字符串不能跨行；未闭合时在行尾停下，避免吞掉后续代码。
        if (quote !== '`') {
          return i;
        }
        break;
    }
  }
  return text.length;
}

const htmlComment = /<!--[\s\S]*?-->/g;

/** stripHTMLComments 剥掉 HTML 注释，保留换行。 */
export function stripHTMLComments(source: string): string {
  const text = source.split('');
  for (const m of source.matchAll(htmlComment)) {
    blank(text, m.index, m.index + m[0].length);
  }
  return text.join('');
}

const cssComment = /\/\*[\s\S]*?\*\//g;

/** stripCSSComments 剥掉 CSS 块注释，保留换行。 */
export function stripCSSComments(source: string): string {
  const text = source.split('');
  for (const m of source.matchAll(cssComment)) {
    blank(text, m.index, m.index + m[0].length);
  }
  return text.join('');
}
