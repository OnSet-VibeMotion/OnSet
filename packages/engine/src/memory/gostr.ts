// 本包内部用的 Go 字符串与时间语义。不导出到包外。

/** unicode.ToLower 的单码点映射（简单大小写映射，不做上下文相关的 Σ→ς 与多字符展开）。 */
function lowerRune(ch: string): string {
  const c = ch.codePointAt(0)!;
  if (c < 0x80) return c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 32) : ch;
  if (c === 0x130) return 'i';
  if (c === 0x3a3) return String.fromCodePoint(0x3c3);
  const lower = ch.toLowerCase();
  return [...lower].length === 1 ? lower : ch;
}

/** strings.ToLower。 */
export function goToLower(s: string): string {
  let out = '';
  for (const ch of s) out += lowerRune(ch);
  return out;
}

/** unicode.ToLower（单个字符）。 */
export function goLowerRune(ch: string): string {
  return lowerRune(ch);
}

const letter = /^\p{L}$/u;
const digit = /^\p{Nd}$/u;
const han = /^\p{Script=Han}$/u;

/** unicode.IsLetter。 */
export function isLetter(ch: string): boolean {
  return letter.test(ch);
}

/** unicode.IsDigit。 */
export function isDigit(ch: string): boolean {
  return digit.test(ch);
}

/** unicode.Is(unicode.Han, r)。 */
export function isHan(ch: string): boolean {
  return han.test(ch);
}

/** utf8.RuneCountInString。 */
export function runeCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** t.UTC().Format(time.RFC3339)。 */
export function rfc3339(t: Date): string {
  return (
    `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}Z`
  );
}

/**
 * t.UTC().Format(time.RFC3339Nano)：小数部分去掉末尾的 0，整秒时不写小数点。
 * JS 的 Date 只有毫秒精度，Go 写纳秒；两种写法 Go 都能读，排序也只比到同一秒内。
 */
export function rfc3339Nano(t: Date): string {
  const base = rfc3339(t);
  const ms = t.getUTCMilliseconds();
  if (ms === 0) return base;
  return base.slice(0, -1) + '.' + pad(ms, 3).replace(/0+$/, '') + 'Z';
}

/** t.UTC().Format("20060102-150405")。 */
export function compactStamp(t: Date): string {
  return (
    `${pad(t.getUTCFullYear(), 4)}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}` +
    `-${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}`
  );
}

/** t.UTC().Format("2006-01")。 */
export function monthStamp(t: Date): string {
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}`;
}
