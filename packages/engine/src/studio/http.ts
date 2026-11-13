/**
 * Studio 后端的 HTTP 辅助：fetch 风格的 JSON 响应、错误格式、请求体解码、文件响应（对应 http.ServeFile）
 * 与 Go 时间格式。移植自 internal/studio/studio.go 的 write / error / method 与 api_sessions.go 的 decodeJSON。
 *
 * Go 版是 net/http 处理函数；TS 版暴露 handle(request: Request): Promise<Response>，Electron 主进程用
 * am://app/ 协议承接界面请求后直接调它，vitest 里也直接构造 Request 测。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { encodeLine, sortedKeys } from '../gojson';

/** Go 的 map[string]any 写出时按键排序：凡是 Go 里用 map 字面量写响应的地方都经它。 */
export function goMap(record: Record<string, unknown>): Record<string, unknown> {
  return sortedKeys(record);
}

/**
 * Go 把任意 JSON 解进 any 后再写出时，对象变成 map[string]any，键按字节序重排。
 * 凡是「读一份 JSON、原样转给网页」的地方（review.json、上游技能记录……）都经它。
 */
export function goValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(goValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = goValue(item);
    return sortedKeys(out);
  }
  return value;
}

/**
 * json.NewDecoder(r.Body).Decode：与 decodeJSON 不同，空请求体是错误（EOF）。
 * 只读第一个 JSON 值这一点不照搬：多余的内容一并当成错误。
 */
export async function decodeJSONStrict(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === '') throw new DecodeError('EOF');
  return decodeJSON(new Request('http://x/', { method: 'POST', body: text }));
}

/** s.write：json.NewEncoder(w).Encode(value)，默认转义 < > &，末尾一个换行。 */
export function writeJSON(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(encodeLine(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** s.error：{"code","details","message","retryable"}（Go 的 map，按键排序）。 */
export function writeError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return writeJSON(status, goMap({ code, message, details: [], retryable: false }), headers);
}

/** s.method：405 并带 Allow。 */
export function methodNotAllowed(want: string): Response {
  return writeError(405, 'method_not_allowed', '只允许 ' + want, { Allow: want });
}

/** http.NotFound：纯文本 404。 */
export function notFound(): Response {
  return new Response('404 page not found\n', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

/** 请求体无法按 Go 的 json.Unmarshal 解进目标结构时抛出。 */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

/** 请求体上限（decodeJSON 的 io.LimitReader(r.Body, 1<<20)）。 */
const maxJSONBody = 1 << 20;

/**
 * decodeJSON：读最多 1 MB 的请求体；空白请求体视为没有字段（返回 {}），否则必须是 JSON 对象或 null。
 * 字段类型由调用方经 field* 系列函数检查，类型不符抛 DecodeError（对应 json.Unmarshal 的类型错误）。
 */
export async function decodeJSON(request: Request): Promise<Record<string, unknown>> {
  let buf = Buffer.from(await request.arrayBuffer());
  if (buf.length > maxJSONBody) buf = buf.subarray(0, maxJSONBody);
  const text = buf.toString('utf8');
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new DecodeError((err as Error).message);
  }
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new DecodeError('json: cannot unmarshal into Go value of type struct');
  return value as Record<string, unknown>;
}

/** encoding/json 的键匹配：先找完全相同的，再不区分大小写。 */
function lookup(object: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(object, name)) return object[name];
  const lower = name.toLowerCase();
  const key = Object.keys(object).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : object[key];
}

/** 字符串字段：没有或 null 时为空串，类型不符抛 DecodeError。 */
export function fieldString(object: Record<string, unknown>, name: string): string {
  const value = lookup(object, name);
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new DecodeError(`json: cannot unmarshal into Go struct field .${name} of type string`);
  return value;
}

/** 布尔字段。 */
export function fieldBool(object: Record<string, unknown>, name: string): boolean {
  const value = lookup(object, name);
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new DecodeError(`json: cannot unmarshal into Go struct field .${name} of type bool`);
  return value;
}

/** 浮点字段。 */
export function fieldNumber(object: Record<string, unknown>, name: string): number {
  const value = lookup(object, name);
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number') throw new DecodeError(`json: cannot unmarshal into Go struct field .${name} of type float64`);
  return value;
}

/** 整数字段（Go 的 int / int64）：带小数的数也算类型错误。 */
export function fieldInt(object: Record<string, unknown>, name: string): number {
  const value = fieldNumber(object, name);
  if (!Number.isInteger(value)) throw new DecodeError(`json: cannot unmarshal number into Go struct field .${name} of type int`);
  return value;
}

/** 对象字段：没有或 null 时返回 undefined。 */
export function fieldObject(object: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = lookup(object, name);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new DecodeError(`json: cannot unmarshal into Go struct field .${name}`);
  return value as Record<string, unknown>;
}

/** 数组字段：没有或 null 时返回 undefined。 */
export function fieldArray(object: Record<string, unknown>, name: string): unknown[] | undefined {
  const value = lookup(object, name);
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new DecodeError(`json: cannot unmarshal into Go struct field .${name} of type slice`);
  return value;
}

// ---- 时间 ----

/**
 * Go time.Time 的 JSON 写法（RFC3339Nano，UTC，小数部分去掉末尾的 0）。JS 的 Date 只有毫秒，
 * 所以 TS 写出的时间最多 3 位小数；读进来的 Go 时间保留原字符串，不经 Date 往返，原样写回。
 */
export function formatRFC3339Nano(date: Date): string {
  const iso = date.toISOString();
  const [main, fraction] = iso.slice(0, -1).split('.');
  const trimmed = (fraction ?? '').replace(/0+$/, '');
  return trimmed ? `${main}.${trimmed}Z` : `${main}Z`;
}

/** time.Now().UTC() 写成 JSON 时的样子。 */
export function nowTime(): string {
  return formatRFC3339Nano(new Date());
}

/** time.Now().UTC().Format(time.RFC3339)：秒级。 */
export function nowRFC3339(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** 把 RFC3339 时间拆成「毫秒」与「毫秒以下的小数位」，用于比较（Go 的纳秒精度不丢）。 */
function timeKey(value: string): [number, string] {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(value);
  if (!match) return [Date.parse(value) || 0, ''];
  const fraction = (match[2] ?? '').padEnd(9, '0');
  const ms = Date.parse(`${match[1]}.${fraction.slice(0, 3)}${match[3]}`);
  return [Number.isNaN(ms) ? 0 : ms, fraction.slice(3)];
}

/** 比较两个 Go 写出的时间：a 早于 b 返回负数。 */
export function compareTimes(a: string, b: string): number {
  const [ma, ra] = timeKey(a);
  const [mb, rb] = timeKey(b);
  if (ma !== mb) return ma - mb;
  return ra < rb ? -1 : ra > rb ? 1 : 0;
}

// ---- 文件响应（http.ServeFile 的子集） ----

/** mime.TypeByExtension 的常用部分（Go 内置表加上 macOS 系统表里的音视频类型）。 */
const mimeTypes: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.xml': 'text/xml; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function mimeType(file: string): string {
  return mimeTypes[path.extname(file).toLowerCase()] ?? '';
}

/** http.DetectContentType 的简化版：没有 NUL、是合法 UTF-8 就当文本。 */
function sniff(file: string): string {
  let head: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      head = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 'application/octet-stream';
  }
  if (head.includes(0)) return 'application/octet-stream';
  return 'text/plain; charset=utf-8';
}

/** 解析单段 Range（bytes=a-b / bytes=a- / bytes=-n）。多段或无法满足返回 null / 'invalid'。 */
function parseRange(header: string, size: number): { start: number; end: number } | null | 'invalid' {
  const match = /^bytes=([^,]*)$/.exec(header.trim());
  if (!match) return null;
  const [startText, endText] = match[1].trim().split('-');
  if (endText === undefined) return 'invalid';
  let start: number;
  let end: number;
  if (startText === '') {
    const n = Number(endText);
    if (!/^\d+$/.test(endText) || n === 0) return 'invalid';
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    if (!/^\d+$/.test(startText)) return 'invalid';
    start = Number(startText);
    if (start >= size) return 'invalid';
    end = endText === '' ? size - 1 : /^\d+$/.test(endText) ? Math.min(Number(endText), size - 1) : -1;
    if (end < start) return 'invalid';
  }
  return { start, end };
}

/**
 * http.ServeFile 的子集：Content-Type（按扩展名，否则嗅探）、Last-Modified / If-Modified-Since、
 * 单段 Range（视频拖动要用）、HEAD。调用方已检查过文件存在且不是目录。
 */
export function serveFile(request: Request, file: string, headers: Record<string, string> = {}): Response {
  let info: fs.Stats;
  try {
    info = fs.statSync(file);
  } catch {
    return notFound();
  }
  if (info.isDirectory()) return notFound();
  const out = new Headers(headers);
  if (!out.has('Content-Type')) out.set('Content-Type', mimeType(file) || sniff(file));
  const modified = new Date(Math.floor(info.mtimeMs / 1000) * 1000);
  out.set('Last-Modified', modified.toUTCString());
  out.set('Accept-Ranges', 'bytes');
  const since = request.headers.get('If-Modified-Since');
  if (since && !request.headers.get('Range')) {
    const t = Date.parse(since);
    if (!Number.isNaN(t) && modified.getTime() <= t) {
      out.delete('Content-Type');
      return new Response(null, { status: 304, headers: out });
    }
  }
  const size = info.size;
  let status = 200;
  let start = 0;
  let end = size - 1;
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (range === 'invalid') {
      out.set('Content-Range', `bytes */${size}`);
      return new Response('invalid range: failed to overlap\n', { status: 416, headers: out });
    }
    if (range) {
      status = 206;
      ({ start, end } = range);
      out.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
  }
  const length = size === 0 ? 0 : end - start + 1;
  out.set('Content-Length', String(length));
  if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers: out });
  const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers: out });
}
