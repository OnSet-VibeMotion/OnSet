import fs from 'node:fs';
import { compareBytes } from '../gojson';
import { formatG, goPathError, goQuote } from '../gofmt';
import { checkValid } from '../beat/jsondecode';

/**
 * Item 是对齐工具输出的一条带时间的文本（通常是一个字或一个词），时间单位为秒，
 * 已加上所在段的偏移。
 */
export interface Item {
  text: string;
  start: number;
  end: number;
  segment: number;
}

/** Segment 是一个对齐结果文件及其在整条配音里的起点。 */
export interface Segment {
  path: string;
  offset: number;
}

/** strconv.ParseFloat 能接受的十进制写法（不含 Go 也接受的十六进制浮点、Inf、NaN，它们在这里都会被拒绝）。 */
const floatLiteral = /^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?$/;

function parseFloat64(raw: string): number | null {
  const lower = raw.toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(lower)) return raw.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(lower)) return NaN;
  // Go 的 ParseFloat 只在以 0x 开头的写法或数字之间允许下划线；这里一并按非法处理下划线。
  if (!floatLiteral.test(raw) || raw.includes('_')) return null;
  return Number(raw);
}

/** ParseSegmentFlag 解析 --align 的取值 FILE[@OFFSET_SECONDS]。 */
export function parseSegmentFlag(value: string): Segment {
  const at = value.lastIndexOf('@');
  if (at < 0) return { path: value, offset: 0 };
  const file = value.slice(0, at);
  const raw = value.slice(at + 1);
  const offset = parseFloat64(raw);
  if (offset === null || file === '' || offset < 0 || !Number.isFinite(offset)) {
    throw new Error(`--align ${goQuote(value)} 不合法：应为 文件[@偏移秒数]，偏移是非负数`);
  }
  return { path: file, offset };
}

/** CanonicalShape 写进帮助与报错：认不出的对齐结果统一转成这个形状。 */
export const CanonicalShape = '[{"text":"字","start":0.12,"end":0.20}, ...]（秒）';

/** LoadSegments 按顺序读入各段对齐结果，平移后首尾相接。 */
export function loadSegments(segments: Segment[]): Item[] {
  const items: Item[] = [];
  segments.forEach((seg, index) => {
    for (const item of loadEvidence(seg.path)) {
      items.push({ text: item.text, start: item.start + seg.offset, end: item.end + seg.offset, segment: index });
    }
  });
  return items;
}

/**
 * LoadEvidence 读取一个对齐结果文件，返回未平移的条目。
 *
 * 各对齐工具的输出格式没有逐一实测过，所以读取是宽容的：
 *   - 规范形状 [{"text","start","end"}]，秒；
 *   - funasr：[{"text":"空格 分隔 的 字","timestamp":[[起毫秒,止毫秒],...]}]，可嵌在任意层；
 *   - 其他：在 JSON 里找第一个「每个元素都有文本字段（text/word/char/token）和数值起止」
 *     的对象数组。起止字段名为 start/end、start_time/end_time 时按秒，start_ms/end_ms 按毫秒。
 */
export function loadEvidence(file: string): Item[] {
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`无法读取对齐结果：${goPathError('open', file, err)}`, { cause: err });
  }
  const syntax = checkValid(body);
  if (syntax !== null) throw new Error(`${file} 不是合法 JSON：${syntax}`);
  const root: unknown = JSON.parse(body.toString('utf8'));
  let found: Item[] | null;
  try {
    found = findItems(root);
  } catch (err) {
    throw new Error(`${file}：${(err as Error).message}`, { cause: err });
  }
  if (found === null) throw new Error(`${file} 的结构认不出（${describe(root)}）。请先转换成 ${CanonicalShape}`);
  found.forEach((item, i) => {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start) {
      throw new Error(`${file} 第 ${i + 1} 条（${goQuote(item.text)}）的起止时间不合法：${formatG(item.start)} → ${formatG(item.end)}`);
    }
    // 六小时以上的秒数几乎一定是把毫秒当成了秒。
    if (item.end > 6 * 3600) throw new Error(`${file} 第 ${i + 1} 条的结束时间 ${formatG(item.end)} 秒超过 6 小时，像是毫秒；请转换成 ${CanonicalShape}`);
  });
  return found;
}

type JSONObject = Record<string, unknown>;

function isObject(v: unknown): v is JSONObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** findItems 深度优先找第一个认得的数组。对象的键按字典序遍历，结果与 JSON 键顺序无关。没找到返回 null。 */
function findItems(node: unknown): Item[] | null {
  if (Array.isArray(node)) {
    const funasr = funasrItems(node);
    if (funasr !== null) return funasr;
    const timed = timedItems(node);
    if (timed !== null) return timed;
    for (const child of node) {
      const items = findItems(child);
      if (items !== null) return items;
    }
  } else if (isObject(node)) {
    for (const key of sortedKeys(node)) {
      const items = findItems(node[key]);
      if (items !== null) return items;
    }
  }
  return null;
}

const textKeys = ['text', 'word', 'char', 'token'];

const timeKeyPairs: { start: string; end: string; scale: number }[] = [
  { start: 'start', end: 'end', scale: 1 },
  { start: 'start_time', end: 'end_time', scale: 1 },
  { start: 'start_ms', end: 'end_ms', scale: 0.001 },
];

/** timedItems 认「每个元素都有文本与数值起止」的对象数组。 */
function timedItems(values: unknown[]): Item[] | null {
  if (values.length === 0) return null;
  const items: Item[] = [];
  for (const raw of values) {
    if (!isObject(raw)) return null;
    const text = textField(raw);
    if (text === null) return null;
    let matched = false;
    for (const keys of timeKeyPairs) {
      const start = raw[keys.start];
      const end = raw[keys.end];
      if (typeof start === 'number' && typeof end === 'number') {
        items.push({ text, start: start * keys.scale, end: end * keys.scale, segment: 0 });
        matched = true;
        break;
      }
    }
    if (!matched) return null;
  }
  return items;
}

function textField(object: JSONObject): string | null {
  for (const key of textKeys) {
    const text = object[key];
    if (typeof text === 'string') return text;
  }
  return null;
}

/** strings.Fields：按 Unicode 空白切分并丢掉空串。 */
function fields(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    if (isSpaceChar(ch.codePointAt(0)!)) {
      if (current !== '') out.push(current);
      current = '';
    } else current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

function isSpaceChar(r: number): boolean {
  if (r === 0x09 || r === 0x0a || r === 0x0b || r === 0x0c || r === 0x0d || r === 0x20 || r === 0x85 || r === 0xa0) return true;
  return r === 0x1680 || (r >= 0x2000 && r <= 0x200a) || r === 0x2028 || r === 0x2029 || r === 0x202f || r === 0x205f || r === 0x3000;
}

/**
 * funasrItems 认 funasr 时间戳预测的输出：text 以空格分隔，timestamp 是等长的毫秒区间表。
 * 认不出返回 null；认出了但内容不对时抛错。
 */
function funasrItems(values: unknown[]): Item[] | null {
  if (values.length === 0) return null;
  const items: Item[] = [];
  for (const raw of values) {
    if (!isObject(raw)) return null;
    const text = raw.text;
    const stamps = raw.timestamp;
    if (typeof text !== 'string' || !Array.isArray(stamps)) return null;
    const words = fields(text);
    if (words.length !== stamps.length) {
      throw new Error(`funasr 结果的 text 有 ${words.length} 个单元，timestamp 却有 ${stamps.length} 组，无法逐一对应`);
    }
    stamps.forEach((stamp, i) => {
      if (!Array.isArray(stamp) || stamp.length !== 2) throw new Error(`funasr 结果第 ${i + 1} 个 timestamp 不是 [起, 止] 两个数`);
      const [start, end] = stamp as unknown[];
      if (typeof start !== 'number' || typeof end !== 'number') throw new Error(`funasr 结果第 ${i + 1} 个 timestamp 不是数值`);
      items.push({ text: words[i], start: start / 1000, end: end / 1000, segment: 0 });
    });
  }
  return items;
}

function sortedKeys(object: JSONObject): string[] {
  return Object.keys(object).sort(compareBytes);
}

/** Go 的 %T：JSON 解码进 any 之后只会出现这几种类型。 */
function goTypeOf(value: unknown): string {
  if (value === null) return '<nil>';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'float64';
  if (typeof value === 'boolean') return 'bool';
  if (Array.isArray(value)) return '[]interface {}';
  return 'map[string]interface {}';
}

/** describe 给出顶层结构的简述，报错时让操作者知道该怎么转换。 */
function describe(node: unknown): string {
  if (isObject(node)) return '顶层是对象，键：' + sortedKeys(node).join(', ');
  if (Array.isArray(node)) {
    if (node.length === 0) return '顶层是空数组';
    const first = node[0];
    if (isObject(first)) return `顶层是 ${node.length} 个元素的数组，首元素的键：${sortedKeys(first).join(', ')}`;
    return `顶层是 ${node.length} 个元素的数组，首元素类型 ${goTypeOf(first)}`;
  }
  return `顶层是 ${goTypeOf(node)}`;
}
