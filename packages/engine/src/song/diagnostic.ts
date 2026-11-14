import { compareBytes } from '../gojson';
import { decodeValue } from './jsondecode';

/**
 * Keep provider output bounded and in memory only. Only the structured, redacted
 * error is persisted; successful responses may contain signed URLs or audio hex.
 */
export class DiagnosticBuffer {
  data: Buffer = Buffer.alloc(0);

  write(p: Uint8Array): number {
    const n = p.length;
    const remaining = 65536 - this.data.length;
    const slice = p.length > remaining ? p.subarray(0, remaining) : p;
    this.data = Buffer.concat([this.data, slice]);
    return n;
  }
}

export interface Diagnostic {
  code: number;
  message: string;
}

export function diagnosticToJSON(d: Diagnostic): unknown {
  return { code: d.code, message: d.message };
}

/**
 * RE2 的 (?i) 按 Unicode 简单大小写折叠：s 还匹配 ſ（U+017F），k 还匹配 K（U+212A）。
 * JS 不带 u 的 i 标志不做这两个折叠，所以把字面量里的字母展开成字符类，不用 i 标志。
 */
function ci(literal: string): string {
  let out = '';
  for (const c of literal) {
    const lower = c.toLowerCase();
    if (lower >= 'a' && lower <= 'z') {
      let cls = lower + lower.toUpperCase();
      if (lower === 's') cls += String.fromCodePoint(0x17f);
      if (lower === 'k') cls += String.fromCodePoint(0x212a);
      out += '[' + cls + ']';
    } else {
      out += c;
    }
  }
  return out;
}

/** RE2 的 \s：只含 ASCII 空白，不含 \v。 */
const S = '\\t\\n\\f\\r ';

const diagnosticRedactions: RegExp[] = [
  // (?i)https?://[^\s<>"']+
  new RegExp(`${ci('http')}${ci('s')}?://[^${S}<>"']+`, 'g'),
  // (?i)\b(?:bearer|basic)\s+[^\s,;"']+
  new RegExp(`\\b(?:${ci('bearer')}|${ci('basic')})[${S}]+[^${S},;"']+`, 'g'),
  // (?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*[^\s,;]+
  new RegExp(
    `\\b(?:${ci('api')}[_-]?${ci('key')}|${ci('access')}[_-]?${ci('token')}|${ci('refresh')}[_-]?${ci('token')}|${ci('token')}|${ci('secret')}|${ci('password')})[${S}]*[=:][${S}]*[^${S},;]+`,
    'g',
  ),
  /\bsk-[A-Za-z0-9_-]+/g,
  /[A-Za-z0-9_./+=-]{32,}/g,
];

/** bytes.TrimSpace：去掉两端的 ASCII 空白（含 \v）与 U+0085、U+00A0。 */
function trimBytes(raw: Uint8Array): string {
  return Buffer.from(raw)
    .toString('utf8')
    .replace(/^[\t\n\v\f\r \u0085 ]+|[\t\n\v\f\r \u0085 ]+$/g, '');
}

export function providerDiagnostic(raw: Uint8Array, env: Record<string, string> | null): Diagnostic {
  const result: Diagnostic = { code: 0, message: '提供方未返回可解析的结构化错误（原始输出未保存）' };
  let envelope: { error: { code: number; message: string } };
  try {
    envelope = decodeValue(JSON.parse(trimBytes(raw)), {
      struct: [
        [
          'error',
          {
            struct: [
              ['code', 'int'],
              ['message', 'string'],
            ],
          },
        ],
      ],
    }, false) as typeof envelope;
  } catch {
    return result;
  }
  if (envelope.error.message === '') return result;
  result.code = envelope.error.code;
  let message = envelope.error.message;
  // Go 的 map 遍历无序；按键排序，结果与顺序无关的情形下与 Go 一致。
  for (const key of Object.keys(env ?? {}).sort(compareBytes)) {
    const value = env![key];
    const upper = key.toUpperCase();
    if (value !== '' && (upper.includes('KEY') || upper.includes('TOKEN') || upper.includes('SECRET') || upper.includes('PASSWORD'))) {
      message = message.split(value).join('[REDACTED]');
    }
  }
  for (const pattern of diagnosticRedactions) message = message.replace(pattern, '[REDACTED]');
  // Remove terminal control characters as well as credentials.
  message = [...message].map((r) => (r.codePointAt(0)! < 32 || r.codePointAt(0) === 127 ? ' ' : r)).join('');
  const runes = [...message];
  if (runes.length > 2000) message = runes.slice(0, 2000).join('') + '…';
  result.message = message;
  return result;
}
