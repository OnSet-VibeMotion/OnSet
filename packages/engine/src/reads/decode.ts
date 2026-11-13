// json.Unmarshal 到结构体的最小复刻，只覆盖本包用到的字段类型（int、string、结构体切片）。
//
// JSON.parse 不查类型：fps 写成 "30" 也照收。Go 版会报「json: cannot unmarshal string into Go
// struct field Inventory.fps of type int」，错误文案要逐字一致，所以按 Go 的规则逐字段校验：
// 键名先精确匹配、再不区分大小写匹配；null 保留零值；未知字段忽略；int 字段只收 ParseInt 能解析的
// 十进制整数（1.5、1e2、超出 int64 都报错，报错里带原文）；报的是文档顺序里的第一个类型错误。

/** Go 的 int 字段能接受的数字原文。 */
const intLiteral = /^-?(?:0|[1-9][0-9]*)$/;
const maxInt64 = 9223372036854775807n;
const minInt64 = -9223372036854775808n;

export type FieldType = 'int' | 'string' | StructType | SliceType;

export interface StructType {
  kind: 'struct';
  /** Go 的类型名，如 reads.Event。 */
  goName: string;
  fields: Array<{ json: string; name: string; type: FieldType }>;
}

export interface SliceType {
  kind: 'slice';
  elem: StructType;
}

/** JSON.parse 的 reviver 把数字换成带原文的对象，类型错误要报出原文。 */
class NumberLiteral {
  constructor(
    readonly source: string,
    readonly value: number,
  ) {}
}

function goTypeName(t: FieldType): string {
  if (t === 'int' || t === 'string') return t;
  if (t.kind === 'slice') return '[]' + t.elem.goName;
  return t.goName;
}

function shortStructName(t: StructType): string {
  return t.goName.slice(t.goName.lastIndexOf('.') + 1);
}

function kindOf(value: unknown): string {
  if (value instanceof NumberLiteral) return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'bool';
  if (Array.isArray(value)) return 'array';
  return 'object';
}

interface Context {
  /** 外层结构体（报错里的 Struct）与字段路径；顶层值没有。 */
  struct?: StructType;
  path: string[];
  error?: string;
}

function typeError(ctx: Context, value: string, t: FieldType): void {
  if (ctx.error !== undefined) return;
  if (ctx.struct === undefined) {
    ctx.error = `json: cannot unmarshal ${value} into Go value of type ${goTypeName(t)}`;
    return;
  }
  ctx.error = `json: cannot unmarshal ${value} into Go struct field ${shortStructName(ctx.struct)}.${ctx.path.join('.')} of type ${goTypeName(t)}`;
}

function decodeValue(value: unknown, t: FieldType, ctx: Context): unknown {
  if (value === null) return undefined;
  if (t === 'int') {
    if (!(value instanceof NumberLiteral)) {
      typeError(ctx, kindOf(value), t);
      return undefined;
    }
    if (!intLiteral.test(value.source) || BigInt(value.source) > maxInt64 || BigInt(value.source) < minInt64) {
      typeError(ctx, 'number ' + value.source, t);
      return undefined;
    }
    return Number(value.source);
  }
  if (t === 'string') {
    if (typeof value !== 'string') {
      typeError(ctx, kindOf(value), t);
      return undefined;
    }
    return value;
  }
  if (t.kind === 'slice') {
    if (!Array.isArray(value)) {
      typeError(ctx, kindOf(value), t);
      return undefined;
    }
    return value.map((item) => decodeValue(item, t.elem, ctx) ?? decodeStruct({}, t.elem, ctx));
  }
  if (typeof value !== 'object' || Array.isArray(value) || value instanceof NumberLiteral) {
    typeError(ctx, kindOf(value), t);
    return undefined;
  }
  return decodeStruct(value as Record<string, unknown>, t, ctx);
}

function decodeStruct(object: Record<string, unknown>, t: StructType, ctx: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    const field =
      t.fields.find((f) => f.json === key) ?? t.fields.find((f) => f.json.toLowerCase() === key.toLowerCase());
    if (!field) continue;
    const inner: Context = { struct: t, path: [...ctx.path, field.json], error: ctx.error };
    const decoded = decodeValue(value, field.type, inner);
    ctx.error ??= inner.error;
    if (decoded !== undefined) out[field.name] = decoded;
  }
  return out;
}

/**
 * 按 Go 的规则把 body 解码成 t 描述的结构体，返回原始字段（Go 名字 → 值，缺省的不出现）。
 * 语法错误与类型错误都抛出，文案与 Go 的 json.Unmarshal 相同。
 */
export function unmarshal(body: string | Uint8Array, t: StructType): Record<string, unknown> {
  // Go 先对整份输入做语法检查，语法错误优先于类型错误。
  const syntax = checkValid(body);
  if (syntax !== null) throw new Error(syntax);
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  const parsed: unknown = JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === 'number' ? new NumberLiteral(context?.source ?? String(value), value) : value,
  );
  const ctx: Context = { path: [] };
  const decoded = decodeValue(parsed, t, ctx);
  if (ctx.error !== undefined) throw new Error(ctx.error);
  return (decoded as Record<string, unknown> | undefined) ?? {};
}

// ---- encoding/json 的 checkValid ----
//
// 照 Go scanner 的状态机写成递归下降，错误出现的位置与文案逐字一致。Go 在输入结束时会再喂一个
// 空格：此时能接受空白的状态报「unexpected end of JSON input」，不能接受的（数字的小数点后、
// 字面量中间、转义里）报「invalid character ' ' …」。

class SyntaxError extends Error {}

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

function checkValid(body: string | Uint8Array): string | null {
  // 按字节检查：非法 UTF-8 字节要按原字节报，不能先解码成 U+FFFD。
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  let i = 0;
  const at = (): number => (i < data.length ? data[i] : -1);
  const invalid = (context: string): never => {
    // 输入结束时 Go 喂进来的是空格。
    const c = i < data.length ? data[i] : 0x20;
    throw new SyntaxError(`invalid character ${quoteChar(c)} ${context}`);
  };
  const skipSpace = (): void => {
    while (i < data.length && (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d)) i++;
    if (i >= data.length) throw new SyntaxError(endOfInput);
  };
  const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
  const isHexByte = (c: number): boolean => isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);

  const literal = (word: string): void => {
    i++;
    for (let k = 1; k < word.length; k++) {
      if (at() !== word.charCodeAt(k)) invalid(`in literal ${word} (expecting '${word[k]}')`);
      i++;
    }
  };

  const string = (): void => {
    i++; // 开头的引号
    for (;;) {
      if (i >= data.length) throw new SyntaxError(endOfInput);
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
    while (i < data.length && (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d)) i++;
    if (i < data.length) invalid('after top-level value');
    return null;
  } catch (err) {
    if (err instanceof SyntaxError) return err.message;
    throw err;
  }
}
