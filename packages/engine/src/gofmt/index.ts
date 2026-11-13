/**
 * Go 标准库格式化与字符串语义的共享实现。移植时凡是要和 Go 输出逐字节一致的地方都从这里取，不要各包各写一份：
 * - fmt 的 %.Nf（中点取偶）、%v（float 的 'g' 写法）、%q；
 * - math.Round（中点远离零）；
 * - strings.TrimSpace（Go 的空白集合与 JS trim 不同：不去 U+FEFF、会去 U+0085）；
 * - path.Clean / Join / Dir / Ext（斜杠路径，与 node:path 的规范化细节不同）；
 * - *fs.PathError 的文案（「op path: 原因」）。
 */

/**
 * fmt 的 %.Nf / strconv.FormatFloat(v, 'f', N, 64)。
 * JS 的 toFixed 在恰好落在中点时取较大的一侧，Go 取偶数一侧（0.0625 → "0.062"）；
 * toFixed 把 -0 写成 "0"，Go 写成 "-0"。这里补上这两处差别。
 */
export function formatFixed(value: number, digits: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '+Inf' : '-Inf';
  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);
  let text = abs.toFixed(digits);
  const exact = abs.toFixed(Math.min(100, digits + 60));
  const point = exact.indexOf('.');
  const tail = exact.slice(point + 1 + digits);
  if (/^50*$/.test(tail)) {
    // 恰好是中点：按偶数取舍。
    const down = digits === 0 ? exact.slice(0, point) : exact.slice(0, point + 1 + digits);
    if (Number(down[down.length - 1]) % 2 === 0) text = down;
  }
  return negative ? '-' + text : text;
}

/** Go 的 math.Round：中点远离零取整。JS 的 Math.round 对负的 .5 取向正无穷。 */
export function goRound(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * fmt 的 %v（float64）：strconv.FormatFloat(v, 'g', -1, 64)。最短表示；指数小于 -4 或不小于 6 时
 * 写成 1e+06 这种形式（指数至少两位）。JSON 的写法不同，那是 gojson 的事。
 */
export function formatG(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '+Inf' : '-Inf';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const [mantissa, expText] = value.toExponential().split('e');
  const exp = Number(expText);
  if (exp < -4 || exp >= 6) {
    const digits = String(Math.abs(exp)).padStart(2, '0');
    return `${mantissa}e${exp < 0 ? '-' : '+'}${digits}`;
  }
  return String(value);
}

/** strconv.Quote 的常用子集：转义引号、反斜杠与控制字符，可打印的 Unicode 原样保留。 */
export function goQuote(value: string): string {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\x07') out += '\\a';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\v') out += '\\v';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + '"';
}

export function isGoSpace(c: number): boolean {
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

/** 把 Node 的文件系统错误写成 Go *fs.PathError 的文案：「op path: 原因」，例如「open /a/b: no such file or directory」。 */
export function goPathError(op: string, file: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const reason = (code && errnoText[code]) || (err instanceof Error ? err.message : String(err));
  return `${op} ${file}: ${reason}`;
}
