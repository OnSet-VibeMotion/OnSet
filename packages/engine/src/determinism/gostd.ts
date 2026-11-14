// 本包内部用的 Go 标准库语义辅助：正则字符类、strings.TrimSpace、path.Clean、path.Ext、
// 以及 os 错误的 Go 文案。不导出到包外。

/**
 * RE2 的 \s 只认 ASCII 空白 [\t\n\f\r ]（不含 \v）；JS 的 \s 还包括 \v、NBSP、
 * U+2028 等一大串 Unicode 空白。规则必须与 Go 一致，所以所有 \s 都写成这个类。
 */
export const S = '[\\t\\n\\f\\r ]';
/** 用在字符类内部的 \s 展开。 */
export const SIN = '\\t\\n\\f\\r ';

/**
 * RE2 的 (?i) 按 Unicode 简单大小写折叠：s 还匹配 ſ（U+017F），k 还匹配 K（U+212A）。
 * JS 不带 u 的 i 标志不做这两个折叠，带 u 时 \b、\w 又会把 ſ、K 当成单词字符（RE2 的 \b 永远
 * 只认 ASCII）。为了与 Go 逐字一致，大小写不敏感的规则不用 i 标志，而是把字面量里的每个字母
 * 展开成字符类。
 */
export function ci(literal: string): string {
  let out = '';
  for (const c of literal) {
    const lower = c.toLowerCase();
    if (lower >= 'a' && lower <= 'z' && lower.length === 1) {
      let cls = lower + lower.toUpperCase();
      if (lower === 's') cls += '\\u017F';
      if (lower === 'k') cls += '\\u212A';
      out += '[' + cls + ']';
    } else if (/[.*+?^${}()|[\]\\/-]/.test(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return out;
}

/** (?i) 下 [a-z] / [A-Za-z] 的等价类内容（含 ſ 与 K）。 */
export const CI_LETTERS = 'a-zA-Z\\u017F\\u212A';

/** unicode.IsSpace 认的空白；strings.TrimSpace 两端去掉这些。JS 的 trim() 还去 U+FEFF、不去 U+0085。 */
function isGoSpace(c: number): boolean {
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

/** strings.TrimSpace。 */
export function goTrimSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isGoSpace(s.charCodeAt(start))) start++;
  while (end > start && isGoSpace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/** path.Clean（斜杠路径）。 */
export function goClean(p: string): string {
  if (p === '') return '.';
  const rooted = p.startsWith('/');
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  if (rooted) return '/' + joined;
  return joined === '' ? '.' : joined;
}

/** path.Join：忽略空元素后拼接并 Clean；全部为空时返回空串。 */
export function goJoin(...elems: string[]): string {
  const parts = elems.filter((e) => e !== '');
  if (parts.length === 0) return '';
  return goClean(parts.join('/'));
}

/** path.Dir。 */
export function goDir(p: string): string {
  const i = p.lastIndexOf('/');
  return goClean(p.slice(0, i + 1));
}

/** path.Ext / filepath.Ext：最后一个路径元素里最后一个点起的后缀（含点）。 */
export function goExt(p: string): string {
  for (let i = p.length - 1; i >= 0 && p[i] !== '/'; i--) {
    if (p[i] === '.') return p.slice(i);
  }
  return '';
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
  ELOOP: 'too many levels of symbolic links',
  ENAMETOOLONG: 'file name too long',
};

/** 把 Node 的文件系统错误写成 Go *PathError 的文案：「op path: 原因」。 */
export function goPathError(op: string, file: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  const reason = (code && errnoText[code]) || (err instanceof Error ? err.message : String(err));
  return `${op} ${file}: ${reason}`;
}
