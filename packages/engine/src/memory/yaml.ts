// 记忆文件 frontmatter 的读写，按 gopkg.in/yaml.v3 的规则。只供本包内部使用。
//
// 写出：Go 版用 yaml.NewEncoder + SetIndent(2) 编码 Meta。记忆文件内容进快照、参与摘要，
// 用户已有的记忆库是 Go 写的，这里哪怕引号风格差一点，快照摘要就对不上、Drift 全报漂移。
// 所以照 yaml.v3 的 encode.go（何时必须加引号）与 emitterc.go（libyaml 的标量分析与
// 风格选择、双引号转义）移植了需要的那部分：字符串标量、字符串序列、一层嵌套映射。
// yaml.v3 的行宽是无限（best_width = -1），不折行。
//
// 读入：Decoder.KnownFields(true)，未知字段报错；任何标量都能进 string（取原文）。
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Document, type Node } from 'yaml';

// ---- 写出 ----

/** yaml.v3 emitterc.go 的 is_printable，按码点判断（Go 是按 UTF-8 字节）。 */
function isPrintable(c: number): boolean {
  if (c === 0x0a) return true;
  if (c >= 0x20 && c <= 0x7e) return true;
  if (c >= 0xa0 && c <= 0xd7ff) return true;
  if (c >= 0xe000 && c <= 0xfffd) return c !== 0xfeff;
  // 0x80–0x9F（C2 80–C2 9F）、代理区、四字节字符（emoji 等）都不算可打印：libyaml 只认 BMP。
  return false;
}

function isBreak(c: number): boolean {
  return c === 0x0d || c === 0x0a || c === 0x85 || c === 0x2028 || c === 0x2029;
}

function isBlankZ(c: number | undefined): boolean {
  return c === undefined || c === 0x20 || c === 0x09 || c === 0x00 || isBreak(c);
}

interface ScalarAnalysis {
  multiline: boolean;
  blockPlainAllowed: boolean;
  singleQuotedAllowed: boolean;
  blockAllowed: boolean;
}

/** yaml_emitter_analyze_scalar（flow_level 恒为 0，flow_plain_allowed 用不到）。 */
function analyze(value: string): ScalarAnalysis {
  if (value === '') return { multiline: false, blockPlainAllowed: true, singleQuotedAllowed: true, blockAllowed: false };
  const cps = [...value].map((ch) => ch.codePointAt(0)!);
  let blockIndicators = false;
  let lineBreaks = false;
  let specialCharacters = false;
  let tabCharacters = false;
  let leadingSpace = false;
  let leadingBreak = false;
  let trailingSpace = false;
  let trailingBreak = false;
  let breakSpace = false;
  let spaceBreak = false;
  let previousSpace = false;
  let previousBreak = false;
  if (value.startsWith('---') || value.startsWith('...')) blockIndicators = true;
  let precededByWhitespace = true;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    const followedByWhitespace = i + 1 >= cps.length || cps[i + 1] === 0x20 || cps[i + 1] === 0x09;
    if (i === 0) {
      switch (c) {
        case 0x23: // #
        case 0x2c: // ,
        case 0x5b: // [
        case 0x5d: // ]
        case 0x7b: // {
        case 0x7d: // }
        case 0x26: // &
        case 0x2a: // *
        case 0x21: // !
        case 0x7c: // |
        case 0x3e: // >
        case 0x27: // '
        case 0x22: // "
        case 0x25: // %
        case 0x40: // @
        case 0x60: // `
          blockIndicators = true;
          break;
        case 0x3f: // ?
        case 0x3a: // :
          if (followedByWhitespace) blockIndicators = true;
          break;
        case 0x2d: // -
          if (followedByWhitespace) blockIndicators = true;
          break;
      }
    } else {
      switch (c) {
        case 0x3a:
          if (followedByWhitespace) blockIndicators = true;
          break;
        case 0x23:
          if (precededByWhitespace) blockIndicators = true;
          break;
      }
    }
    if (c === 0x09) tabCharacters = true;
    else if (!isPrintable(c)) specialCharacters = true;
    if (c === 0x20) {
      if (i === 0) leadingSpace = true;
      if (i === cps.length - 1) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true;
      previousBreak = false;
    } else if (isBreak(c)) {
      lineBreaks = true;
      if (i === 0) leadingBreak = true;
      if (i === cps.length - 1) trailingBreak = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false;
      previousBreak = true;
    } else {
      previousSpace = false;
      previousBreak = false;
    }
    precededByWhitespace = isBlankZ(c);
  }
  const out: ScalarAnalysis = { multiline: lineBreaks, blockPlainAllowed: true, singleQuotedAllowed: true, blockAllowed: true };
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) out.blockPlainAllowed = false;
  if (trailingSpace) out.blockAllowed = false;
  if (breakSpace) {
    out.blockPlainAllowed = false;
    out.singleQuotedAllowed = false;
  }
  if (spaceBreak || tabCharacters || specialCharacters) {
    out.blockPlainAllowed = false;
    out.singleQuotedAllowed = false;
  }
  if (spaceBreak || specialCharacters) out.blockAllowed = false;
  if (lineBreaks) out.blockPlainAllowed = false;
  if (blockIndicators) out.blockPlainAllowed = false;
  return out;
}

// yaml.v3 resolve.go：plain 写出后会被解析成非字符串的值，必须加引号。

const resolveMapKeys = new Set([
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  '', '~', 'null', 'Null', 'NULL',
  '.nan', '.NaN', '.NAN', '.inf', '.Inf', '.INF', '+.inf', '+.Inf', '+.INF', '-.inf', '-.Inf', '-.INF',
]);

const yamlStyleFloat = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

/** strconv.ParseInt / ParseUint(s, 0, 64) 是否成功。 */
function goParsesInt(s: string): boolean {
  const m = /^([+-]?)(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)$/.exec(s);
  if (!m) return false;
  const digits = m[2];
  let n: bigint;
  if (/^0[oO]/.test(digits)) n = BigInt('0o' + digits.slice(2));
  else if (/^0[0-7]+$/.test(digits)) n = BigInt('0o' + digits.slice(1));
  else n = BigInt(digits);
  if (m[1] === '-') return n <= 1n << 63n;
  // ParseInt 的上限是 2^63-1；不带符号时 ParseUint 还能到 2^64-1。
  return m[1] === '+' ? n < 1n << 63n : n < 1n << 64n;
}

function goParsesFloat(s: string): boolean {
  // strconv.ParseFloat 对 yamlStyleFloat 形式只在溢出时失败，溢出返回 ±Inf 与 ErrRange。
  return Number.isFinite(Number(s));
}

/** yaml.v3 的 parseTimestamp：以 YYYY- 开头，且能按四种格式之一解析。 */
function isTimestamp(s: string): boolean {
  if (!/^[0-9]{4}-/.test(s)) return false;
  const date = '[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}';
  const clock = '[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\\.[0-9]+)?';
  const zone = '(Z|[+-][0-9]{2}:[0-9]{2})';
  const patterns = [`^${date}T${clock}${zone}$`, `^${date}t${clock}${zone}$`, `^${date} ${clock}$`, `^${date}$`];
  if (!patterns.some((p) => new RegExp(p).test(s))) return false;
  // time.Parse 还会校验取值范围。
  const [y, mo, d] = s.slice(0, 10).split(/[-Tt ]/).map(Number);
  void y;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const time = /[Tt ]([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})/.exec(s);
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3]) > 59)) return false;
  return true;
}

/** resolve("", s) 的结果是不是 !!str。 */
function resolvesToString(s: string): boolean {
  if (resolveMapKeys.has(s)) return false;
  const first = s[0];
  if (first === '.') return !(goParsesFloat(s) && /^\.[0-9]/.test(s) && yamlStyleFloat.test(s));
  if (first === '+' || first === '-' || (first >= '0' && first <= '9')) {
    if (isTimestamp(s)) return false;
    const plain = s.replaceAll('_', '');
    if (goParsesInt(plain)) return false;
    if (yamlStyleFloat.test(plain) && goParsesFloat(plain)) return false;
    if (/^-?0[bB][01]+$/.test(plain)) return false;
    if (/^-?0[oO][0-7]+$/.test(plain)) return false;
  }
  return true;
}

const oldBools = new Set(['y', 'Y', 'yes', 'Yes', 'YES', 'on', 'On', 'ON', 'n', 'N', 'no', 'No', 'NO', 'off', 'Off', 'OFF']);
const base60Float = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/;

function doubleQuoted(value: string): string {
  // yaml.v3 的 is_bom(b, i) 忽略 i、只看缓冲区开头：值以 BOM 开头时，后面每个字符都被转义。
  const bom = value.codePointAt(0) === 0xfeff;
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (bom || !isPrintable(c) || isBreak(c) || c === 0x22 || c === 0x5c) {
      out += '\\';
      switch (c) {
        case 0x00: out += '0'; break;
        case 0x07: out += 'a'; break;
        case 0x08: out += 'b'; break;
        case 0x09: out += 't'; break;
        case 0x0a: out += 'n'; break;
        case 0x0b: out += 'v'; break;
        case 0x0c: out += 'f'; break;
        case 0x0d: out += 'r'; break;
        case 0x1b: out += 'e'; break;
        case 0x22: out += '"'; break;
        case 0x5c: out += '\\'; break;
        case 0x85: out += 'N'; break;
        case 0xa0: out += '_'; break;
        case 0x2028: out += 'L'; break;
        case 0x2029: out += 'P'; break;
        default: {
          const hex = c.toString(16).toUpperCase();
          if (c <= 0xff) out += 'x' + hex.padStart(2, '0');
          else if (c <= 0xffff) out += 'u' + hex.padStart(4, '0');
          else out += 'U' + hex.padStart(8, '0');
        }
      }
    } else {
      out += ch;
    }
  }
  return out + '"';
}

/**
 * 字面块（|）：yaml_emitter_write_block_scalar_hints 与 write_literal_scalar。
 * 照抄 libyaml 的写法：正文第一个字符是换行时，它被当成头部那一行的行尾写出（yaml.v3 的
 * 写法本身会丢掉这个前导换行，这里照样丢，否则写出的字节与 Go 版不同）。
 * 返回写出的文本，以及结尾是否停在行首（是则后面不用再补换行）。
 */
function literal(value: string, indent: string): { text: string; atLineStart: boolean } {
  let hints = '|';
  const cps = [...value].map((ch) => ch.codePointAt(0)!);
  if (cps[0] === 0x20 || isBreak(cps[0])) hints += '2';
  const last = cps.length - 1;
  if (!isBreak(cps[last])) hints += '-';
  else if (last === 0 || isBreak(cps[last - 1])) hints += '+';
  let out = hints;
  let atLineStart = false;
  let breaks = true;
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (isBreak(c)) {
      out += ch;
      atLineStart = true;
      breaks = true;
    } else {
      if (breaks) {
        if (!atLineStart) out += '\n';
        out += indent;
        breaks = false;
      }
      out += ch;
      atLineStart = false;
    }
  }
  return { text: out, atLineStart };
}

/** 单引号标量：换行类字符原样写出，其后的正文先补到缩进位置（yaml_emitter_write_single_quoted_scalar）。 */
function singleQuoted(value: string, indent: string): string {
  let out = "'";
  let breaks = false;
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (isBreak(c)) {
      out += ch;
      breaks = true;
    } else {
      if (breaks) out += indent;
      breaks = false;
      out += ch === "'" ? "''" : ch;
    }
  }
  return out + "'";
}

/** 一个字符串值在 「key: 」 之后的写法（含换行）。indent 是块标量正文的缩进。 */
function scalar(value: string, indent: string): string {
  let style: 'plain' | 'single' | 'double' | 'literal';
  const canUsePlain = resolvesToString(value) && !(base60Float.test(value) || oldBools.has(value));
  if (value.includes('\n')) style = 'literal';
  else if (canUsePlain) style = 'plain';
  else style = 'double';
  const a = analyze(value);
  if (style === 'plain' && !a.blockPlainAllowed) style = 'single';
  if (style === 'single' && !a.singleQuotedAllowed) style = 'double';
  if (style === 'literal' && !a.blockAllowed) style = 'double';
  switch (style) {
    case 'plain':
      return value + '\n';
    case 'single':
      return singleQuoted(value, indent) + '\n';
    case 'double':
      return doubleQuoted(value) + '\n';
    case 'literal': {
      const { text, atLineStart } = literal(value, indent);
      return atLineStart ? text : text + '\n';
    }
  }
}

/** frontmatter 里的一项：字符串、字符串序列，或一层嵌套映射。undefined 表示 omitempty 省略。 */
export type YamlValue = string | string[] | Array<[string, YamlValue | undefined]>;

function emit(entries: Array<[string, YamlValue | undefined]>, indent: string): string {
  let out = '';
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      out += indent + key + ': ' + scalar(value, indent + '  ');
    } else if (value.length === 0) {
      out += indent + key + ': []\n';
    } else if (typeof value[0] === 'string') {
      out += indent + key + ':\n';
      for (const item of value as string[]) out += indent + '  - ' + scalar(item, indent + '    ');
    } else {
      out += indent + key + ':\n' + emit(value as Array<[string, YamlValue | undefined]>, indent + '  ');
    }
  }
  return out;
}

/** yaml.NewEncoder(w).SetIndent(2).Encode(mapping)。 */
export function encodeMapping(entries: Array<[string, YamlValue | undefined]>): string {
  const out = emit(entries, '');
  return out === '' ? '{}\n' : out;
}

// ---- 读入 ----

export type FieldSchema = 'string' | 'strings' | { struct: string; fields: Record<string, FieldSchema> };

/** Go 的 *yaml.TypeError。 */
class YamlTypeError extends Error {
  constructor(errors: string[]) {
    super(`yaml: unmarshal errors:\n  ${errors.join('\n  ')}`);
  }
}

class Decoder {
  readonly errors: string[] = [];
  constructor(
    private readonly doc: Document,
    private readonly lines: LineCounter,
    private readonly source: string,
  ) {}

  private line(node: Node): number {
    return this.lines.linePos(node.range?.[0] ?? 0).line;
  }

  private terror(node: Node, tag: string, text: string, into: string): void {
    let value = '';
    if (tag !== '!!seq' && tag !== '!!map') {
      const bytes = Buffer.from(text, 'utf8');
      value = bytes.length > 10 ? ' `' + bytes.subarray(0, 7).toString('utf8') + '...`' : ' `' + text + '`';
    }
    this.errors.push(`line ${this.line(node)}: cannot unmarshal ${tag}${value} into ${into}`);
  }

  private scalarInfo(node: Node): { tag: string; text: string; isNull: boolean } {
    const s = node as unknown as { value: unknown; source?: string };
    const value = s.value;
    const text = typeof s.source === 'string' ? s.source : value === null || value === undefined ? '' : String(value);
    if (value === null || value === undefined) return { tag: '!!null', text, isNull: true };
    if (typeof value === 'boolean') return { tag: '!!bool', text, isNull: false };
    if (typeof value === 'number' || typeof value === 'bigint') {
      const isInt = Number.isInteger(Number(value)) && !/[.eEnN]/.test(text.replace(/^0x/i, ''));
      return { tag: isInt ? '!!int' : '!!float', text, isNull: false };
    }
    let text2 = String(value);
    // 块标量正好在文档末尾、后面没有换行时，libyaml 不补行尾换行（yaml 包会补）：frontmatter
    // 在 "\n---" 前截断，最后一个键是多行值时就是这种情况。
    const type = (node as unknown as { type?: string }).type;
    if ((type === 'BLOCK_LITERAL' || type === 'BLOCK_FOLDED') && !this.source.endsWith('\n') && (node.range?.[1] ?? 0) >= this.source.length && text2.endsWith('\n')) {
      text2 = text2.slice(0, -1);
    }
    return { tag: '!!str', text: text2, isNull: false };
  }

  decode(node: Node | null | undefined, schema: FieldSchema, current: unknown): unknown {
    if (!node) return current;
    if (isAlias(node)) return this.decode(node.resolve(this.doc) as Node | undefined, schema, current);
    if (schema === 'string') {
      if (isScalar(node)) {
        const info = this.scalarInfo(node);
        return info.isNull ? current : info.text;
      }
      this.terror(node, isSeq(node) ? '!!seq' : '!!map', '', 'string');
      return current;
    }
    if (schema === 'strings') {
      if (isSeq(node)) {
        const out: string[] = [];
        for (const item of node.items) {
          // yaml.v3 的 d.null 对 string 元素返回 false：null 元素不进切片；类型不符的元素也跳过。
          const before = this.errors.length;
          const value = this.decode(item as Node, 'string', undefined);
          if (value !== undefined && this.errors.length === before) out.push(value as string);
        }
        return out;
      }
      if (isScalar(node)) {
        const info = this.scalarInfo(node);
        if (info.isNull) return null;
        this.terror(node, info.tag, info.text, '[]string');
        return current;
      }
      this.terror(node, '!!map', '', '[]string');
      return current;
    }
    if (isMap(node)) {
      const out = (current ?? {}) as Record<string, unknown>;
      for (const pair of node.items) {
        const keyNode = pair.key as Node;
        const key = isScalar(keyNode) ? this.scalarInfo(keyNode).text : '';
        if (!Object.hasOwn(schema.fields, key)) {
          this.errors.push(`line ${this.line(keyNode)}: field ${key} not found in type ${schema.struct}`);
          continue;
        }
        out[key] = this.decode(pair.value as Node, schema.fields[key], out[key]);
      }
      return out;
    }
    if (isScalar(node)) {
      const info = this.scalarInfo(node);
      if (info.isNull) return current;
      this.terror(node, info.tag, info.text, schema.struct);
      return current;
    }
    this.terror(node, '!!seq', '', schema.struct);
    return current;
  }
}

/**
 * yaml.NewDecoder(text).KnownFields(true).Decode(&out)：返回按 schema 解出的对象（未出现的键不在结果里）。
 * 语法错误抛「yaml: …」，未知字段与类型不符抛「yaml: unmarshal errors:…」，空文档抛「EOF」。
 */
export function decodeStrict(text: string, schema: { struct: string; fields: Record<string, FieldSchema> }): Record<string, unknown> {
  const lines = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lines, uniqueKeys: true });
  if (!Array.isArray(docs) || docs.length === 0) throw new Error('EOF');
  const doc = docs[0];
  if (doc.errors.length > 0) {
    const error = doc.errors[0];
    const line = error.linePos?.[0]?.line;
    const message = error.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
    throw new Error(line ? `yaml: line ${line}: ${message}` : `yaml: ${message}`);
  }
  if (doc.contents === null) return {};
  const decoder = new Decoder(doc, lines, text);
  const value = decoder.decode(doc.contents as Node, schema, {});
  if (decoder.errors.length > 0) throw new YamlTypeError(decoder.errors);
  return (value ?? {}) as Record<string, unknown>;
}
