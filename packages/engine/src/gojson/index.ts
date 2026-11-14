/**
 * am 现行的固定 JSON 写法（规则取自 Go encoding/json）。
 *
 * 项目文件、记忆库与渲染指纹都按这份写法逐字节固定：写法一变，同样的输入就算出不同的摘要，
 * 已渲染的镜头全被判为过期。凡是要落盘或参与摘要的 JSON 都必须经这里，不要用 JSON.stringify。
 *
 * 与 JSON.stringify 的差别：
 * - 默认把 < > & 转义成 < > &（Go 的 HTML 转义）；Encoder.SetEscapeHTML(false) 对应 escapeHTML: false。
 * - U+2028、U+2029 总是转义。
 * - 控制字符里 \b \f \n \r \t 用短写法，其余写成 \u00XX（与 Go 1.22+ 一致，测试里的期望值取自真实的 Go 输出）。
 * - -0 写成 -0。
 * - Go 的 map 按键排序输出；TS 对象没有 map 与 struct 之分，调用方在 Go 用 map 的地方用 sortedKeys() 包一下。
 *
 * undefined 字段像 JSON.stringify 一样被跳过，这正好对应 Go 的 omitempty 被省略的情形；
 * 但 omitempty 的判定（零值、空串、空切片）要由调用方在构造对象时自己做，这里不猜。
 */

export interface MarshalOptions {
  /** 缩进字符串，对应 MarshalIndent 的 indent；空串表示紧凑输出（Marshal）。 */
  indent?: string;
  /** 对应 SetEscapeHTML，默认 true。 */
  escapeHTML?: boolean;
}

const hex = '0123456789abcdef';

function encodeString(s: string, escapeHTML: boolean): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c < 0x20 || c === 0x2028 || c === 0x2029 || (escapeHTML && (c === 0x3c || c === 0x3e || c === 0x26))) {
      out += '\\u' + (c < 0x100 ? '00' + hex[c >> 4] + hex[c & 15] : c.toString(16));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else out += '\\ufffd';
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += '\\ufffd';
    } else out += s[i];
  }
  return out + '"';
}

function encodeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`json: unsupported value: ${n}`);
  if (Object.is(n, -0)) return '-0';
  return String(n);
}

function encode(value: unknown, escapeHTML: boolean, indent: string, prefix: string): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return encodeString(value, escapeHTML);
    case 'number':
      return encodeNumber(value);
    case 'bigint':
      return value.toString();
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }
  const v = value as { toJSON?: () => unknown };
  if (typeof v.toJSON === 'function' && !(value instanceof Date)) return encode(v.toJSON(), escapeHTML, indent, prefix);
  if (value instanceof Date) return encodeString(value.toISOString(), escapeHTML);
  const inner = prefix + indent;
  const nl = indent ? '\n' : '';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => (indent ? inner : '') + (encode(item, escapeHTML, indent, inner) ?? 'null'));
    return '[' + nl + items.join(',' + nl) + nl + (indent ? prefix : '') + ']';
  }
  const entries: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const encoded = encode(item, escapeHTML, indent, inner);
    if (encoded === undefined) continue;
    entries.push((indent ? inner : '') + encodeString(key, escapeHTML) + (indent ? ': ' : ':') + encoded);
  }
  if (entries.length === 0) return '{}';
  return '{' + nl + entries.join(',' + nl) + nl + (indent ? prefix : '') + '}';
}

/** json.Marshal（indent 为空）或 json.MarshalIndent(v, "", indent)。 */
export function marshal(value: unknown, options: MarshalOptions = {}): string {
  return encode(value, options.escapeHTML ?? true, options.indent ?? '', '') ?? 'null';
}

/** json.MarshalIndent(v, "", "  ")：仓库里最常见的写法。 */
export function marshalIndent(value: unknown, indent = '  ', escapeHTML = true): string {
  return marshal(value, { indent, escapeHTML });
}

/** json.NewEncoder(w).Encode(v)：在 Marshal 结果后加一个换行。SetIndent 与 SetEscapeHTML 经 options 给。 */
export function encodeLine(value: unknown, options: MarshalOptions = {}): string {
  return marshal(value, options) + '\n';
}

/** 按键的字典序（Go 按字节序，与 UTF-16 码元序对 BMP 内字符一致）重排对象，对应 Go map 的输出顺序。 */
export function sortedKeys<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort(compareBytes)) out[key] = record[key];
  return out;
}

/** Go 的字符串比较按 UTF-8 字节序；对代理对以外的字符与 UTF-16 码元序相同，这里按码点比较以覆盖全部情形。 */
export function compareBytes(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i].codePointAt(0)!;
    const y = cb[i].codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return ca.length - cb.length;
}
