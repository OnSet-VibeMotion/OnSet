// Go encoding/xml 的 Decoder（Strict 模式）在本包用得到的那一部分：逐个读出起止标签、
// 起始标签结束处的偏移（InputOffset），以及 DecodeElement 读字符串的行为。只供本包内部使用。
//
// 没有用现成的 XML 库：rig 的校验与姿势注入都依赖「Go 认为这是不是合法 XML」与
// 「起始标签在源码里的结束位置」，两者都要和 Go 版一致，否则同一份 rig 在两边一个通过一个报错。

export interface XmlName {
  /** 冒号前的前缀（Go 里是翻译后的命名空间；这里不翻译，只用来比对起止标签）。 */
  space: string;
  local: string;
}

export interface XmlAttr {
  name: XmlName;
  value: string;
}

export interface StartElement {
  kind: 'start';
  name: XmlName;
  attrs: XmlAttr[];
}

export interface EndElement {
  kind: 'end';
  name: XmlName;
}

export interface CharData {
  kind: 'chardata';
  data: string;
}

export interface OtherToken {
  kind: 'comment' | 'procinst' | 'directive';
}

export type XmlToken = StartElement | EndElement | CharData | OtherToken;

/** Go 的 *xml.SyntaxError：「XML syntax error on line N: …」。 */
export class XmlSyntaxError extends Error {
  constructor(
    readonly msg: string,
    readonly line: number,
  ) {
    super(`XML syntax error on line ${line}: ${msg}`);
  }
}

const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };

function isNameChar(c: string): boolean {
  const code = c.charCodeAt(0);
  if (code >= 0x80) return true;
  return /[A-Za-z0-9_:.-]/.test(c);
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\r' || c === '\n' || c === '\t';
}

function inCharacterRange(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function splitName(s: string): XmlName {
  const i = s.indexOf(':');
  if (i < 1 || i > s.length - 2) return { space: '', local: s };
  return { space: s.slice(0, i), local: s.slice(i + 1) };
}

export class XmlDecoder {
  private pos = 0;
  private line = 1;
  private err: Error | null = null;
  private stack: XmlName[] = [];
  private pendingEnd: XmlName | null = null;

  constructor(private readonly src: string) {}

  /** 已读过的位置（字符串下标）。读完一个起始标签后指向它的 ">" 之后。 */
  inputOffset(): number {
    return this.pos;
  }

  private fail(msg: string): never {
    // 读到末尾时 Go 的 syntaxError 都写成 unexpected EOF。
    const error = new XmlSyntaxError(msg, this.line);
    this.err = error;
    throw error;
  }

  private getc(): string {
    if (this.pos >= this.src.length) this.fail('unexpected EOF');
    const c = this.src[this.pos++];
    if (c === '\n') this.line++;
    return c;
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private ungetc(c: string): void {
    this.pos--;
    if (c === '\n') this.line--;
  }

  /** 下一个 token；读完返回 null。出错后一直抛同一个错误（Go 的 Decoder 错误是粘滞的）。 */
  token(): XmlToken | null {
    if (this.err) throw this.err;
    if (this.pendingEnd) {
      const name = this.pendingEnd;
      this.pendingEnd = null;
      this.popElement(name);
      return { kind: 'end', name };
    }
    if (this.pos >= this.src.length) {
      if (this.stack.length > 0) this.fail('unexpected EOF');
      return null;
    }
    const c = this.getc();
    if (c !== '<') {
      this.ungetc(c);
      return { kind: 'chardata', data: this.text(-1, false) };
    }
    const b = this.getc();
    if (b === '/') {
      const name = this.readName();
      if (name === null) this.fail('expected element name after </');
      this.skipSpace();
      if (this.getc() !== '>') this.fail('invalid characters between </' + name + ' and >');
      const parsed = splitName(name);
      this.popElement(parsed);
      return { kind: 'end', name: parsed };
    }
    if (b === '?') {
      const target = this.readName();
      if (target === null) this.fail('expected target name after <?');
      let content = '';
      let prev = '';
      for (;;) {
        const ch = this.getc();
        content += ch;
        if (prev === '?' && ch === '>') break;
        prev = ch;
      }
      content = content.slice(0, -2);
      if (target === 'xml') {
        const ver = procInstParam('version', content);
        if (ver !== '' && ver !== '1.0') this.fail(`unsupported version "${ver}"; only version 1.0 is supported`);
        const enc = procInstParam('encoding', content);
        if (enc !== '' && enc.toLowerCase() !== 'utf-8') {
          const error = new Error(`xml: encoding "${enc}" declared but Decoder.CharsetReader is nil`);
          this.err = error;
          throw error;
        }
      }
      return { kind: 'procinst' };
    }
    if (b === '!') {
      const next = this.getc();
      if (next === '-') {
        if (this.getc() !== '-') this.fail('invalid sequence <!- not part of <!--');
        let b0 = '';
        let b1 = '';
        for (;;) {
          const ch = this.getc();
          if (b0 === '-' && b1 === '-') {
            if (ch !== '>') this.fail('invalid sequence "--" not allowed in comments');
            break;
          }
          b0 = b1;
          b1 = ch;
        }
        return { kind: 'comment' };
      }
      if (next === '[') {
        for (const want of 'CDATA[') {
          if (this.getc() !== want) this.fail('invalid <![ sequence');
        }
        return { kind: 'chardata', data: this.text(-1, true) };
      }
      // <!DOCTYPE …>：跳过，注意引号与嵌套的 < >。
      let depth = 1;
      let quote = '';
      for (;;) {
        const ch = this.getc();
        if (quote) {
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '<') depth++;
        else if (ch === '>') {
          depth--;
          if (depth === 0) break;
        }
      }
      return { kind: 'directive' };
    }
    this.ungetc(b);
    const rawName = this.readName();
    if (rawName === null) this.fail('expected element name after <');
    const name = splitName(rawName);
    const attrs: XmlAttr[] = [];
    let empty = false;
    for (;;) {
      this.skipSpace();
      const ch = this.getc();
      if (ch === '/') {
        empty = true;
        if (this.getc() !== '>') this.fail('expected /> in element');
        break;
      }
      if (ch === '>') break;
      this.ungetc(ch);
      const attrName = this.readName();
      if (attrName === null) this.fail('expected attribute name in element');
      this.skipSpace();
      const eq = this.getc();
      if (eq !== '=') this.fail('attribute name without = in element');
      this.skipSpace();
      const value = this.attrValue();
      attrs.push({ name: splitName(attrName), value });
    }
    this.stack.push(name);
    if (empty) this.pendingEnd = name;
    return { kind: 'start', name, attrs };
  }

  /**
   * Go 的 DecodeElement(&s, &start)（s 是 string）：读到 start 对应的结束标签为止，
   * 只拼接它的直接字符数据，子元素整段跳过。
   */
  decodeElementText(): string {
    let data = '';
    for (;;) {
      const tok = this.token();
      if (tok === null) this.fail('unexpected EOF');
      if (tok.kind === 'start') this.skip();
      else if (tok.kind === 'chardata') data += tok.data;
      else if (tok.kind === 'end') return data;
    }
  }

  /** 跳过当前元素剩下的部分（Go 的 Decoder.Skip）。 */
  private skip(): void {
    for (;;) {
      const tok = this.token();
      if (tok === null) this.fail('unexpected EOF');
      if (tok.kind === 'start') this.skip();
      else if (tok.kind === 'end') return;
    }
  }

  private popElement(name: XmlName): void {
    const top = this.stack.pop();
    if (!top) this.fail('unexpected end element </' + name.local + '>');
    if (top.local !== name.local) this.fail('element <' + top.local + '> closed by </' + name.local + '>');
    if (top.space !== name.space) {
      this.fail('element <' + top.local + '> in space ' + top.space + ' closed by </' + name.local + '> in space ' + name.space);
    }
  }

  private skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (c === undefined || !isSpace(c)) return;
      this.getc();
    }
  }

  private readName(): string | null {
    const start = this.pos;
    if (this.pos >= this.src.length) this.fail('unexpected EOF');
    while (this.pos < this.src.length && isNameChar(this.src[this.pos])) this.pos++;
    if (this.pos === start) return null;
    const name = this.src.slice(start, this.pos);
    if (/^[0-9.-]/.test(name)) {
      this.fail('invalid XML name: ' + name);
    }
    return name;
  }

  private attrValue(): string {
    const c = this.getc();
    if (c !== '"' && c !== "'") this.fail('unquoted or missing attribute value in element');
    return this.text(c.charCodeAt(0), false);
  }

  /**
   * 读字符数据直到 quote（属性值）、"<"（正文）或 "]]>"（CDATA）。
   * 与 Go 一样把 \r\n 与单独的 \r 换成 \n，解开实体，拒绝非法字符。
   */
  private text(quote: number, cdata: boolean): string {
    let out = '';
    let b0 = '';
    let b1 = '';
    for (;;) {
      if (this.pos >= this.src.length) {
        if (cdata) this.fail('unexpected EOF in CDATA section');
        if (quote >= 0) this.fail('unexpected EOF');
        break;
      }
      const ch = this.getc();
      if (b0 === ']' && b1 === ']' && ch === '>') {
        if (cdata) {
          out = out.slice(0, -2);
          break;
        }
        this.fail('unescaped ]]> not in CDATA section');
      }
      if (ch === '<' && !cdata) {
        if (quote >= 0) this.fail('unescaped < inside quoted string');
        this.ungetc(ch);
        break;
      }
      if (quote >= 0 && ch.charCodeAt(0) === quote) break;
      let value = ch;
      if (ch === '&' && !cdata) {
        value = this.entity();
      } else if (ch === '\r') {
        value = '\n';
      } else if (ch === '\n' && b1 === '\r') {
        value = '';
      }
      b0 = b1;
      b1 = ch;
      for (const piece of value) {
        if (!inCharacterRange(piece.codePointAt(0)!)) this.fail('illegal character code U+' + piece.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      }
      out += value;
    }
    return out;
  }

  private entity(): string {
    const start = this.pos;
    let name = '';
    for (;;) {
      if (this.pos >= this.src.length) break;
      const ch = this.src[this.pos];
      if (ch === ';') break;
      if (!/[A-Za-z0-9#x]/.test(ch)) break;
      name += ch;
      this.pos++;
    }
    if (this.src[this.pos] === ';') {
      this.pos++;
      if (name in entities) return entities[name];
      const numeric = /^#(x[0-9a-fA-F]+|[0-9]+)$/.exec(name);
      if (numeric) {
        const code = numeric[1][0] === 'x' ? parseInt(numeric[1].slice(1), 16) : parseInt(numeric[1], 10);
        if (code <= 0x10ffff) return String.fromCodePoint(code);
      }
    }
    this.fail('invalid character entity &' + this.src.slice(start, this.pos));
  }
}

/** Go 的 procInst：从 <?xml …?> 的内容里取一个参数值。 */
function procInstParam(param: string, s: string): string {
  const match = new RegExp(`(?:^|\\s)${param}\\s*=\\s*(["'])(.*?)\\1`).exec(s);
  return match ? match[2] : '';
}
