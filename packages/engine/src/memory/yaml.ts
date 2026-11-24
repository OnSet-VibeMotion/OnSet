// 记忆文件 frontmatter 的读写，按 gopkg.in/yaml.v3 的规则。只供本包内部使用。
//
// 写出：现行的固定格式是 yaml.v3 的 Encoder + SetIndent(2)。记忆文件内容进快照、参与摘要，
// 写法哪怕引号风格差一点，快照摘要就对不上、Drift 全报漂移。
// 所以照 yaml.v3 的 encode.go（何时必须加引号）与 emitterc.go（libyaml 的标量分析与
// 风格选择、双引号转义）移植了需要的那部分：字符串标量、字符串序列、一层嵌套映射。
// yaml.v3 的行宽是无限（best_width = -1），不折行。
//
// 读入：Decoder.KnownFields(true)，未知字段报错；任何标量都能进 string（取原文）。
import { analyze, base60Float, isBreak, isPrintable, oldBools, resolvesToString } from './yaml_scalar';

export { decodeStrict, type FieldSchema } from './yaml_decode';

// ---- 写出 ----

function doubleQuoted(value: string): string {
  // yaml.v3 的 is_bom(b, i) 忽略 i、只看缓冲区开头：值以 BOM 开头时，后面每个字符都被转义。
  const bom = value.codePointAt(0) === 0xfeff;
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (bom || !isPrintable(c) || isBreak(c) || c === 0x22 || c === 0x5c) {
      out += '\\';
      switch (c) {
        case 0x00:
          out += '0';
          break;
        case 0x07:
          out += 'a';
          break;
        case 0x08:
          out += 'b';
          break;
        case 0x09:
          out += 't';
          break;
        case 0x0a:
          out += 'n';
          break;
        case 0x0b:
          out += 'v';
          break;
        case 0x0c:
          out += 'f';
          break;
        case 0x0d:
          out += 'r';
          break;
        case 0x1b:
          out += 'e';
          break;
        case 0x22:
          out += '"';
          break;
        case 0x5c:
          out += '\\';
          break;
        case 0x85:
          out += 'N';
          break;
        case 0xa0:
          out += '_';
          break;
        case 0x2028:
          out += 'L';
          break;
        case 0x2029:
          out += 'P';
          break;
        default: {
          const hex = c.toString(16).toUpperCase();
          if (c <= 0xff) out += 'x' + hex.padStart(2, '0');
          else if (c <= 0xffff) out += 'u' + hex.padStart(4, '0');
          else out += 'U' + hex.padStart(8, '0');
        }
      }
    } else {
      out += ch;
    }
  }
  return out + '"';
}

/**
 * 字面块（|）：yaml_emitter_write_block_scalar_hints 与 write_literal_scalar。
 * 照抄 libyaml 的写法：正文第一个字符是换行时，它被当成头部那一行的行尾写出（yaml.v3 的
 * 写法本身会丢掉这个前导换行，这里照样丢，否则写出的字节与现行格式不同）。
 * 返回写出的文本，以及结尾是否停在行首（是则后面不用再补换行）。
 */
function literal(value: string, indent: string): { text: string; atLineStart: boolean } {
  let hints = '|';
  const cps = [...value].map((ch) => ch.codePointAt(0)!);
  if (cps[0] === 0x20 || isBreak(cps[0])) hints += '2';
  const last = cps.length - 1;
  if (!isBreak(cps[last])) hints += '-';
  else if (last === 0 || isBreak(cps[last - 1])) hints += '+';
  let out = hints;
  let atLineStart = false;
  let breaks = true;
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (isBreak(c)) {
      out += ch;
      atLineStart = true;
      breaks = true;
    } else {
      if (breaks) {
        if (!atLineStart) out += '\n';
        out += indent;
        breaks = false;
      }
      out += ch;
      atLineStart = false;
    }
  }
  return { text: out, atLineStart };
}

/** 单引号标量：换行类字符原样写出，其后的正文先补到缩进位置（yaml_emitter_write_single_quoted_scalar）。 */
function singleQuoted(value: string, indent: string): string {
  let out = "'";
  let breaks = false;
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (isBreak(c)) {
      out += ch;
      breaks = true;
    } else {
      if (breaks) out += indent;
      breaks = false;
      out += ch === "'" ? "''" : ch;
    }
  }
  return out + "'";
}

/** 一个字符串值在 「key: 」 之后的写法（含换行）。indent 是块标量正文的缩进。 */
function scalar(value: string, indent: string): string {
  let style: 'plain' | 'single' | 'double' | 'literal';
  const canUsePlain = resolvesToString(value) && !(base60Float.test(value) || oldBools.has(value));
  if (value.includes('\n')) style = 'literal';
  else if (canUsePlain) style = 'plain';
  else style = 'double';
  const a = analyze(value);
  if (style === 'plain' && !a.blockPlainAllowed) style = 'single';
  if (style === 'single' && !a.singleQuotedAllowed) style = 'double';
  if (style === 'literal' && !a.blockAllowed) style = 'double';
  switch (style) {
    case 'plain':
      return value + '\n';
    case 'single':
      return singleQuoted(value, indent) + '\n';
    case 'double':
      return doubleQuoted(value) + '\n';
    case 'literal': {
      const { text, atLineStart } = literal(value, indent);
      return atLineStart ? text : text + '\n';
    }
  }
}

/** frontmatter 里的一项：字符串、字符串序列，或一层嵌套映射。undefined 表示 omitempty 省略。 */
export type YamlValue = string | string[] | Array<[string, YamlValue | undefined]>;

function emit(entries: Array<[string, YamlValue | undefined]>, indent: string): string {
  let out = '';
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      out += indent + key + ': ' + scalar(value, indent + '  ');
    } else if (value.length === 0) {
      out += indent + key + ': []\n';
    } else if (typeof value[0] === 'string') {
      out += indent + key + ':\n';
      for (const item of value as string[]) out += indent + '  - ' + scalar(item, indent + '    ');
    } else {
      out += indent + key + ':\n' + emit(value as Array<[string, YamlValue | undefined]>, indent + '  ');
    }
  }
  return out;
}

/** yaml.NewEncoder(w).SetIndent(2).Encode(mapping)。 */
export function encodeMapping(entries: Array<[string, YamlValue | undefined]>): string {
  const out = emit(entries, '');
  return out === '' ? '{}\n' : out;
}
