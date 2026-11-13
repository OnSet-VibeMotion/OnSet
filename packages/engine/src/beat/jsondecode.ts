// encoding/json 解码进结构体的最小复刻，供 beat 与 align 读手写 / 机器写的 JSON 文件。
//
// JSON.parse 不查类型：fps 写成 "30" 也照收。Go 版会报「json: cannot unmarshal string into Go
// struct field Timeline.fps of type int」，这些文案会被拼进中文报错，所以按 Go 的规则逐字段校验：
// 键名先精确匹配、再不区分大小写匹配；null 保留零值（切片为 null）；int 字段只收十进制整数原文；
// 报的是文档顺序里的第一个错误（Go 的 saveError）。DisallowUnknownFields 的「json: unknown field」
// 同样按文档顺序参与「第一个错误」。
//
// 语法检查照 Go scanner 的状态机写（与 reads/decode.ts 同一份做法），错误文案逐字一致。
// 与 reads 那份的区别：这里还要支持 float64、bool、[]float64、[]string，以及 json.Decoder
// 只读第一个值（之后的内容由调用方决定怎么处理）的模式。
import { goQuote } from '../gofmt';

export type FieldType = 'int' | 'int64' | 'float' | 'string' | 'bool' | SliceType | StructType;

export interface SliceType {
  kind: 'slice';
  elem: FieldType;
}

export interface StructType {
  kind: 'struct';
  /** reflect.Type.String()，如 beat.Grid；用于「Go value of type …」与切片元素的类型名。 */
  goName: string;
  /** reflect.Type.Name()，如 Grid；匿名结构体为空串。用于「Go struct field Grid.x」。 */
  name: string;
  /** JSON 键名（即 TS 字段名，二者照 Go 的 struct tag 写成同一个）与类型，按 Go 的字段顺序。 */
  fields: Array<[json: string, type: FieldType]>;
}

export const sliceOf = (elem: FieldType): SliceType => ({ kind: 'slice', elem });

/** JSON.parse 的 reviver 把数字换成带原文的对象，类型错误要报出原文。 */
class NumberLiteral {
  constructor(readonly source: string) {}
}

function goTypeName(t: FieldType): string {
  switch (t) {
    case 'int':
      return 'int';
    case 'int64':
      return 'int64';
    case 'float':
      return 'float64';
    case 'string':
      return 'string';
    case 'bool':
      return 'bool';
  }
  if (t.kind === 'slice') return '[]' + goTypeName(t.elem);
  return t.goName;
}

/** Go 的零值：数为 0、串为空、切片为 null、结构体逐字段取零值。 */
export function zeroOf(t: FieldType): unknown {
  switch (t) {
    case 'int':
    case 'int64':
    case 'float':
      return 0;
    case 'string':
      return '';
    case 'bool':
      return false;
  }
  if (t.kind === 'slice') return null;
  const out: Record<string, unknown> = {};
  for (const [json, type] of t.fields) out[json] = zeroOf(type);
  return out;
}

function kindOf(value: unknown): string {
  if (value instanceof NumberLiteral) return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'bool';
  if (Array.isArray(value)) return 'array';
  return 'object';
}

interface Context {
  disallowUnknown: boolean;
  error?: string;
}

interface Where {
  struct?: StructType;
  path: string[];
}

function typeError(ctx: Context, where: Where, value: string, t: FieldType): void {
  if (ctx.error !== undefined) return;
  if (where.struct === undefined) {
    ctx.error = `json: cannot unmarshal ${value} into Go value of type ${goTypeName(t)}`;
    return;
  }
  ctx.error = `json: cannot unmarshal ${value} into Go struct field ${where.struct.name}.${where.path.join('.')} of type ${goTypeName(t)}`;
}

const intLiteral = /^-?(?:0|[1-9][0-9]*)$/;
const maxInt64 = 9223372036854775807n;
const minInt64 = -9223372036854775808n;

function decodeValue(value: unknown, t: FieldType, ctx: Context, where: Where): unknown {
  if (value === null) return zeroOf(t);
  switch (t) {
    case 'int':
    case 'int64':
      if (!(value instanceof NumberLiteral)) {
        typeError(ctx, where, kindOf(value), t);
        return 0;
      }
      if (!intLiteral.test(value.source) || BigInt(value.source) > maxInt64 || BigInt(value.source) < minInt64) {
        typeError(ctx, where, 'number ' + value.source, t);
        return 0;
      }
      return Number(value.source);
    case 'float': {
      if (!(value instanceof NumberLiteral)) {
        typeError(ctx, where, kindOf(value), t);
        return 0;
      }
      const n = Number(value.source);
      if (!Number.isFinite(n)) {
        typeError(ctx, where, 'number ' + value.source, t);
        return 0;
      }
      return n;
    }
    case 'string':
      if (typeof value !== 'string') {
        typeError(ctx, where, kindOf(value), t);
        return '';
      }
      return value;
    case 'bool':
      if (typeof value !== 'boolean') {
        typeError(ctx, where, kindOf(value), t);
        return false;
      }
      return value;
  }
  if (t.kind === 'slice') {
    if (!Array.isArray(value)) {
      typeError(ctx, where, kindOf(value), t);
      return null;
    }
    return value.map((item) => decodeValue(item, t.elem, ctx, where));
  }
  if (typeof value !== 'object' || Array.isArray(value) || value instanceof NumberLiteral) {
    typeError(ctx, where, kindOf(value), t);
    return zeroOf(t);
  }
  const out = zeroOf(t) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const field = t.fields.find(([json]) => json === key) ?? t.fields.find(([json]) => json.toLowerCase() === key.toLowerCase());
    if (!field) {
      if (ctx.disallowUnknown && ctx.error === undefined) ctx.error = `json: unknown field ${goQuote(key)}`;
      continue;
    }
    out[field[0]] = decodeValue(item, field[1], ctx, { struct: t, path: [...where.path, field[0]] });
  }
  return out;
}

function parseLiteral(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === 'number' ? new NumberLiteral(context?.source ?? String(value)) : value,
  );
}

function decodeText<T>(text: string, t: StructType, disallowUnknown: boolean): T {
  const ctx: Context = { disallowUnknown };
  const decoded = decodeValue(parseLiteral(text), t, ctx, { path: [] });
  if (ctx.error !== undefined) throw new Error(ctx.error);
  return decoded as T;
}

/** json.Unmarshal：先对整份输入做语法检查，再按类型解码。 */
export function unmarshal<T>(body: string | Uint8Array, t: StructType): T {
  const data = toBytes(body);
  const syntax = scan(data, false);
  if (syntax.error !== null) throw new Error(syntax.error);
  return decodeText<T>(Buffer.from(data).toString('utf8'), t, false);
}

/**
 * json.NewDecoder(r) 的一次 Decode：只读第一个值，返回解码结果与其后剩余的字节。
 * 输入为空报「EOF」，值没读完报「unexpected EOF」（Decoder 与 Unmarshal 在这两处文案不同）。
 */
export function decodeFirst<T>(body: string | Uint8Array, t: StructType, disallowUnknown: boolean): { value: T; rest: Uint8Array } {
  const data = toBytes(body);
  const syntax = scan(data, true);
  if (syntax.error !== null) throw new Error(syntax.error);
  const value = decodeText<T>(Buffer.from(data.subarray(0, syntax.end)).toString('utf8'), t, disallowUnknown);
  return { value, rest: data.subarray(syntax.end) };
}

/** 与 Go 的 json.Unmarshal(body, &any) 相同的语法检查；合法时返回 null，否则返回 Go 的错误文案。 */
export function checkValid(body: string | Uint8Array): string | null {
  return scan(toBytes(body), false).error;
}

/** 剩余字节里是否只有 JSON 空白（Decoder 再 Decode 一次会得到 io.EOF）。 */
export function onlySpace(rest: Uint8Array): boolean {
  for (const c of rest) if (!isSpace(c)) return false;
  return true;
}

function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

// ---- encoding/json 的 scanner ----

class ScanError extends Error {}

const endOfInput = 'unexpected end of JSON input';

/** Go 的 quoteChar：按字节报，非 ASCII 字节当作 U+0080–U+00FF 的字符引用。 */
function quoteChar(c: number): string {
  if (c === 0x27) return "'\\''";
  if (c === 0x22) return `'"'`;
  const short: Record<number, string> = { 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v', 0x5c: '\\\\' };
  if (short[c] !== undefined) return `'${short[c]}'`;
  if (c < 0x20 || c === 0x7f) return `'\\x${c.toString(16).padStart(2, '0')}'`;
  if (c >= 0x80 && (c < 0xa1 || c === 0xad)) return `'\\u${c.toString(16).padStart(4, '0')}'`;
  return `'${String.fromCharCode(c)}'`;
}

/**
 * 扫描一个 JSON 值。firstOnly 为 false 时值之后只能有空白（Unmarshal）；为 true 时
 * 返回值结束的位置（Decoder），输入提前结束的文案换成 Decoder 的 EOF / unexpected EOF。
 */
function scan(data: Uint8Array, firstOnly: boolean): { error: string | null; end: number } {
  let i = 0;
  const at = (): number => (i < data.length ? data[i] : -1);
  const invalid = (context: string): never => {
    // 输入结束时 Go 喂进来的是空格。
    const c = i < data.length ? data[i] : 0x20;
    throw new ScanError(`invalid character ${quoteChar(c)} ${context}`);
  };
  const skipSpace = (): void => {
    while (i < data.length && isSpace(data[i])) i++;
    if (i >= data.length) throw new ScanError(endOfInput);
  };
  const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
  const isHexByte = (c: number): boolean => isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);

  const literal = (word: string): void => {
    i++;
    for (let k = 1; k < word.length; k++) {
      if (i >= data.length && firstOnly) throw new ScanError(endOfInput);
      if (at() !== word.charCodeAt(k)) invalid(`in literal ${word} (expecting '${word[k]}')`);
      i++;
    }
  };

  const string = (): void => {
    i++; // 开头的引号
    for (;;) {
      if (i >= data.length) throw new ScanError(endOfInput);
      const c = data[i];
      if (c === 0x22) {
        i++;
        return;
      }
      if (c === 0x5c) {
        i++;
        const e = at();
        if (e === 0x75) {
          i++;
          for (let k = 0; k < 4; k++) {
            if (!isHexByte(at())) invalid('in \\u hexadecimal character escape');
            i++;
          }
          continue;
        }
        if (e !== -1 && '"\\/bfnrt'.includes(String.fromCharCode(e))) {
          i++;
          continue;
        }
        invalid('in string escape code');
      }
      if (c < 0x20) invalid('in string literal');
      i++;
    }
  };

  const number = (): void => {
    if (at() === 0x2d) {
      i++;
      if (!isDigit(at())) invalid('in numeric literal');
    }
    if (at() === 0x30) {
      i++;
    } else {
      while (isDigit(at())) i++;
    }
    if (at() === 0x2e) {
      i++;
      if (!isDigit(at())) invalid('after decimal point in numeric literal');
      while (isDigit(at())) i++;
    }
    if (at() === 0x65 || at() === 0x45) {
      i++;
      if (at() === 0x2b || at() === 0x2d) i++;
      if (!isDigit(at())) invalid('in exponent of numeric literal');
      while (isDigit(at())) i++;
    }
  };

  const value = (): void => {
    skipSpace();
    const c = data[i];
    if (c === 0x7b) {
      i++;
      skipSpace();
      if (at() === 0x7d) {
        i++;
        return;
      }
      for (;;) {
        if (at() !== 0x22) invalid('looking for beginning of object key string');
        string();
        skipSpace();
        if (at() !== 0x3a) invalid('after object key');
        i++;
        value();
        skipSpace();
        if (at() === 0x2c) {
          i++;
          skipSpace();
          continue;
        }
        if (at() === 0x7d) {
          i++;
          return;
        }
        invalid('after object key:value pair');
      }
    }
    if (c === 0x5b) {
      i++;
      skipSpace();
      if (at() === 0x5d) {
        i++;
        return;
      }
      for (;;) {
        value();
        skipSpace();
        if (at() === 0x2c) {
          i++;
          continue;
        }
        if (at() === 0x5d) {
          i++;
          return;
        }
        invalid('after array element');
      }
    }
    if (c === 0x22) return string();
    if (c === 0x2d || isDigit(c)) return number();
    if (c === 0x74) return literal('true');
    if (c === 0x66) return literal('false');
    if (c === 0x6e) return literal('null');
    invalid('looking for beginning of value');
  };

  try {
    value();
    if (firstOnly) return { error: null, end: i };
    while (i < data.length && isSpace(data[i])) i++;
    if (i < data.length) invalid('after top-level value');
    return { error: null, end: i };
  } catch (err) {
    if (!(err instanceof ScanError)) throw err;
    if (firstOnly && err.message === endOfInput) {
      let k = 0;
      while (k < data.length && isSpace(data[k])) k++;
      return { error: k >= data.length ? 'EOF' : 'unexpected EOF', end: i };
    }
    return { error: err.message, end: i };
  }
}
