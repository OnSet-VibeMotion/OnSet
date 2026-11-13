/**
 * 上传。移植自 internal/studio/uploads.go。
 *
 * 上传的文件放在 Studio 自己的状态目录里，不直接写进项目：Studio 不写项目文件，
 * 文件该放到项目的哪里、要不要转格式，由编排工具在这一轮里决定，这样改动照常
 * 进轮次快照、可以回退。production/studio 不进快照，上传本身不算任何一轮的改动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { goExt } from '../gofmt';
import { goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { attachmentJSON, newID, type Attachment } from './sessions';
import type { Server } from './studio';

export const uploadDir = 'production/studio/uploads';
/** maxUploadBytes 是单个文件的上限：配音、配乐、参考视频都要能传。 */
export const maxUploadBytes = 512 << 20;
export const maxUploadFiles = 10;

/** Go 的 time.Now().Format("20060102-150405")：本地时间。 */
function localStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 解析一个上传请求时的错误：status / code 决定响应。 */
class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * uploadsAPI 接收 multipart 表单里的 file 字段（可多个），存进 production/studio/uploads/，
 * 返回可以直接附进下一条消息的附件。
 */
export async function uploadsAPI(s: Server, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const boundary = multipartBoundary(request.headers.get('Content-Type') ?? '');
  if (!boundary || !request.body) return writeError(400, 'invalid_upload', '需要 multipart/form-data');
  const dir = path.join(p.path, uploadDir);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (err) {
    return writeError(500, 'upload_failed', (err as Error).message);
  }
  const out: Attachment[] = [];
  let current: { fd: number; target: string; size: number; original: string; name: string } | null = null;
  const closeCurrent = (): void => {
    if (!current) return;
    fs.closeSync(current.fd);
  };
  try {
    await readMultipart(request.body, boundary, maxUploadFiles * maxUploadBytes, {
      start(headers) {
        const { formName, fileName } = disposition(headers['content-disposition'] ?? '');
        if (formName !== 'file' || fileName === '') return false;
        if (out.length >= maxUploadFiles) throw new UploadError(400, 'too_many_files', `一次最多上传 ${maxUploadFiles} 个文件`);
        const original = path.basename(fileName);
        if (original.startsWith('.env')) throw new UploadError(400, 'forbidden_file', '.env 不能上传：凭据不进项目');
        const name = localStamp() + '-' + newID('u').slice(2, 8) + '-' + safeFileName(original);
        const target = path.join(dir, name);
        let fd: number;
        try {
          fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
        } catch (err) {
          throw new UploadError(400, 'upload_failed', (err as Error).message);
        }
        current = { fd, target, size: 0, original, name };
        return true;
      },
      data(chunk) {
        const c = current!;
        // Go 用 LimitReader 读到上限加一字节就停，然后报超限。
        const room = maxUploadBytes + 1 - c.size;
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        fs.writeSync(c.fd, part);
        c.size += part.length;
        if (c.size > maxUploadBytes) throw new UploadError(400, 'upload_failed', `文件超过 ${maxUploadBytes >> 20} MB`);
      },
      end() {
        const c = current!;
        closeCurrent();
        current = null;
        if (c.size === 0) {
          fs.rmSync(c.target, { force: true });
          throw new UploadError(400, 'upload_failed', '文件是空的');
        }
        out.push({ path: uploadDir + '/' + c.name, name: c.original, size: c.size, upload: true });
      },
    });
  } catch (err) {
    if (current) {
      const c = current as { target: string };
      closeCurrent();
      fs.rmSync(c.target, { force: true });
    }
    if (err instanceof UploadError) return writeError(err.status, err.code, err.message);
    return writeError(400, 'invalid_upload', (err as Error).message);
  }
  if (out.length === 0) return writeError(400, 'no_file', '没有收到文件');
  return writeJSON(201, goMap({ attachments: out.map(attachmentJSON) }));
}

/** Content-Type 是 multipart/form-data（或 multipart/mixed）时返回 boundary。 */
function multipartBoundary(contentType: string): string {
  const [type, ...params] = contentType.split(';');
  const media = type.trim().toLowerCase();
  if (media !== 'multipart/form-data' && media !== 'multipart/mixed') return '';
  const values = parseParams(params.join(';'));
  return values.boundary ?? '';
}

/** 解析 `; a=b; c="d"` 形式的参数（mime.ParseMediaType 的子集，含 RFC 5987 的 name*）。 */
function parseParams(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /;?\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(';' + text)) !== null) {
    const key = match[1].toLowerCase();
    let value = match[2].trim();
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    if (key.endsWith('*')) {
      const ext = /^([^']*)'[^']*'(.*)$/.exec(value);
      if (ext) {
        try {
          out[key.slice(0, -1)] = decodeURIComponent(ext[2]);
        } catch {
          // 编码坏了就忽略这个参数。
        }
      }
      continue;
    }
    if (!Object.hasOwn(out, key)) out[key] = value;
  }
  return out;
}

/** Content-Disposition 的表单名与文件名（multipart.Part 的 FormName / FileName）。 */
function disposition(header: string): { formName: string; fileName: string } {
  const [type, ...params] = header.split(';');
  const values = parseParams(params.join(';'));
  const formName = type.trim().toLowerCase() === 'form-data' ? (values.name ?? '') : '';
  const fileName = values.filename === undefined ? '' : path.basename(values.filename);
  return { formName, fileName };
}

interface PartSink {
  /** 一个 part 开始；返回 false 表示丢弃这个 part 的内容。 */
  start(headers: Record<string, string>): boolean;
  data(chunk: Buffer): void;
  end(): void;
}

/**
 * 流式读 multipart：边读边把每个 part 的内容交给 sink，不把整个请求读进内存
 * （单个文件可以有 512 MB）。limit 是整个请求体的上限（http.MaxBytesReader）。
 */
async function readMultipart(body: ReadableStream<Uint8Array>, boundary: string, limit: number, sink: PartSink): Promise<void> {
  const delimiter = Buffer.from('\r\n--' + boundary);
  // 第一个分隔符前面没有 CRLF：补一个，统一按 delimiter 找。
  let buf: Buffer = Buffer.from('\r\n');
  type State = 'preamble' | 'after' | 'headers' | 'body' | 'done';
  let state = 'preamble' as State;
  let keep = false;
  let total = 0;
  const reader = body.getReader();
  let eof = false;
  const step = (): boolean => {
    switch (state) {
      case 'preamble': {
        const index = buf.indexOf(delimiter);
        if (index < 0) {
          if (buf.length > delimiter.length) buf = buf.subarray(buf.length - delimiter.length);
          return false;
        }
        buf = buf.subarray(index + delimiter.length);
        state = 'after';
        return true;
      }
      case 'after': {
        // 分隔符后面是 "--"（结束）或可选的空白加 CRLF。
        if (buf.length < 2) return false;
        if (buf[0] === 0x2d && buf[1] === 0x2d) {
          state = 'done';
          return false;
        }
        const crlf = buf.indexOf('\r\n');
        if (crlf < 0) return false;
        if (buf.subarray(0, crlf).toString('latin1').trim() !== '') throw new Error('multipart: expecting a new Part; got line ' + JSON.stringify(buf.subarray(0, crlf).toString()));
        buf = buf.subarray(crlf + 2);
        state = 'headers';
        return true;
      }
      case 'headers': {
        const end = buf.indexOf('\r\n\r\n');
        let headerText: string;
        if (buf.subarray(0, 2).toString('latin1') === '\r\n') {
          headerText = '';
          buf = buf.subarray(2);
        } else {
          if (end < 0) {
            if (buf.length > 64 << 10) throw new Error('multipart: message too large');
            return false;
          }
          headerText = buf.subarray(0, end).toString('utf8');
          buf = buf.subarray(end + 4);
        }
        const headers: Record<string, string> = {};
        for (const line of headerText.split('\r\n')) {
          const colon = line.indexOf(':');
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        keep = sink.start(headers);
        state = 'body';
        return true;
      }
      case 'body': {
        const index = buf.indexOf(delimiter);
        if (index < 0) {
          const safe = buf.length - (delimiter.length - 1);
          if (safe > 0) {
            if (keep) sink.data(buf.subarray(0, safe));
            buf = buf.subarray(safe);
          }
          return false;
        }
        if (keep && index > 0) sink.data(buf.subarray(0, index));
        if (keep) sink.end();
        keep = false;
        buf = buf.subarray(index + delimiter.length);
        state = 'after';
        return true;
      }
      case 'done':
        return false;
    }
  };
  try {
    while (state !== 'done') {
      while (step()) {
        // 处理完缓冲区里能处理的。
      }
      if ((state as State) === 'done') break;
      if (eof) throw new Error('multipart: NextPart: EOF');
      const { value, done } = await reader.read();
      if (done) {
        eof = true;
        continue;
      }
      total += value.length;
      if (total > limit) throw new Error('http: request body too large');
      buf = buf.length === 0 ? Buffer.from(value) : Buffer.concat([buf, value]);
    }
  } finally {
    reader.releaseLock();
  }
}

/** safeFileName 保留中文与常见字符，去掉路径分隔符、控制字符和开头的点。 */
export function safeFileName(name: string): string {
  let b = '';
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (ch === '/' || ch === '\\' || ch === ':' || isControl(c)) b += '_';
    else if (isSpace(c)) b += '-';
    else b += ch;
  }
  let out = b.replace(/^\.+/, '');
  const runes = [...out];
  if (runes.length > 80) {
    const ext = goExt(out);
    out = runes.slice(0, 80 - [...ext].length).join('') + ext;
  }
  return out === '' ? 'file' : out;
}

/** unicode.IsControl：C0、DEL 与 C1。 */
function isControl(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c < 0xa0);
}

/** unicode.IsSpace。 */
function isSpace(c: number): boolean {
  switch (c) {
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x20:
    case 0x85:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true;
  }
  return c >= 0x2000 && c <= 0x200a;
}

/** uploadKind 按扩展名给编排工具一个提示：文章、图片、音频还是视频。 */
export function uploadKind(name: string): string {
  switch (goExt(name).toLowerCase()) {
    case '.md':
    case '.txt':
    case '.docx':
    case '.pdf':
    case '.html':
    case '.srt':
    case '.json':
      return '文档';
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
    case '.gif':
    case '.svg':
      return '图片';
    case '.mp3':
    case '.wav':
    case '.m4a':
    case '.aac':
    case '.flac':
    case '.ogg':
      return '音频';
    case '.mp4':
    case '.mov':
    case '.webm':
    case '.mkv':
      return '视频';
    case '.woff':
    case '.woff2':
    case '.ttf':
    case '.otf':
      return '字体';
  }
  return '文件';
}
