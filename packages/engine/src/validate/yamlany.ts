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
import { type Document, isAlias, isMap, isScalar, isSeq, LineCounter, type Node, parseAllDocuments } from 'yaml';
import { goQuote } from '../gofmt';
import {
  boolTag,
  floatTag,
  intTag,
  mapTag,
  mergeTag,
  nullTag,
  resolve,
  seqTag,
  shortTag,
  strTag,
  timestampTag,
} from './yamlany_resolve';
import { AnyMap, deepEqual, formatV, type GoMap, isGoMap, setOwn, YamlDecodeError } from './yamlany_values';

export {
  AnyMap,
  deepEqual,
  formatV,
  GoFloat,
  type GoMap,
  GoTime,
  get,
  hasKey,
  isGoInt,
  isGoMap,
  toPlain,
  YamlDecodeError,
} from './yamlany_values';

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
      const [, resolved] = resolve(
        explicitTag(target) !== '' ? explicitTag(target) : this.nodeTag(target),
        scalarText(target),
      );
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
    const kindOf = (n: Node | null) =>
      n === null ? 'scalar' : isAlias(n) ? 'alias' : isMap(n) ? 'map' : isSeq(n) ? 'seq' : 'scalar';
    const valueOf = (n: Node | null) =>
      n === null || isMap(n) || isSeq(n)
        ? ''
        : isAlias(n)
          ? String((n as unknown as { source: string }).source)
          : scalarText(n);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (kindOf(keys[i]) === kindOf(keys[j]) && valueOf(keys[i]) === valueOf(keys[j])) {
          this.terrors.push(
            `line ${this.line(keys[j])}: mapping key ${goQuote(valueOf(keys[j]))} already defined at line ${this.line(keys[i])}`,
          );
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
