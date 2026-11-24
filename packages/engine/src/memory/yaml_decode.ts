// 记忆文件 frontmatter 的严格读入：Decoder.KnownFields(true)，未知字段报错；任何标量都能进 string（取原文）。
import { type Document, isAlias, isMap, isScalar, isSeq, LineCounter, type Node, parseAllDocuments } from 'yaml';

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
    if (
      (type === 'BLOCK_LITERAL' || type === 'BLOCK_FOLDED') &&
      !this.source.endsWith('\n') &&
      (node.range?.[1] ?? 0) >= this.source.length &&
      text2.endsWith('\n')
    ) {
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
export function decodeStrict(
  text: string,
  schema: { struct: string; fields: Record<string, FieldSchema> },
): Record<string, unknown> {
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
