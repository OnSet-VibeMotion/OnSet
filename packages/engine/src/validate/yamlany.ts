// gopkg.in/yaml.v3 解码进 map[string]any 的复刻：validate 读 frontmatter 时要的就是 Go 的值形状。
//
// 为什么不直接用 yaml 包的 toJS：
//   - Go 区分 int 与 float64：`schema_version: 1.0` 在 Go 里是 float64，`!= 1` 成立，校验失败；
//     frame.md 与说明书的 DeepEqual 也会因为 1 与 1.0 判成不一致。JS 的 number 分不出来。
//   - yaml.v3 的标量解析规则与 YAML 1.2 core schema 不同（017 是八进制、yes/no 是字符串、
//     未加引号的时间戳解成 time.Time、键不全是字符串的映射解成 map[any]any……）。
//   - 安全检查要看每个节点的 tag（validateTags），yaml.v3 的 Node.Tag 有自己的取值规则。
//
// 所以这里用 yaml 包的 failsafe schema 只取语法树（标量全是原文字符串、显式 tag 原样保留），
// 再按 yaml.v3 的 resolve / decoder 规则自己解出值。
//
// 值的表示：
//   - Go int（以及 uint64）→ JS number；
//   - Go float64 → GoFloat（toJSON 返回数值，写 JSON 时与 Go 一致）；
//   - time.Time（未加引号的时间戳，yaml.v3 v3.0.1 解进 any 时给 time.Time）→ GoTime；
//   - map[string]any → 普通对象；map[any]any → AnyMap；
//   - []any → 数组；nil → null；bool、string 原样。
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Document, type Node } from 'yaml';
import { formatG, goQuote } from '../gofmt';
import { compareBytes } from '../gojson';

/** Go 的 float64 值（与 int 区分开）。 */
export class GoFloat {
  constructor(readonly value: number) {}
  toJSON(): number {
    return this.value;
  }
}

/** Go 的 map[interface{}]interface{}：键不全是字符串的映射。 */
export class AnyMap {
  constructor(readonly entries: Array<[unknown, unknown]>) {}
}

export type GoMap = Record<string, unknown>;

/** v.(map[string]any) */
export function isGoMap(v: unknown): v is GoMap {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof GoFloat) && !(v instanceof AnyMap) && !(v instanceof GoTime);
}

/** v.(int) */
export function isGoInt(v: unknown): v is number {
  return typeof v === 'number';
}

export function hasKey(m: GoMap | null | undefined, key: string): boolean {
  return m != null && Object.hasOwn(m, key);
}

/** m[key]（不存在为 nil）。 */
export function get(m: GoMap | null | undefined, key: string): unknown {
  return m != null && Object.hasOwn(m, key) ? m[key] : null;
}

function setOwn(target: GoMap, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** reflect.DeepEqual：int 与 float64 不相等，NaN 不等于自身。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (a instanceof GoFloat || b instanceof GoFloat) return a instanceof GoFloat && b instanceof GoFloat && a.value === b.value;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (a instanceof GoTime || b instanceof GoTime) return a instanceof GoTime && b instanceof GoTime && a.equals(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a instanceof AnyMap || b instanceof AnyMap) {
    if (!(a instanceof AnyMap) || !(b instanceof AnyMap) || a.entries.length !== b.entries.length) return false;
    return a.entries.every(([key, value]) => b.entries.some(([otherKey, other]) => deepEqual(key, otherKey) && deepEqual(value, other)));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => Object.hasOwn(b as object, key) && deepEqual((a as GoMap)[key], (b as GoMap)[key]));
}

/** fmt 的 %v。 */
export function formatV(v: unknown): string {
  if (v === null || v === undefined) return '<nil>';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof GoFloat) return formatG(v.value);
  if (v instanceof GoTime) return v.toString();
  if (Array.isArray(v)) return '[' + v.map(formatV).join(' ') + ']';
  if (v instanceof AnyMap) {
    const parts = v.entries.map(([key, value]) => [formatV(key), formatV(value)] as const);
    parts.sort((x, y) => compareBytes(x[0], y[0]));
    return 'map[' + parts.map(([key, value]) => key + ':' + value).join(' ') + ']';
  }
  const m = v as GoMap;
  return 'map[' + Object.keys(m).sort(compareBytes).map((key) => key + ':' + formatV(m[key])).join(' ') + ']';
}

/** 换成普通 JS 值（GoFloat → number，AnyMap → 以 %v 写法为键的对象），供调用方当 JSON 用。 */
export function toPlain(v: unknown): unknown {
  if (v instanceof GoFloat) return v.value;
  if (v instanceof GoTime) return v.toJSON();
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof AnyMap) {
    const out: GoMap = {};
    for (const [key, value] of v.entries) setOwn(out, formatV(key), toPlain(value));
    return out;
  }
  if (isGoMap(v)) {
    const out: GoMap = {};
    for (const key of Object.keys(v)) setOwn(out, key, toPlain(v[key]));
    return out;
  }
  return v;
}

// ---------- yaml.v3 的标量解析（resolve.go） ----------

const strTag = '!!str';
const boolTag = '!!bool';
const intTag = '!!int';
const floatTag = '!!float';
const timestampTag = '!!timestamp';
const nullTag = '!!null';
const mergeTag = '!!merge';
const mapTag = '!!map';
const seqTag = '!!seq';
const binaryTag = '!!binary';

const longTagPrefix = 'tag:yaml.org,2002:';

function shortTag(tag: string): string {
  if (tag.startsWith(longTagPrefix)) return '!!' + tag.slice(longTagPrefix.length);
  return tag;
}

const resolveMap = new Map<string, [string, unknown]>();
for (const [value, tag, list] of [
  [true, boolTag, ['true', 'True', 'TRUE']],
  [false, boolTag, ['false', 'False', 'FALSE']],
  [null, nullTag, ['', '~', 'null', 'Null', 'NULL']],
  [new GoFloat(NaN), floatTag, ['.nan', '.NaN', '.NAN']],
  [new GoFloat(Infinity), floatTag, ['.inf', '.Inf', '.INF']],
  [new GoFloat(Infinity), floatTag, ['+.inf', '+.Inf', '+.INF']],
  [new GoFloat(-Infinity), floatTag, ['-.inf', '-.Inf', '-.INF']],
  ['<<', mergeTag, ['<<']],
] as Array<[unknown, string, string[]]>) {
  for (const text of list) resolveMap.set(text, [tag, value]);
}

function hintOf(c: string): string {
  if (c >= '0' && c <= '9') return 'D';
  if (c === '+' || c === '-') return 'S';
  if (c === '.') return '.';
  if ('yYnNtTfFoO~'.includes(c)) return 'M';
  return '';
}

const yamlStyleFloat = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

/** strconv.ParseInt(s, 0, 64) 与 ParseUint(s, 0, 64)：合法时返回数值，否则 null。 */
function parseGoInt(s: string, signed: boolean): number | null {
  let body = s;
  let negative = false;
  if (signed && (body.startsWith('+') || body.startsWith('-'))) {
    negative = body[0] === '-';
    body = body.slice(1);
  }
  let base = 10;
  let digits = body;
  if (/^0[xX]/.test(body)) {
    base = 16;
    digits = body.slice(2);
  } else if (/^0[oO]/.test(body)) {
    base = 8;
    digits = body.slice(2);
  } else if (/^0[bB]/.test(body)) {
    base = 2;
    digits = body.slice(2);
  } else if (body.length > 1 && body[0] === '0') {
    base = 8;
    digits = body.slice(1);
  }
  if (digits === '') return null;
  const valid = { 2: /^[01]+$/, 8: /^[0-7]+$/, 10: /^[0-9]+$/, 16: /^[0-9a-fA-F]+$/ }[base]!;
  if (!valid.test(digits)) return null;
  let value = 0n;
  for (const ch of digits) value = value * BigInt(base) + BigInt(parseInt(ch, 16));
  if (negative) value = -value;
  if (signed ? value > 9223372036854775807n || value < -9223372036854775808n : value > 18446744073709551615n) return null;
  return Number(value);
}

const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const timestampPattern =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:[Tt](\d{1,2}):(\d{1,2}):(\d{1,2})(\.\d+)?(Z|[+-]\d{2}:\d{2}))|(?: (\d{1,2}):(\d{1,2}):(\d{1,2})(\.\d+)?))?$/;

/** yaml.v3 的 parseTimestamp（time.Parse 的四种格式，校验月日与时分秒的范围）。 */
function parseTimestamp(s: string): GoTime | null {
  const m = timestampPattern.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (day > (month === 2 && !leap ? 28 : monthDays[month - 1])) return null;
  const withZone = m[4] !== undefined;
  const hms = withZone ? [m[4], m[5], m[6]] : m[9] !== undefined ? [m[9], m[10], m[11]] : ['0', '0', '0'];
  const [hour, minute, second] = hms.map(Number);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const fraction = (withZone ? m[7] : m[12]) ?? '';
  const zone = withZone ? m[8] : 'Z';
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    offsetMinutes = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * (zone[0] === '-' ? -1 : 1);
  }
  const nanos = fraction === '' ? 0 : Number((fraction.slice(1) + '000000000').slice(0, 9));
  return new GoTime(s, year, month, day, hour, minute, second, nanos, offsetMinutes);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * Go 的 time.Time（yaml.v3 把未加引号的时间戳解进 any 时给的就是它）。
 * 只保留墙上时间与时区偏移，够 DeepEqual、%v 与 JSON 用。
 */
export class GoTime {
  constructor(
    readonly text: string,
    readonly year: number,
    readonly month: number,
    readonly day: number,
    readonly hour: number,
    readonly minute: number,
    readonly second: number,
    readonly nanos: number,
    /** 东正西负，单位分钟；0 且来自 Z 或无时区时为 UTC。 */
    readonly offsetMinutes: number,
  ) {}

  private datePart(): string {
    return `${pad(this.year, 4)}-${pad(this.month)}-${pad(this.day)}`;
  }

  private clock(): string {
    return `${pad(this.hour)}:${pad(this.minute)}:${pad(this.second)}`;
  }

  /** .999999999 的小数写法：去掉末尾的 0，全零时整段省略。 */
  private fraction(): string {
    if (this.nanos === 0) return '';
    return '.' + String(this.nanos).padStart(9, '0').replace(/0+$/, '');
  }

  private zone(colon: boolean): string {
    const sign = this.offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(this.offsetMinutes);
    return sign + pad(Math.floor(abs / 60)) + (colon ? ':' : '') + pad(abs % 60);
  }

  /** time.Time 的 String()：2006-01-02 15:04:05.999999999 -0700 MST。 */
  toString(): string {
    const name = this.offsetMinutes === 0 ? 'UTC' : this.zone(false);
    return `${this.datePart()} ${this.clock()}${this.fraction()} ${this.zone(false)} ${name}`;
  }

  /** time.Time 的 MarshalJSON：RFC3339Nano。 */
  toJSON(): string {
    return `${this.datePart()}T${this.clock()}${this.fraction()}${this.offsetMinutes === 0 ? 'Z' : this.zone(true)}`;
  }

  equals(other: GoTime): boolean {
    return (
      this.year === other.year &&
      this.month === other.month &&
      this.day === other.day &&
      this.hour === other.hour &&
      this.minute === other.minute &&
      this.second === other.second &&
      this.nanos === other.nanos &&
      this.offsetMinutes === other.offsetMinutes
    );
  }
}

/** resolve 里显式 tag 与解析结果不符时的 failf。 */
export class YamlDecodeError extends Error {}

/** yaml.v3 的 resolve(tag, in)。 */
function resolve(tag: string, input: string): [string, unknown] {
  tag = shortTag(tag);
  if (!['', strTag, boolTag, intTag, floatTag, nullTag, timestampTag].includes(tag)) return [tag, input];
  const [rtag, out] = resolveCore(tag, input);
  if (tag === '' || tag === rtag || tag === strTag || tag === binaryTag) return [rtag, out];
  if (tag === floatTag && rtag === intTag) return [floatTag, new GoFloat(out as number)];
  throw new YamlDecodeError(`yaml: cannot decode ${shortTag(rtag)} \`${input}\` as a ${shortTag(tag)}`);
}

function resolveCore(tag: string, input: string): [string, unknown] {
  const hint = input === '' ? 'N' : hintOf(input[0]);
  if (hint !== '' && tag !== strTag && tag !== binaryTag) {
    const known = resolveMap.get(input);
    if (known) return known;
    switch (hint) {
      case '.':
        if (/^\.[0-9]+([eE][-+]?[0-9]+)?$/.test(input)) {
          const f = Number(input);
          if (Number.isFinite(f)) return [floatTag, new GoFloat(f)];
        }
        break;
      case 'D':
      case 'S': {
        if (tag === '' || tag === timestampTag) {
          const t = parseTimestamp(input);
          if (t) return [timestampTag, t];
        }
        const plain = input.replaceAll('_', '');
        const signed = parseGoInt(plain, true);
        if (signed !== null) return [intTag, signed];
        const unsigned = parseGoInt(plain, false);
        if (unsigned !== null) return [intTag, unsigned];
        if (yamlStyleFloat.test(plain)) {
          const f = Number(plain);
          if (Number.isFinite(f)) return [floatTag, new GoFloat(f)];
        }
        break;
      }
    }
  }
  return [strTag, input];
}

// ---------- 语法树 ----------

interface ScalarLike {
  value: unknown;
  type?: string;
  tag?: string | null;
}

/** 显式写出的 tag（"!" 视同没写）。 */
function explicitTag(node: Node): string {
  const tag = (node as unknown as { tag?: string | null }).tag;
  if (!tag || tag === '!') return '';
  return shortTag(tag);
}

function scalarText(node: Node): string {
  const value = (node as unknown as ScalarLike).value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

function isPlain(node: Node): boolean {
  const type = (node as unknown as ScalarLike).type;
  return type === undefined || type === 'PLAIN';
}

class Decoder {
  readonly terrors: string[] = [];

  constructor(
    private readonly doc: Document,
    private readonly lines: LineCounter,
  ) {}

  line(node: Node | null): number {
    const offset = node?.range?.[0] ?? 0;
    return this.lines.linePos(offset).line;
  }

  resolveAlias(node: Node): Node | null {
    let current: Node | null = node;
    for (let depth = 0; current && isAlias(current) && depth < 100; depth++) {
      current = (current.resolve(this.doc) as Node | undefined) ?? null;
    }
    return current;
  }

  /** yaml.v3 的 Node.Tag（解析器写下的那个），validateTags 检查的就是它。 */
  nodeTag(node: Node): string {
    if (isAlias(node)) return '';
    const explicit = explicitTag(node);
    if (explicit !== '') return explicit;
    if (isMap(node)) return mapTag;
    if (isSeq(node)) return seqTag;
    if (!isPlain(node)) return strTag;
    const text = scalarText(node);
    if (text === '<<') return mergeTag;
    return resolve('', text)[0];
  }

  /** Node.ShortTag()。 */
  shortTagOf(node: Node | null): string {
    if (node === null) return nullTag;
    if (isAlias(node)) {
      const target = this.resolveAlias(node);
      return target ? this.shortTagOf(target) : '';
    }
    if (isScalar(node) && this.indicatedString(node)) return strTag;
    return this.nodeTag(node);
  }

  indicatedString(node: Node): boolean {
    const explicit = explicitTag(node);
    return explicit === strTag || (explicit === '' && !isPlain(node));
  }

  /** validateTags：只允许常见的核心 tag。 */
  validateTags(node: Node | null): void {
    if (node === null) return;
    const tag = this.nodeTag(node);
    const allowed = ['', mapTag, seqTag, strTag, intTag, floatTag, boolTag, nullTag, timestampTag];
    if (!allowed.includes(tag)) throw new Error(`不安全的 YAML tag：${tag}`);
    if (isMap(node)) {
      for (const pair of node.items) {
        this.validateTags(pair.key as Node | null);
        this.validateTags(pair.value as Node | null);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) this.validateTags(item as Node | null);
    }
  }

  /** 标量解进 interface{}。 */
  scalar(node: Node): unknown {
    if (this.indicatedString(node)) return scalarText(node);
    const explicit = explicitTag(node);
    const text = scalarText(node);
    const [, resolved] = resolve(explicit !== '' ? explicit : this.nodeTag(node), text);
    return resolved;
  }

  /** 解进 interface{}。返回 [是否成功, 值]。 */
  decodeAny(node: Node | null): [boolean, unknown] {
    if (node === null) return [true, null];
    if (isAlias(node)) return this.decodeAny(this.resolveAlias(node));
    if (isScalar(node)) return [true, this.scalar(node)];
    if (isSeq(node)) {
      const out: unknown[] = [];
      for (const item of node.items) {
        // 元素解失败（里面的映射有重复键）时 yaml.v3 丢掉这个元素。
        const [ok, value] = this.decodeAny(item as Node | null);
        if (ok) out.push(value);
      }
      return [true, out];
    }
    if (isMap(node)) {
      if (!this.uniqueKeys(node)) return [false, null];
      const stringMap = node.items.every((pair) => {
        const tag = this.shortTagOf(pair.key as Node | null);
        return tag === strTag || tag === mergeTag;
      });
      if (stringMap) {
        const out: GoMap = {};
        for (const pair of node.items) this.setStringKey(out, pair.key as Node | null, pair.value as Node | null);
        return [true, out];
      }
      const entries: Array<[unknown, unknown]> = [];
      for (const pair of node.items) {
        const [, key] = this.decodeAny(pair.key as Node | null);
        if (Array.isArray(key) || isGoMap(key) || key instanceof AnyMap) {
          throw new YamlDecodeError(`yaml: invalid map key: ${formatV(key)}`);
        }
        const [ok, value] = this.decodeAny(pair.value as Node | null);
        if (!ok && this.shortTagOf(pair.value as Node | null) !== nullTag) continue;
        const existing = entries.findIndex(([k]) => deepEqual(k, key));
        if (existing >= 0) entries[existing][1] = value;
        else entries.push([key, value]);
      }
      return [true, new AnyMap(entries)];
    }
    return [true, null];
  }

  /** 键解进 string，值解进 interface{}，写进 out。null 键被跳过（yaml.v3 的 d.null 对 string 返回 false）。 */
  setStringKey(out: GoMap, keyNode: Node | null, valueNode: Node | null): void {
    const target = keyNode && isAlias(keyNode) ? this.resolveAlias(keyNode) : keyNode;
    if (target === null) return;
    if (isMap(target) || isSeq(target)) {
      this.terrors.push(`line ${this.line(target)}: cannot unmarshal ${isMap(target) ? mapTag : seqTag} into string`);
      return;
    }
    if (!this.indicatedString(target)) {
      const [, resolved] = resolve(explicitTag(target) !== '' ? explicitTag(target) : this.nodeTag(target), scalarText(target));
      if (resolved === null) return;
    }
    const key = scalarText(target);
    const [ok, value] = this.decodeAny(valueNode);
    if (ok || this.shortTagOf(valueNode) === nullTag) setOwn(out, key, value);
  }

  /** d.uniqueKeys：同一映射里键原文重复时记下全部重复，并且不解这个映射。 */
  uniqueKeys(node: Node): boolean {
    if (!isMap(node)) return true;
    const before = this.terrors.length;
    const keys = node.items.map((pair) => pair.key as Node | null);
    const kindOf = (n: Node | null) => (n === null ? 'scalar' : isAlias(n) ? 'alias' : isMap(n) ? 'map' : isSeq(n) ? 'seq' : 'scalar');
    const valueOf = (n: Node | null) =>
      n === null || isMap(n) || isSeq(n) ? '' : isAlias(n) ? String((n as unknown as { source: string }).source) : scalarText(n);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (kindOf(keys[i]) === kindOf(keys[j]) && valueOf(keys[i]) === valueOf(keys[j])) {
          this.terrors.push(`line ${this.line(keys[j])}: mapping key ${goQuote(valueOf(keys[j]))} already defined at line ${this.line(keys[i])}`);
        }
      }
    }
    return this.terrors.length === before;
  }

  /** 顶层解进 map[string]interface{}。 */
  decodeTop(node: Node | null): GoMap | null {
    if (node === null) return null;
    const target = isAlias(node) ? this.resolveAlias(node) : node;
    if (target === null) return null;
    if (isScalar(target)) {
      const value = this.scalar(target);
      if (value === null) return null;
      const text = scalarText(target);
      const tag = this.indicatedString(target) ? strTag : this.nodeTag(target);
      const bytes = Buffer.from(text, 'utf8');
      const shown = bytes.length > 10 ? bytes.subarray(0, 7).toString('utf8') + '...' : text;
      this.terrors.push(`line ${this.line(target)}: cannot unmarshal ${tag} \`${shown}\` into map[string]interface {}`);
      return null;
    }
    if (isSeq(target)) {
      this.terrors.push(`line ${this.line(target)}: cannot unmarshal !!seq into map[string]interface {}`);
      return null;
    }
    if (!isMap(target)) return null;
    if (!this.uniqueKeys(target)) return {};
    const out: GoMap = {};
    for (const pair of target.items) this.setStringKey(out, pair.key as Node | null, pair.value as Node | null);
    return out;
  }
}

/**
 * yaml.Unmarshal(text, &node) → validateTags(&node) → node.Decode(&map[string]any)。
 * 语法错误抛「yaml 解析失败：…」，不安全的 tag 抛「不安全的 YAML tag：…」，解码错误照 yaml.v3 原样抛出。
 * 返回 null 表示 Go 的 nil map（空文档）。
 */
export function decodeFrontmatterYAML(text: string): GoMap | null {
  const lines = new LineCounter();
  const docs = parseAllDocuments(text, { schema: 'failsafe', uniqueKeys: false, lineCounter: lines, strict: false });
  const list = Array.isArray(docs) ? docs : [];
  const doc = list[0];
  if (!doc) return null;
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    const line = first.linePos?.[0]?.line;
    const message = first.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
    throw new Error(`yaml 解析失败：yaml: ${line !== undefined ? `line ${line}: ` : ''}${message}`);
  }
  const decoder = new Decoder(doc, lines);
  const root = (doc.contents as Node | null) ?? null;
  decoder.validateTags(root);
  const result = decoder.decodeTop(root);
  if (decoder.terrors.length > 0) throw new Error(`yaml: unmarshal errors:\n  ${decoder.terrors.join('\n  ')}`);
  return result;
}
