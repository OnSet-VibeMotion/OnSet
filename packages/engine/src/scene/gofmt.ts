// scene 包里用到、而 ../gofmt 没有的 Go 格式化写法。
import { formatG } from '../gofmt';

/**
 * fmt 的 %.Ng（strconv.FormatFloat(v, 'g', N, 64)，不带 # 标志）：按 N 位有效数字取舍
 * （恰好落在中点时取偶，与 Go 一致；JS 的 toExponential 取较大一侧），去掉末尾的 0；
 * 指数小于 -4 或不小于 N 时写成 1.23457e+06。
 */
export function formatGPrecision(value: number, precision: number): string {
  if (!Number.isFinite(value)) return formatG(value);
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const prec = Math.max(precision, 1);
  const negative = value < 0;
  const abs = Math.abs(value);
  let text = abs.toExponential(prec - 1);
  const exact = abs.toExponential(Math.min(100, prec - 1 + 60));
  const [exactMantissa, exactExp] = exact.split('e');
  const exactDigits = exactMantissa.replace('.', '');
  const tail = exactDigits.slice(prec);
  if (/^50*$/.test(tail)) {
    // 恰好是中点：Go 取偶数一侧。
    const kept = exactDigits.slice(0, prec);
    if (Number(kept[kept.length - 1]) % 2 === 0) {
      text = (kept.length > 1 ? kept[0] + '.' + kept.slice(1) : kept) + 'e' + exactExp;
    }
  }
  const [mantissa, expText] = text.split('e');
  const exp = Number(expText);
  let digits = mantissa.replace('.', '').replace(/0+$/, '');
  if (digits === '') digits = '0';
  let out: string;
  if (exp < -4 || exp >= prec) {
    const abbreviated = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
    const e = Math.abs(exp);
    out = `${abbreviated}e${exp < 0 ? '-' : '+'}${e < 10 ? '0' + e : String(e)}`;
  } else {
    const dp = exp + 1;
    if (dp <= 0) out = '0.' + '0'.repeat(-dp) + digits;
    else if (dp >= digits.length) out = digits + '0'.repeat(dp - digits.length);
    else out = digits.slice(0, dp) + '.' + digits.slice(dp);
  }
  return negative ? '-' + out : out;
}

/** fmt 的 %v（[]string）：[a b c]。 */
export function formatStrings(values: readonly string[] | null): string {
  return '[' + (values ?? []).join(' ') + ']';
}
