/**
 * multipart/form-data 流式解析器与头部参数解析。
 */
import path from 'node:path';

/** Content-Type 是 multipart/form-data（或 multipart/mixed）时返回 boundary。 */
export function multipartBoundary(contentType: string): string {
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
export function disposition(header: string): { formName: string; fileName: string } {
  const [type, ...params] = header.split(';');
  const values = parseParams(params.join(';'));
  const formName = type.trim().toLowerCase() === 'form-data' ? (values.name ?? '') : '';
  const fileName = values.filename === undefined ? '' : path.basename(values.filename);
  return { formName, fileName };
}

export interface PartSink {
  /** 一个 part 开始；返回 false 表示丢弃这个 part 的内容。 */
  start(headers: Record<string, string>): boolean;
  data(chunk: Buffer): void;
  end(): void;
}

/**
 * 流式读 multipart：边读边把每个 part 的内容交给 sink，不把整个请求读进内存
 * （单个文件可以有 512 MB）。limit 是整个请求体的上限（http.MaxBytesReader）。
 */
export async function readMultipart(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  limit: number,
  sink: PartSink,
): Promise<void> {
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
        if (buf.subarray(0, crlf).toString('latin1').trim() !== '') {
          throw new Error(
            'multipart: expecting a new Part; got line ' + JSON.stringify(buf.subarray(0, crlf).toString()),
          );
        }
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
