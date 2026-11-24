import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { lookPath } from '../envutil';
import { compareBytes } from '../gojson';

/** strings.TrimSpace（Unicode 空白，不含 U+FEFF）。 */
export function trimSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isGoSpace(s.charCodeAt(start))) start++;
  while (end > start && isGoSpace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/** unicode.IsSpace。 */
function isGoSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

const errnoText: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  ENOTDIR: 'not a directory',
  EISDIR: 'is a directory',
  EEXIST: 'file exists',
  ENOTEMPTY: 'directory not empty',
  EXDEV: 'cross-device link',
};

export function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return (code && errnoText[code]) || (err instanceof Error ? err.message : String(err));
}

/** Go 的 *PathError 文案：「op path: 原因」。 */
export function pathError(op: string, file: string, err: unknown): Error {
  return new Error(`${op} ${file}: ${reasonOf(err)}`, { cause: err });
}

export function gitPath(): string {
  return lookPath('git', process.env.PATH ?? '');
}

export function gitOutput(root: string, ...args: string[]): Buffer {
  const result = spawnSync(gitPath(), args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${trimSpace(result.stderr.toString('utf8'))}`);
  }
  return result.stdout;
}

/** 忽略错误的 gitOutput，对应 Go 里 `out, _ := gitOutput(...)`。 */
export function gitOutputOrEmpty(root: string, ...args: string[]): Buffer {
  try {
    return gitOutput(root, ...args);
  } catch {
    return Buffer.alloc(0);
  }
}

export function splitNUL(body: Buffer): string[] {
  const result: string[] = [];
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || body[i] === 0) {
      if (i > start) {
        result.push(body.subarray(start, i).toString('utf8'));
      }
      start = i + 1;
    }
  }
  return result;
}

export function existsAt(root: string, commit: string, file: string): boolean {
  const result = spawnSync(gitPath(), ['cat-file', '-e', commit + ':' + file], { cwd: root, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

/** filepath.Base：去掉末尾斜杠后取最后一段；空串得 "."，全是斜杠得 "/"。 */
export function goBase(p: string): string {
  if (p === '') return '.';
  let s = p;
  while (s.length > 0 && s.endsWith('/')) s = s.slice(0, -1);
  if (s === '') return '/';
  return s.slice(s.lastIndexOf('/') + 1);
}

const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/** strconv.Quote（fmt 的 %q）。 */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case '\\':
        out += '\\\\';
        continue;
      case '\x07':
        out += '\\a';
        continue;
      case '\b':
        out += '\\b';
        continue;
      case '\f':
        out += '\\f';
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\r':
        out += '\\r';
        continue;
      case '\t':
        out += '\\t';
        continue;
      case '\v':
        out += '\\v';
        continue;
    }
    if (ch === ' ' || (c >= 0x21 && c < 0x7f) || (c >= 0x80 && printable.test(ch))) {
      out += ch;
    } else if (c < 0x20 || c === 0x7f) {
      out += '\\x' + c.toString(16).padStart(2, '0');
    } else if (c < 0x10000) {
      out += '\\u' + c.toString(16).padStart(4, '0');
    } else {
      out += '\\U' + c.toString(16).padStart(8, '0');
    }
  }
  return out + '"';
}

export function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareBytes);
}

/** os.MkdirAll(dir, 0o755)，错误写成 Go 的文案。 */
export function mkdirAll(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw pathError('mkdir', dir, err);
  }
}
