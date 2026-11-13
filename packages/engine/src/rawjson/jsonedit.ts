// 移植自 internal/castbeats/jsonedit.go，外加 Go 的 json.Compact / json.Indent。
import { checkValid } from '../beat/jsondecode';
import { marshal } from '../gojson';

/** JSON 对象里的一个键值对，value 保留源文件里的原始文本。 */
export interface Field {
  key: string;
  value: string;
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function skipSpace(text: string, i: number): number {
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

/** 从 i 处的字符串开头（"）读到结尾引号之后。输入已经过语法检查。 */
function scanString(text: string, i: number): number {
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === '"') return i + 1;
    else i++;
  }
  return i;
}

/** 从 i 处读完一个 JSON 值，返回其后的位置。输入已经过语法检查。 */
function scanValue(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return scanString(text, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < text.length) {
      const d = text[i];
      if (d === '"') {
        i = scanString(text, i);
        continue;
      }
      if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  // 数字与 true / false / null：读到分隔符为止。
  while (i < text.length && !isSpace(text[i]) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i++;
  return i;
}

/**
 * 把一个 JSON 对象拆成保序的键值对，每个值都是原始文本。
 *
 * 不用普通对象是因为 JSON.parse 会丢掉重复键、也不保留数字原文：本命令只改
 * cast.beats 一个字段，重排其它键会让每次运行都产生一大片与本命令无关的
 * diff，作者再也看不出来 am 到底改了什么。
 */
export function decodeObject(raw: string): Field[] {
  const syntax = checkValid(raw);
  if (syntax !== null) throw new Error(syntax);
  let i = skipSpace(raw, 0);
  if (raw[i] !== '{') throw new Error('期望一个 JSON 对象');
  i = skipSpace(raw, i + 1);
  const fields: Field[] = [];
  if (raw[i] === '}') return fields;
  for (;;) {
    const keyEnd = scanString(raw, i);
    const key = JSON.parse(raw.slice(i, keyEnd)) as string;
    i = skipSpace(raw, keyEnd);
    i = skipSpace(raw, i + 1); // 冒号
    const valueEnd = scanValue(raw, i);
    fields.push({ key, value: raw.slice(i, valueEnd) });
    i = skipSpace(raw, valueEnd);
    if (raw[i] === ',') {
      i = skipSpace(raw, i + 1);
      continue;
    }
    return fields;
  }
}

/** json.Compact：去掉字符串之外的空白，其余原样保留（不做 HTML 转义）。 */
export function compact(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      const end = scanString(raw, i);
      out += raw.slice(i, end);
      i = end - 1;
    } else if (!isSpace(c)) out += c;
  }
  return out;
}

/** json.Indent(dst, src, "", indent)：src 视为紧凑或带空白的合法 JSON；空对象与空数组写成 {} / []。 */
export function indent(src: string, unit = '  '): string {
  let out = '';
  let depth = 0;
  let needIndent = false;
  const newline = () => '\n' + unit.repeat(depth);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (isSpace(c)) continue;
    if (needIndent && c !== '}' && c !== ']') {
      needIndent = false;
      depth++;
      out += newline();
    }
    if (c === '"') {
      const end = scanString(src, i);
      out += src.slice(i, end);
      i = end - 1;
      continue;
    }
    switch (c) {
      case '{':
      case '[':
        needIndent = true;
        out += c;
        break;
      case ',':
        out += c + newline();
        break;
      case ':':
        out += ': ';
        break;
      case '}':
      case ']':
        if (needIndent) needIndent = false;
        else {
          depth--;
          out += newline();
        }
        out += c;
        break;
      default:
        out += c;
    }
  }
  return out;
}

/** 把保序键值对拼回紧凑 JSON 对象。值原样透出，只做 compact，所以数字写法与字符串转义都不变。 */
export function encodeObject(fields: readonly Field[]): string {
  return '{' + fields.map((f) => marshal(f.key) + ':' + compact(f.value)).join(',') + '}';
}

/** 覆盖已有键的值，键不存在时追加到末尾。原地修改并返回。 */
export function setField(fields: Field[], key: string, value: string): Field[] {
  for (const f of fields) {
    if (f.key === key) {
      f.value = value;
      return fields;
    }
  }
  fields.push({ key, value });
  return fields;
}

/** 取某个键的原始值，不存在时返回 undefined。 */
export function findField(fields: readonly Field[], key: string): string | undefined {
  return fields.find((f) => f.key === key)?.value;
}
