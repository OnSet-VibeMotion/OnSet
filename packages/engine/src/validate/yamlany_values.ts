/**
 * yaml.v3 解码产出的 Go 值表示（GoFloat / AnyMap / GoTime）与比较、格式化工具。
 */
import { formatG } from '../gofmt';
import { compareBytes } from '../gojson';

/** Go 的 float64 值（与 int 区分开）。 */
export class GoFloat {
  constructor(readonly value: number) {}
  toJSON(): number {
    return this.value;
  }
}

/** Go 的 map[interface{}]interface{}：键不全是字符串的映射。 */
export class AnyMap {
  constructor(readonly entries: Array<[unknown, unknown]>) {}
}

export type GoMap = Record<string, unknown>;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * Go 的 time.Time（yaml.v3 把未加引号的时间戳解进 any 时给的就是它）。
 * 只保留墙上时间与时区偏移，够 DeepEqual、%v 与 JSON 用。
 */
export class GoTime {
  constructor(
    readonly text: string,
    readonly year: number,
    readonly month: number,
    readonly day: number,
    readonly hour: number,
    readonly minute: number,
    readonly second: number,
    readonly nanos: number,
    /** 东正西负，单位分钟；0 且来自 Z 或无时区时为 UTC。 */
    readonly offsetMinutes: number,
  ) {}

  private datePart(): string {
    return `${pad(this.year, 4)}-${pad(this.month)}-${pad(this.day)}`;
  }

  private clock(): string {
    return `${pad(this.hour)}:${pad(this.minute)}:${pad(this.second)}`;
  }

  /** .999999999 的小数写法：去掉末尾的 0，全零时整段省略。 */
  private fraction(): string {
    if (this.nanos === 0) return '';
    return '.' + String(this.nanos).padStart(9, '0').replace(/0+$/, '');
  }

  private zone(colon: boolean): string {
    const sign = this.offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(this.offsetMinutes);
    return sign + pad(Math.floor(abs / 60)) + (colon ? ':' : '') + pad(abs % 60);
  }

  /** time.Time 的 String()：2006-01-02 15:04:05.999999999 -0700 MST。 */
  toString(): string {
    const name = this.offsetMinutes === 0 ? 'UTC' : this.zone(false);
    return `${this.datePart()} ${this.clock()}${this.fraction()} ${this.zone(false)} ${name}`;
  }

  /** time.Time 的 MarshalJSON：RFC3339Nano。 */
  toJSON(): string {
    return `${this.datePart()}T${this.clock()}${this.fraction()}${this.offsetMinutes === 0 ? 'Z' : this.zone(true)}`;
  }

  equals(other: GoTime): boolean {
    return (
      this.year === other.year &&
      this.month === other.month &&
      this.day === other.day &&
      this.hour === other.hour &&
      this.minute === other.minute &&
      this.second === other.second &&
      this.nanos === other.nanos &&
      this.offsetMinutes === other.offsetMinutes
    );
  }
}

/** resolve 里显式 tag 与解析结果不符时的 failf。 */
export class YamlDecodeError extends Error {}

/** v.(map[string]any) */
export function isGoMap(v: unknown): v is GoMap {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !(v instanceof GoFloat) &&
    !(v instanceof AnyMap) &&
    !(v instanceof GoTime)
  );
}

/** v.(int) */
export function isGoInt(v: unknown): v is number {
  return typeof v === 'number';
}

export function hasKey(m: GoMap | null | undefined, key: string): boolean {
  return m !== null && m !== undefined && Object.hasOwn(m, key);
}

/** m[key]（不存在为 nil）。 */
export function get(m: GoMap | null | undefined, key: string): unknown {
  return m !== null && m !== undefined && Object.hasOwn(m, key) ? m[key] : null;
}

export function setOwn(target: GoMap, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** reflect.DeepEqual：int 与 float64 不相等，NaN 不等于自身。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (a instanceof GoFloat || b instanceof GoFloat) {
    return a instanceof GoFloat && b instanceof GoFloat && a.value === b.value;
  }
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (a instanceof GoTime || b instanceof GoTime) return a instanceof GoTime && b instanceof GoTime && a.equals(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a instanceof AnyMap || b instanceof AnyMap) {
    if (!(a instanceof AnyMap) || !(b instanceof AnyMap) || a.entries.length !== b.entries.length) return false;
    return a.entries.every(([key, value]) =>
      b.entries.some(([otherKey, other]) => deepEqual(key, otherKey) && deepEqual(value, other)),
    );
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => Object.hasOwn(b as object, key) && deepEqual((a as GoMap)[key], (b as GoMap)[key]));
}

/** fmt 的 %v。 */
export function formatV(v: unknown): string {
  if (v === null || v === undefined) return '<nil>';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof GoFloat) return formatG(v.value);
  if (v instanceof GoTime) return v.toString();
  if (Array.isArray(v)) return '[' + v.map(formatV).join(' ') + ']';
  if (v instanceof AnyMap) {
    const parts = v.entries.map(([key, value]) => [formatV(key), formatV(value)] as const);
    parts.sort((x, y) => compareBytes(x[0], y[0]));
    return 'map[' + parts.map(([key, value]) => key + ':' + value).join(' ') + ']';
  }
  const m = v as GoMap;
  return (
    'map[' +
    Object.keys(m)
      .sort(compareBytes)
      .map((key) => key + ':' + formatV(m[key]))
      .join(' ') +
    ']'
  );
}

/** 换成普通 JS 值（GoFloat → number，AnyMap → 以 %v 写法为键的对象），供调用方当 JSON 用。 */
export function toPlain(v: unknown): unknown {
  if (v instanceof GoFloat) return v.value;
  if (v instanceof GoTime) return v.toJSON();
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof AnyMap) {
    const out: GoMap = {};
    for (const [key, value] of v.entries) setOwn(out, formatV(key), toPlain(value));
    return out;
  }
  if (isGoMap(v)) {
    const out: GoMap = {};
    for (const key of Object.keys(v)) setOwn(out, key, toPlain(v[key]));
    return out;
  }
  return v;
}
