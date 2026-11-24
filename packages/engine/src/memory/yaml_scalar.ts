// yaml.v3 emitterc.go 与 resolve.go 的标量分析与类型判定。只供本包内部使用。

/** yaml.v3 emitterc.go 的 is_printable，按码点判断（Go 是按 UTF-8 字节）。 */
export function isPrintable(c: number): boolean {
  if (c === 0x0a) return true;
  if (c >= 0x20 && c <= 0x7e) return true;
  if (c >= 0xa0 && c <= 0xd7ff) return true;
  if (c >= 0xe000 && c <= 0xfffd) return c !== 0xfeff;
  // 0x80–0x9F（C2 80–C2 9F）、代理区、四字节字符（emoji 等）都不算可打印：libyaml 只认 BMP。
  return false;
}

export function isBreak(c: number): boolean {
  return c === 0x0d || c === 0x0a || c === 0x85 || c === 0x2028 || c === 0x2029;
}

function isBlankZ(c: number | undefined): boolean {
  return c === undefined || c === 0x20 || c === 0x09 || c === 0x00 || isBreak(c);
}

export interface ScalarAnalysis {
  multiline: boolean;
  blockPlainAllowed: boolean;
  singleQuotedAllowed: boolean;
  blockAllowed: boolean;
}

/** yaml_emitter_analyze_scalar（flow_level 恒为 0，flow_plain_allowed 用不到）。 */
export function analyze(value: string): ScalarAnalysis {
  if (value === '')
    return { multiline: false, blockPlainAllowed: true, singleQuotedAllowed: true, blockAllowed: false };
  const cps = [...value].map((ch) => ch.codePointAt(0)!);
  let blockIndicators = false;
  let lineBreaks = false;
  let specialCharacters = false;
  let tabCharacters = false;
  let leadingSpace = false;
  let leadingBreak = false;
  let trailingSpace = false;
  let trailingBreak = false;
  let breakSpace = false;
  let spaceBreak = false;
  let previousSpace = false;
  let previousBreak = false;
  if (value.startsWith('---') || value.startsWith('...')) blockIndicators = true;
  let precededByWhitespace = true;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    const followedByWhitespace = i + 1 >= cps.length || cps[i + 1] === 0x20 || cps[i + 1] === 0x09;
    if (i === 0) {
      switch (c) {
        case 0x23: // #
        case 0x2c: // ,
        case 0x5b: // [
        case 0x5d: // ]
        case 0x7b: // {
        case 0x7d: // }
        case 0x26: // &
        case 0x2a: // *
        case 0x21: // !
        case 0x7c: // |
        case 0x3e: // >
        case 0x27: // '
        case 0x22: // "
        case 0x25: // %
        case 0x40: // @
        case 0x60: // `
          blockIndicators = true;
          break;
        case 0x3f: // ?
        case 0x3a: // :
          if (followedByWhitespace) blockIndicators = true;
          break;
        case 0x2d: // -
          if (followedByWhitespace) blockIndicators = true;
          break;
      }
    } else {
      switch (c) {
        case 0x3a:
          if (followedByWhitespace) blockIndicators = true;
          break;
        case 0x23:
          if (precededByWhitespace) blockIndicators = true;
          break;
      }
    }
    if (c === 0x09) tabCharacters = true;
    else if (!isPrintable(c)) specialCharacters = true;
    if (c === 0x20) {
      if (i === 0) leadingSpace = true;
      if (i === cps.length - 1) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true;
      previousBreak = false;
    } else if (isBreak(c)) {
      lineBreaks = true;
      if (i === 0) leadingBreak = true;
      if (i === cps.length - 1) trailingBreak = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false;
      previousBreak = true;
    } else {
      previousSpace = false;
      previousBreak = false;
    }
    precededByWhitespace = isBlankZ(c);
  }
  const out: ScalarAnalysis = {
    multiline: lineBreaks,
    blockPlainAllowed: true,
    singleQuotedAllowed: true,
    blockAllowed: true,
  };
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) out.blockPlainAllowed = false;
  if (trailingSpace) out.blockAllowed = false;
  if (breakSpace) {
    out.blockPlainAllowed = false;
    out.singleQuotedAllowed = false;
  }
  if (spaceBreak || tabCharacters || specialCharacters) {
    out.blockPlainAllowed = false;
    out.singleQuotedAllowed = false;
  }
  if (spaceBreak || specialCharacters) out.blockAllowed = false;
  if (lineBreaks) out.blockPlainAllowed = false;
  if (blockIndicators) out.blockPlainAllowed = false;
  return out;
}

// yaml.v3 resolve.go：plain 写出后会被解析成非字符串的值，必须加引号。

const resolveMapKeys = new Set([
  'true',
  'True',
  'TRUE',
  'false',
  'False',
  'FALSE',
  '',
  '~',
  'null',
  'Null',
  'NULL',
  '.nan',
  '.NaN',
  '.NAN',
  '.inf',
  '.Inf',
  '.INF',
  '+.inf',
  '+.Inf',
  '+.INF',
  '-.inf',
  '-.Inf',
  '-.INF',
]);

const yamlStyleFloat = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

/** strconv.ParseInt / ParseUint(s, 0, 64) 是否成功。 */
function goParsesInt(s: string): boolean {
  const m = /^([+-]?)(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)$/.exec(s);
  if (!m) return false;
  const digits = m[2];
  let n: bigint;
  if (/^0[oO]/.test(digits)) n = BigInt('0o' + digits.slice(2));
  else if (/^0[0-7]+$/.test(digits)) n = BigInt('0o' + digits.slice(1));
  else n = BigInt(digits);
  if (m[1] === '-') return n <= 1n << 63n;
  // ParseInt 的上限是 2^63-1；不带符号时 ParseUint 还能到 2^64-1。
  return m[1] === '+' ? n < 1n << 63n : n < 1n << 64n;
}

function goParsesFloat(s: string): boolean {
  // strconv.ParseFloat 对 yamlStyleFloat 形式只在溢出时失败，溢出返回 ±Inf 与 ErrRange。
  return Number.isFinite(Number(s));
}

/** yaml.v3 的 parseTimestamp：以 YYYY- 开头，且能按四种格式之一解析。 */
function isTimestamp(s: string): boolean {
  if (!/^[0-9]{4}-/.test(s)) return false;
  const date = '[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}';
  const clock = '[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\\.[0-9]+)?';
  const zone = '(Z|[+-][0-9]{2}:[0-9]{2})';
  const patterns = [`^${date}T${clock}${zone}$`, `^${date}t${clock}${zone}$`, `^${date} ${clock}$`, `^${date}$`];
  if (!patterns.some((p) => new RegExp(p).test(s))) return false;
  // time.Parse 还会校验取值范围。
  const [y, mo, d] = s
    .slice(0, 10)
    .split(/[-Tt ]/)
    .map(Number);
  void y;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const time = /[Tt ]([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})/.exec(s);
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3]) > 59)) return false;
  return true;
}

/** resolve("", s) 的结果是不是 !!str。 */
export function resolvesToString(s: string): boolean {
  if (resolveMapKeys.has(s)) return false;
  const first = s[0];
  if (first === '.') return !(goParsesFloat(s) && /^\.[0-9]/.test(s) && yamlStyleFloat.test(s));
  if (first === '+' || first === '-' || (first >= '0' && first <= '9')) {
    if (isTimestamp(s)) return false;
    const plain = s.replaceAll('_', '');
    if (goParsesInt(plain)) return false;
    if (yamlStyleFloat.test(plain) && goParsesFloat(plain)) return false;
    if (/^-?0[bB][01]+$/.test(plain)) return false;
    if (/^-?0[oO][0-7]+$/.test(plain)) return false;
  }
  return true;
}

export const oldBools = new Set([
  'y',
  'Y',
  'yes',
  'Yes',
  'YES',
  'on',
  'On',
  'ON',
  'n',
  'N',
  'no',
  'No',
  'NO',
  'off',
  'Off',
  'OFF',
]);

export const base60Float = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/;
