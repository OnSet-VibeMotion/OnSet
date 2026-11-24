/**
 * scene_cues 落盘与保序改写 JSON 对象工具。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { marshal } from '@onset/engine/gojson';

// ---------------------------------------------------------------- 落盘

export interface PendingWrite {
  path: string;
  body: Buffer;
}

/**
 * commitWrites 分两轮落盘：先把每份新内容写成同目录的临时文件，全部成功后
 * 再逐个改名替换。磁盘满、权限不足这类错误都发生在第一轮，此时一个目标文件
 * 都还没动；第二轮只剩同文件系统内的 rename。rename 本身仍可能中途失败，
 * 那时 onset validate beat 会按网格摘要把没换上的镜头报出来。
 *
 * 内容不变的文件不重写：客户端的镜头列表靠 scene.json 的修改时间判断产物是否过期，
 * 无变化的重跑不能把所有镜头都标成需要重渲染。
 */
export function commitWrites(writes: readonly PendingWrite[]): void {
  const ready: { temp: string; path: string }[] = [];
  const cleanup = () => {
    for (const s of ready) fs.rmSync(s.temp, { force: true });
  };
  for (const w of writes) {
    try {
      if (fs.readFileSync(w.path).equals(w.body)) continue;
    } catch {
      // 不存在就写。
    }
    // os.CreateTemp(dir, "."+base+".*")：随机后缀。
    const temp = path.join(path.dirname(w.path), `.${path.basename(w.path)}.${crypto.randomInt(0, 2 ** 32)}`);
    try {
      fs.writeFileSync(temp, w.body, { flag: 'wx', mode: 0o600 });
      fs.chmodSync(temp, 0o644);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      cleanup();
      throw err;
    }
    ready.push({ temp, path: w.path });
  }
  for (let i = 0; i < ready.length; i++) {
    const s = ready[i];
    try {
      fs.renameSync(s.temp, s.path);
    } catch (err) {
      for (const rest of ready.slice(i)) fs.rmSync(rest.temp, { force: true });
      throw new Error(`写入 ${s.path} 失败，部分镜头可能仍是旧网格，请重跑 beat_cues()：${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------- 保序改写 JSON 对象

export interface JSONField {
  key: string;
  /** 原样的 JSON 文本（Go 的 json.RawMessage）。 */
  value: string;
  /** 为 true 时删掉这个字段（没有就什么也不做）。 */
  remove?: boolean;
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function skipSpace(src: string, i: number): number {
  while (i < src.length && isSpace(src[i])) i++;
  return i;
}

/** 从 i 开始扫一个 JSON 字符串（含引号），返回结束后的位置。 */
function scanString(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length && src[j] !== '"') {
    if (src[j] === '\\') j++;
    j++;
  }
  if (j >= src.length) throw new Error('unexpected end of JSON input');
  return j + 1;
}

/** 从 i 开始扫一个 JSON 值，返回结束后的位置；值本身用 JSON.parse 校验。 */
function scanValue(src: string, i: number): number {
  const c = src[i];
  let j = i;
  if (c === '"') j = scanString(src, i);
  else if (c === '{' || c === '[') {
    let depth = 0;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '"') {
        j = scanString(src, j);
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    if (depth !== 0) throw new Error('unexpected end of JSON input');
  } else {
    while (j < src.length && !isSpace(src[j]) && src[j] !== ',' && src[j] !== '}' && src[j] !== ']') j++;
  }
  JSON.parse(src.slice(i, j));
  return j;
}

/** json.Indent(dst, src, prefix, indent)：只改空白，字符串与数字原样保留。 */
function indentJSON(src: string, prefix: string, indent: string): string {
  let out = '';
  let needIndent = false;
  let depth = 0;
  const newline = () => {
    out += '\n' + prefix + indent.repeat(depth);
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (isSpace(c)) continue;
    if (needIndent && c !== '}' && c !== ']') {
      needIndent = false;
      depth++;
      newline();
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
        out += c;
        newline();
        break;
      case ':':
        out += ': ';
        break;
      case '}':
      case ']':
        if (needIndent) {
          needIndent = false;
          out += c;
        } else {
          depth--;
          newline();
          out += c;
        }
        break;
      default:
        out += c;
    }
  }
  return out;
}

/**
 * rewriteJSONObject 改写一个 JSON 对象里的若干字段：已有字段原地替换，
 * 新字段追加在末尾，其余字段的顺序与取值原样保留，整体按两格缩进重排。
 *
 * 不走 map[string]json.RawMessage：那样会把字段按字母序重排，每次运行都让
 * 手写的 scene.json 面目全非，diff 里看不出真正改了什么。
 */
export function rewriteJSONObject(raw: string, updates: readonly JSONField[]): string {
  let i = skipSpace(raw, 0);
  if (raw[i] !== '{') throw new Error('不是 JSON 对象');
  i++;
  const fields: JSONField[] = [];
  const seen = new Set<string>();
  for (;;) {
    i = skipSpace(raw, i);
    if (i >= raw.length) throw new Error('不是合法 JSON：unexpected EOF');
    if (raw[i] === '}') break;
    if (fields.length > 0) {
      if (raw[i] !== ',') throw new Error('不是合法 JSON 对象');
      i = skipSpace(raw, i + 1);
    }
    if (raw[i] !== '"') throw new Error('不是合法 JSON 对象');
    let key: string;
    let end: number;
    try {
      end = scanString(raw, i);
      key = JSON.parse(raw.slice(i, end)) as string;
    } catch (err) {
      throw new Error(`不是合法 JSON：${(err as Error).message}`);
    }
    i = skipSpace(raw, end);
    if (raw[i] !== ':') throw new Error('不是合法 JSON 对象');
    i = skipSpace(raw, i + 1);
    let valueEnd: number;
    try {
      valueEnd = scanValue(raw, i);
    } catch (err) {
      throw new Error(`字段 ${key} 不是合法 JSON：${(err as Error).message}`);
    }
    if (seen.has(key)) throw new Error(`字段 ${key} 重复`);
    seen.add(key);
    fields.push({ key, value: raw.slice(i, valueEnd) });
    i = valueEnd;
  }
  for (const u of updates) {
    if (u.remove) {
      const at = fields.findIndex((f) => f.key === u.key);
      if (at >= 0) fields.splice(at, 1);
      continue;
    }
    let replaced = false;
    for (const f of fields) {
      if (f.key === u.key) {
        f.value = u.value;
        replaced = true;
      }
    }
    if (!replaced) fields.push({ ...u });
  }
  let out = '{\n';
  fields.forEach((f, idx) => {
    out += '  ' + marshal(f.key) + ': ' + indentJSON(f.value, '  ', '  ');
    if (idx < fields.length - 1) out += ',';
    out += '\n';
  });
  return out + '}\n';
}
