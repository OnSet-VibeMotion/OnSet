/**
 * 上传。
 *
 * 上传的文件放在 Studio 自己的状态目录里，不直接写进项目：Studio 不写项目文件，
 * 文件该放到项目的哪里、要不要转格式，由编排工具在这一轮里决定，这样改动照常
 * 进轮次快照、可以回退。production/studio 不进快照，上传本身不算任何一轮的改动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { goExt } from '../gofmt';
import { goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { type Attachment, attachmentJSON, containedPath, newID } from './sessions';
import type { Server } from './studio';
import { disposition, multipartBoundary, readMultipart } from './uploads_multipart';

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
  if (request.headers.has('X-Onset-Upload-Directory')) return uploadDirectory(p.path, request, boundary);
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
        if (out.length >= maxUploadFiles) {
          throw new UploadError(400, 'too_many_files', `一次最多上传 ${maxUploadFiles} 个文件`);
        }
        const original = path.basename(fileName);
        if (original.startsWith('.env')) {
          throw new UploadError(400, 'forbidden_file', '.env 不能上传：凭据不进项目');
        }
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

/** 文件夹按一次导入保留相对路径；只在全部成功后给出引用，失败不留下半份目录。 */
async function uploadDirectory(projectPath: string, request: Request, boundary: string): Promise<Response> {
  let dir = '';
  let current: { fd: number } | null = null;
  try {
    const name = decodeURIComponent(request.headers.get('X-Onset-Upload-Directory') ?? '');
    directoryEntryPath(name);
    if (name.includes('/')) throw new Error('文件夹名称不能含路径');
    let relParent = '';
    for (const segment of uploadDir.split('/')) {
      relParent = relParent ? relParent + '/' + segment : segment;
      const next = path.join(projectPath, relParent);
      if (!fs.existsSync(next)) fs.mkdirSync(next, { mode: 0o755 });
      // 先校验这一层，再创建下一层，避免沿项目外的链接写目录。
      containedPath(projectPath, relParent);
    }
    const parent = containedPath(projectPath, uploadDir);
    dir = fs.mkdtempSync(path.join(parent, localStamp() + '-' + safeFileName(name) + '-'));
    let entries = 0;
    let bytes = 0;
    await readMultipart(request.body!, boundary, maxUploadBytes + (1 << 20), {
      start(headers) {
        const { formName } = disposition(headers['content-disposition'] ?? '');
        const directory = formName.startsWith('directory:');
        if (!directory && !formName.startsWith('file:')) throw new Error('文件夹上传项无效');
        if (++entries > 1000) throw new Error('一个文件夹最多导入 1000 个条目');
        const rel = decodeURIComponent(formName.slice(directory ? 10 : 5));
        if (rel !== '' || !directory) directoryEntryPath(rel);
        const target = path.join(dir, rel);
        if (directory) {
          fs.mkdirSync(target, { recursive: true, mode: 0o755 });
          return false;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        current = {
          fd: fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644),
        };
        return true;
      },
      data(chunk) {
        bytes += chunk.length;
        if (bytes > maxUploadBytes) throw new Error(`文件夹素材超过 ${maxUploadBytes >> 20} MB`);
        fs.writeSync(current!.fd, chunk);
      },
      end() {
        fs.closeSync(current!.fd);
        current = null;
      },
    });
    if (!entries) throw new Error('没有收到文件夹内容');
    const attachment: Attachment = {
      ref: true,
      source: uploadDir + '/' + path.basename(dir),
      label: `文件夹「${name}」`,
    };
    return writeJSON(201, goMap({ attachments: [attachmentJSON(attachment)] }));
  } catch (err) {
    if (current) fs.closeSync((current as { fd: number }).fd);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return writeError(400, 'invalid_directory_upload', (err as Error).message);
  }
}

/** 不改写目录内的名称，否则文档、HTML 与素材之间的相对引用会断。拒收不安全或跨平台歧义路径。 */
function directoryEntryPath(rel: string): void {
  const parts = rel.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.toLowerCase().startsWith('.env') ||
        /[\\:*?"<>|\x00-\x1f\x7f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error(`文件夹内的路径不能导入：${rel}`);
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
