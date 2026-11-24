/**
 * yaml.v3 的标量解析（resolve.go）：tag 常量、整数/浮点/时间戳解析。
 */
import { GoFloat, GoTime, YamlDecodeError } from './yamlany_values';

export const strTag = '!!str';
export const boolTag = '!!bool';
export const intTag = '!!int';
export const floatTag = '!!float';
export const timestampTag = '!!timestamp';
export const nullTag = '!!null';
export const mergeTag = '!!merge';
export const mapTag = '!!map';
export const seqTag = '!!seq';
export const binaryTag = '!!binary';

const longTagPrefix = 'tag:yaml.org,2002:';

export function shortTag(tag: string): string {
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
  if (signed ? value > 9223372036854775807n || value < -9223372036854775808n : value > 18446744073709551615n) {
    return null;
  }
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

/** yaml.v3 的 resolve(tag, in)。 */
export function resolve(tag: string, input: string): [string, unknown] {
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
