// 按 gopkg.in/yaml.v3 的 Unmarshal 规则把 YAML 解码进「Go 结构体形状」的对象。只供本包内部使用。
//
// 为什么不直接用 yaml 包的 toJS：yaml.v3 解码进 Go 结构体时有自己的一套规矩——未知键忽略、
// 任何标量都能进 string（取原文）、浮点能进 int、类型不符时收集全部错误并写成
// 「yaml: unmarshal errors:\n  line N: cannot unmarshal !!str `abc` into float64」。
// 角色包是用户手写的文件，报错文案与容错行为要和 Go 版一致。
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Document, type Node } from 'yaml';

export type Schema =
  | { kind: 'string' }
  | { kind: 'float' }
  | { kind: 'int' }
  | { kind: 'ptrFloat' }
  | { kind: 'array'; len: number; elem: Schema; type: string }
  | { kind: 'slice'; elem: Schema; type: string }
  | { kind: 'map'; elem: Schema; type: string }
  | { kind: 'struct'; type: string; fields: Array<[yamlKey: string, prop: string, schema: Schema]>; zero: () => Record<string, unknown> };

export const str: Schema = { kind: 'string' };
export const float: Schema = { kind: 'float' };
export const int: Schema = { kind: 'int' };
export const ptrFloat: Schema = { kind: 'ptrFloat' };

/** Go 的 *yaml.TypeError。 */
export class YamlTypeError extends Error {
  constructor(readonly errors: string[]) {
    super(`yaml: unmarshal errors:\n  ${errors.join('\n  ')}`);
  }
}

function goTypeName(schema: Schema): string {
  switch (schema.kind) {
    case 'string':
      return 'string';
    case 'float':
    case 'ptrFloat':
      return 'float64';
    case 'int':
      return 'int';
    default:
      return schema.type;
  }
}

/** Go 的零值。 */
export function zeroOf(schema: Schema): unknown {
  switch (schema.kind) {
    case 'string':
      return '';
    case 'float':
    case 'int':
      return 0;
    case 'ptrFloat':
    case 'slice':
    case 'map':
      return null;
    case 'array':
      return Array.from({ length: schema.len }, () => zeroOf(schema.elem));
    case 'struct':
      return schema.zero();
  }
}

const strTag = '!!str';

/** yaml.v3 对标量的解析结果：短标签与值。 */
function resolveScalar(node: Node): { tag: string; value: unknown; text: string } {
  const scalar = node as unknown as { value: unknown; source?: string; type?: string; tag?: string };
  const value = scalar.value;
  const text = typeof scalar.source === 'string' ? scalar.source : value === null ? '' : String(value);
  if (value === null || value === undefined) return { tag: '!!null', value: null, text };
  if (typeof value === 'boolean') return { tag: '!!bool', value, text };
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = Number(value);
    const isInt = Number.isInteger(n) && !/[.eEnN]/.test(text.replace(/^0x/i, ''));
    return { tag: isInt ? '!!int' : '!!float', value: n, text };
  }
  return { tag: strTag, value: String(value), text: String(value) };
}

class Decoder {
  readonly errors: string[] = [];

  constructor(
    private readonly doc: Document,
    private readonly lines: LineCounter,
  ) {}

  private line(node: Node): number {
    const offset = node.range?.[0] ?? 0;
    return this.lines.linePos(offset).line;
  }

  private terror(node: Node, tag: string, schema: Schema, text: string): void {
    let value = '';
    if (tag !== '!!seq' && tag !== '!!map') {
      const bytes = Buffer.from(text, 'utf8');
      value = bytes.length > 10 ? ' `' + bytes.subarray(0, 7).toString('utf8') + '...`' : ' `' + text + '`';
    }
    this.errors.push(`line ${this.line(node)}: cannot unmarshal ${tag}${value} into ${goTypeName(schema)}`);
  }

  /** 把 node 解码进 schema 描述的类型；返回 [是否成功, 值]。失败时调用方保留原值。 */
  decode(node: Node | null | undefined, schema: Schema, current: unknown): [boolean, unknown] {
    if (!node) return [false, current];
    if (isAlias(node)) return this.decode(node.resolve(this.doc) as Node | undefined, schema, current);
    if (isScalar(node)) return this.scalar(node, schema, current);
    if (isSeq(node)) {
      if (schema.kind === 'slice') {
        const out: unknown[] = [];
        for (const item of node.items) {
          const [ok, value] = this.decode(item as Node, schema.elem, zeroOf(schema.elem));
          if (ok) out.push(value);
        }
        return [true, out];
      }
      if (schema.kind === 'array') {
        if (node.items.length !== schema.len) {
          throw new Error(`yaml: invalid array: want ${schema.len} elements but got ${node.items.length}`);
        }
        const out = zeroOf(schema) as unknown[];
        node.items.forEach((item, i) => {
          const [ok, value] = this.decode(item as Node, schema.elem, out[i]);
          if (ok) out[i] = value;
        });
        return [true, out];
      }
      if (schema.kind === 'ptrFloat') return this.decode(node, float, current);
      this.terror(node, '!!seq', schema, '');
      return [false, current];
    }
    if (isMap(node)) {
      if (schema.kind === 'map') {
        const out: Record<string, unknown> = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
        for (const pair of node.items) {
          const [okKey, key] = this.decode(pair.key as Node, str, '');
          if (!okKey) continue;
          const [ok, value] = this.decode(pair.value as Node, schema.elem, zeroOf(schema.elem));
          // 值解码失败（类型不符）时 yaml.v3 不写这个键；null 照常写成零值。
          // 用 defineProperty 而不是赋值：键是 "__proto__" 时赋值会改原型。
          if (ok) Object.defineProperty(out, key as string, { value, enumerable: true, writable: true, configurable: true });
        }
        return [true, out];
      }
      if (schema.kind === 'struct') {
        const out = (current && typeof current === 'object' ? current : schema.zero()) as Record<string, unknown>;
        for (const pair of node.items) {
          const [okKey, key] = this.decode(pair.key as Node, str, '');
          if (!okKey) continue;
          const field = schema.fields.find(([yamlKey]) => yamlKey === key);
          if (!field) continue;
          const [, prop, fieldSchema] = field;
          const [ok, value] = this.decode(pair.value as Node, fieldSchema, out[prop]);
          if (ok) out[prop] = value;
        }
        return [true, out];
      }
      if (schema.kind === 'ptrFloat') return this.decode(node, float, current);
      this.terror(node, '!!map', schema, '');
      return [false, current];
    }
    return [false, current];
  }

  private scalar(node: Node, schema: Schema, current: unknown): [boolean, unknown] {
    const { tag, value, text } = resolveScalar(node);
    if (value === null) {
      // yaml.v3 的 d.null：指针、map、切片置空，其余保持原值。
      if (schema.kind === 'ptrFloat' || schema.kind === 'map' || schema.kind === 'slice') return [true, null];
      return [true, current];
    }
    switch (schema.kind) {
      case 'string':
        return [true, tag === strTag ? value : text];
      case 'float':
      case 'ptrFloat':
        if (typeof value === 'number') return [true, value];
        break;
      case 'int':
        if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
          return [true, Math.trunc(value)];
        }
        break;
    }
    this.terror(node, tag, schema, text);
    return [false, current];
  }
}

/**
 * yaml.Unmarshal(body, &out)。返回解码结果；语法错误抛「yaml: …」，类型不符抛 YamlTypeError（与 Go 一样收集全部）。
 */
export function unmarshal<T>(body: string, schema: Schema & { kind: 'struct' }): T {
  const lines = new LineCounter();
  const docs = parseAllDocuments(body, { lineCounter: lines, uniqueKeys: true });
  const zero = schema.zero();
  if (!Array.isArray(docs)) return zero as T;
  const doc = docs[0];
  if (!doc) return zero as T;
  if (doc.errors.length > 0) {
    const error = doc.errors[0];
    const line = error.linePos?.[0]?.line;
    const message = error.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
    throw new Error(line ? `yaml: line ${line}: ${message}` : `yaml: ${message}`);
  }
  const decoder = new Decoder(doc, lines);
  const [, value] = decoder.decode(doc.contents as Node | null, schema, zero);
  if (decoder.errors.length > 0) throw new YamlTypeError(decoder.errors);
  return value as T;
}
