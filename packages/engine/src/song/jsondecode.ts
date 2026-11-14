// 按 Go encoding/json 的 Unmarshal 规则把 JSON 解码进「Go 结构体形状」的对象。只供本包内部使用。
//
// 为什么不直接用 JSON.parse 的结果：Go 解码进结构体时缺失字段取零值、null 对非指针字段是空操作、
// 类型不符直接报错、键名不区分大小写，DisallowUnknownFields 时多余字段报错。歌曲状态文件
// （candidate.json、timeline.json……）的摘要比对依赖「读回来的结构体再编码」与 Go 逐字一致。

export type Schema =
  | 'string'
  | 'int'
  | 'float'
  | 'bool'
  /** interface{}：原样保留 JSON.parse 的结果。 */
  | 'any'
  /**
   * json.RawMessage：字段出现时解码成 { raw: 解析后的值 }（值可以是 null），没出现时是 null。
   * 这样能区分 Go 里 len(raw) == 0（没出现）与 string(raw) == "null"（显式 null）。
   */
  | 'raw'
  | { ptr: Schema }
  | { slice: Schema }
  | { struct: Array<[key: string, schema: Schema]> };

export class JSONDecodeError extends Error {}

/** 'raw' 字段解码后的形状。 */
export interface RawMessage {
  raw: unknown;
}

/** Go 的零值：指针、切片为 null，结构体是各字段零值。 */
export function zeroOf(schema: Schema): unknown {
  if (schema === 'string') return '';
  if (schema === 'int' || schema === 'float') return 0;
  if (schema === 'bool') return false;
  if (schema === 'any' || schema === 'raw') return null;
  if ('ptr' in schema || 'slice' in schema) return null;
  const out: Record<string, unknown> = {};
  for (const [key, field] of schema.struct) out[key] = zeroOf(field);
  return out;
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value === 'object' ? 'object' : typeof value;
}

/** 按 schema 解码一个已解析的 JSON 值。current 是目标的当前值（null 时保留它）。 */
export function decodeValue(value: unknown, schema: Schema, disallowUnknown: boolean, current: unknown = zeroOf(schema)): unknown {
  if (schema === 'any') return value;
  if (schema === 'raw') return { raw: value };
  if (value === null) {
    // Go：null 对指针、切片、interface 置空，其余是空操作。
    if (typeof schema === 'object' && ('ptr' in schema || 'slice' in schema)) return null;
    return current;
  }
  if (schema === 'string') {
    if (typeof value !== 'string') throw new JSONDecodeError(`json: cannot unmarshal ${typeName(value)} into Go value of type string`);
    return value;
  }
  if (schema === 'bool') {
    if (typeof value !== 'boolean') throw new JSONDecodeError(`json: cannot unmarshal ${typeName(value)} into Go value of type bool`);
    return value;
  }
  if (schema === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new JSONDecodeError(`json: cannot unmarshal ${typeName(value)} into Go value of type int`);
    return value;
  }
  if (schema === 'float') {
    if (typeof value !== 'number') throw new JSONDecodeError(`json: cannot unmarshal ${typeName(value)} into Go value of type float64`);
    return value;
  }
  if ('ptr' in schema) return decodeValue(value, schema.ptr, disallowUnknown, zeroOf(schema.ptr));
  if ('slice' in schema) {
    if (!Array.isArray(value)) throw new JSONDecodeError(`json: cannot unmarshal ${typeName(value)} into Go slice`);
    return value.map((item) => decodeValue(item, schema.slice, disallowUnknown));
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new JSONDecodeError(`json: cannot unmarshal ${typeName(value)} into Go struct`);
  const out = (current && typeof current === 'object' ? current : zeroOf(schema)) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Go 先找精确匹配的字段，再按大小写不敏感匹配。
    let field = schema.struct.find(([name]) => name === key);
    if (!field) field = schema.struct.find(([name]) => name.toLowerCase() === key.toLowerCase());
    if (!field) {
      if (disallowUnknown) throw new JSONDecodeError(`json: unknown field "${key}"`);
      continue;
    }
    out[field[0]] = decodeValue(item, field[1], disallowUnknown, out[field[0]]);
  }
  return out;
}

const ws = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * 切出文本里的第一个 JSON 值（对应 json.Decoder 读第一个值），返回它与剩余部分。
 * 第一个值本身不完整时返回 null（Decode 报错）。
 */
export function splitFirstValue(text: string): [first: string, rest: string] | null {
  let i = 0;
  while (i < text.length && ws(text[i])) i++;
  if (i >= text.length) return null;
  const start = i;
  const c = text[i];
  if (c === '{' || c === '[') {
    let depth = 0;
    let inString = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return [text.slice(start, i + 1), text.slice(i + 1)];
      }
    }
    return null;
  }
  if (c === '"') {
    for (i++; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return [text.slice(start, i + 1), text.slice(i + 1)];
    }
    return null;
  }
  while (i < text.length && !ws(text[i]) && !'{}[],:"'.includes(text[i])) i++;
  return [text.slice(start, i), text.slice(i)];
}

/** json.NewDecoder(r).Decode(&out)：只读第一个值，忽略其后内容。 */
export function decodeFirst<T>(text: string, schema: Schema, disallowUnknown = false): T {
  const split = splitFirstValue(text);
  if (!split) throw new JSONDecodeError('unexpected EOF');
  let parsed: unknown;
  try {
    parsed = JSON.parse(split[0]);
  } catch (err) {
    throw new JSONDecodeError(err instanceof Error ? err.message : String(err));
  }
  return decodeValue(parsed, schema, disallowUnknown) as T;
}

/** json.Unmarshal：整段必须恰好是一个值。 */
export function unmarshal<T>(text: string, schema: Schema): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new JSONDecodeError(err instanceof Error ? err.message : String(err));
  }
  return decodeValue(parsed, schema, false) as T;
}
