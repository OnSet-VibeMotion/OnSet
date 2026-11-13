// encoding/json 解码进 scene 包结构体的最小复刻。
//
// 与 gojson/decode 同一套规则（键名先精确、再不区分大小写匹配；null 保留零值；int 只收十进制整数原文；
// 报文档顺序里的第一个错误），语法检查与 Decoder 的「只读第一个值」也直接借用那边的实现。
// 这里多出两种 gojson/decode 没有的类型：
//   - ptr：Go 的指针字段（*Cast、*Timing、*int……）。缺省与 null 都是 nil（TS 的 null），
//     出现即分配——Scene.Cast 为 nil 与「cast 块存在」是两种行为，不能用零值结构体代替。
//   - map：map[string]string（渲染记录的 parts）。
import { goQuote } from '../gofmt';
import { checkValid, decodeFirst as goDecodeFirst, type FieldType as GoFieldType } from '../gojson/decode';

export type FieldType =
  | 'int'
  | 'int64'
  | 'float'
  | 'string'
  | 'bool'
  | { kind: 'slice'; elem: FieldType }
  | { kind: 'ptr'; elem: FieldType }
  | { kind: 'map'; elem: FieldType }
  | StructType;

export interface StructType {
  kind: 'struct';
  /** reflect.Type.String()，如 scene.Scene。 */
  goName: string;
  /** reflect.Type.Name()，如 Scene。 */
  name: string;
  fields: Array<[json: string, type: FieldType]>;
}

export const sliceOf = (elem: FieldType): FieldType => ({ kind: 'slice', elem });
export const ptrTo = (elem: FieldType): FieldType => ({ kind: 'ptr', elem });
export const mapOf = (elem: FieldType): FieldType => ({ kind: 'map', elem });

/** 把 gojson/decode 的结构体描述（没有指针与 map）当作本包的描述用。 */
export function fromGoStruct(t: GoFieldType): FieldType {
  return t as FieldType;
}

class NumberLiteral {
  constructor(readonly source: string) {}
}

function goTypeName(t: FieldType): string {
  if (typeof t === 'string') return t === 'float' ? 'float64' : t;
  switch (t.kind) {
    case 'slice':
      return '[]' + goTypeName(t.elem);
    case 'ptr':
      return goTypeName(t.elem);
    case 'map':
      return 'map[string]' + goTypeName(t.elem);
    default:
      return t.goName;
  }
}

/** Go 的零值：指针、切片、map 为 null。 */
export function zeroOf(t: FieldType): unknown {
  if (typeof t === 'string') {
    if (t === 'string') return '';
    if (t === 'bool') return false;
    return 0;
  }
  if (t.kind !== 'struct') return null;
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
  if (typeof t === 'string') {
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
  }
  switch (t.kind) {
    case 'ptr':
      return decodeValue(value, t.elem, ctx, where);
    case 'slice':
      if (!Array.isArray(value)) {
        typeError(ctx, where, kindOf(value), t);
        return null;
      }
      return value.map((item) => decodeValue(item, t.elem, ctx, where));
    case 'map': {
      if (typeof value !== 'object' || Array.isArray(value) || value instanceof NumberLiteral) {
        typeError(ctx, where, kindOf(value), t);
        return null;
      }
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = decodeValue(item, t.elem, ctx, where);
      return out;
    }
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

function toText(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
}

/** json.Unmarshal：先对整份输入做语法检查，再按类型解码。 */
export function unmarshal<T>(body: string | Uint8Array, t: StructType): T {
  const syntax = checkValid(body);
  if (syntax !== null) throw new Error(syntax);
  return decodeText<T>(toText(body), t, false);
}

/** json.NewDecoder(r).Decode：只读第一个值，之后的内容不看。 */
export function decodeFirst<T>(body: string | Uint8Array, t: StructType, disallowUnknown: boolean): T {
  // 借 gojson/decode 的 Decoder 做语法检查并找出第一个值的结尾。给它一个没有字段的同名结构体：
  // 不会产生字段级的类型错误，顶层不是对象时报的「Go value of type <goName>」与这里一致。
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const { rest } = goDecodeFirst<unknown>(data, { kind: 'struct', goName: t.goName, name: t.name, fields: [] }, false);
  const first = Buffer.from(data.subarray(0, data.length - rest.length)).toString('utf8');
  return decodeText<T>(first, t, disallowUnknown);
}

/**
 * json.Unmarshal(body, &map[string]json.RawMessage)：返回顶层键（重复键以后者为准）。
 * 顶层是 null 时返回 null（Go 的 nil map）。
 */
export function topLevelKeys(body: string | Uint8Array): string[] | null {
  const syntax = checkValid(body);
  if (syntax !== null) throw new Error(syntax);
  const value = parseLiteral(toText(body));
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || value instanceof NumberLiteral) {
    throw new Error(`json: cannot unmarshal ${kindOf(value)} into Go value of type map[string]json.RawMessage`);
  }
  return Object.keys(value as Record<string, unknown>);
}
