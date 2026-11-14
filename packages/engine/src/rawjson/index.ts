/**
 * Go 里 `var fields map[string]json.RawMessage; json.Unmarshal(raw, &fields)` 改几个键再
 * `json.MarshalIndent(fields, "", "  ")` 的写法（am beat cues、am song cues 用它改 scene.json）。
 *
 * 不能用 JSON.parse 再写回：RawMessage 保留数字原文（2.50 仍是 2.50），而 map 的输出按键排序、
 * 字符串里的 < > & 与 U+2028/U+2029 按 json.Marshal 的 compact 规则转义。这是现行的固定格式：
 * 差一个字节，渲染指纹就对不上、已渲染的镜头全被判为过期。
 */
import { decodeObject, indent } from './jsonedit';
export { compact, decodeObject, encodeObject, findField, indent, setField } from './jsonedit';
export type { Field } from './jsonedit';
import { marshal } from '../gojson';

/** json.Unmarshal 到 map[string]json.RawMessage：重复键后者覆盖前者。顶层不是对象时给出 Go 的报错。 */
export function decodeRawMap(text: string): Map<string, string> {
  const trimmed = text.replace(/^[ \t\r\n]+/, '');
  const fields = (() => {
    if (trimmed !== '' && trimmed[0] !== '{') {
      // 先让语法检查给出 Go 的语法错误；语法正确但不是对象时是类型错误。
      try {
        decodeObject(text);
      } catch (err) {
        const message = (err as Error).message;
        if (message !== '期望一个 JSON 对象') throw err;
      }
      const kind = trimmed[0] === '[' ? 'array' : trimmed[0] === '"' ? 'string' : trimmed[0] === 't' || trimmed[0] === 'f' ? 'bool' : trimmed[0] === 'n' ? '' : 'number';
      if (kind === '') return [];
      throw new Error(`json: cannot unmarshal ${kind} into Go value of type map[string]json.RawMessage`);
    }
    return decodeObject(text);
  })();
  const out = new Map<string, string>();
  for (const f of fields) out.set(f.key, f.value);
  return out;
}

/** json.Marshal 对 RawMessage 做的 compact（escapeHTML 为 true）。 */
export function compactHTML(raw: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (c === '\\') {
        out += c + raw[i + 1];
        i++;
        continue;
      }
      if (c === '"') inString = false;
      if (c === '<') out += '\\u003c';
      else if (c === '>') out += '\\u003e';
      else if (c === '&') out += '\\u0026';
      else if (c.charCodeAt(0) === 0x2028) out += '\\u2028';
      else if (c.charCodeAt(0) === 0x2029) out += '\\u2029';
      else out += c;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') out += c;
  }
  return out;
}

/** json.MarshalIndent(map[string]json.RawMessage, "", "  ")：键按字节序排序。不带结尾换行。 */
export function encodeRawMapIndent(fields: ReadonlyMap<string, string>): string {
  const keys = [...fields.keys()].sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
  if (keys.length === 0) return '{}';
  const compact = '{' + keys.map((k) => marshal(k) + ':' + compactHTML(fields.get(k)!)).join(',') + '}';
  return indent(compact);
}
