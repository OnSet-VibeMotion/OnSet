/**
 * cobra/pflag 复刻里的参数集合、值解析与 Go 风格格式化。
 */

import { formatG } from '@onset/engine/gofmt';
import { parseDuration } from '@onset/engine/opkit';

export type FlagType = 'string' | 'bool' | 'int' | 'float64' | 'stringArray' | 'stringSlice' | 'duration';

export interface Flag {
  name: string;
  shorthand: string;
  usage: string;
  type: FlagType;
  defValue: string;
  changed: boolean;
  set(value: string): void;
  noOptDefVal: string;
  hidden: boolean;
}

/** 一个可以被参数写入的变量。对应 Go 里 StringVar(&x, …) 的 &x。 */
export interface Ref<T> {
  value: T;
}

export const ref = <T>(value: T): Ref<T> => ({ value });

export class FlagError extends Error {}

/** Go 的 time.Duration，单位纳秒，用 number 表示（够用到约 104 天）。 */
export type Duration = number;
export const Nanosecond = 1;
export const Microsecond = 1000;
export const Millisecond = 1_000_000;
export const Second = 1_000_000_000;
export const Minute = 60 * Second;
export const Hour = 60 * Minute;

/** time.ParseDuration（与内置插件的操作共用一份）。 */
export { parseDuration };

/** time.Duration.String()：1h2m3.5s、500ms、0s。 */
export function formatDuration(d: Duration): string {
  if (d === 0) return '0s';
  const neg = d < 0;
  let u = Math.abs(d);
  let out: string;
  if (u < Second) {
    const [unit, size] = u < Microsecond ? ['ns', 1] : u < Millisecond ? ['µs', Microsecond] : ['ms', Millisecond];
    out = trimFloat(u / (size as number)) + unit;
  } else {
    const h = Math.floor(u / Hour);
    u -= h * Hour;
    const m = Math.floor(u / Minute);
    u -= m * Minute;
    const sec = trimFloat(u / Second) + 's';
    out = h > 0 ? `${h}h${m}m${sec}` : m > 0 ? `${m}m${sec}` : sec;
  }
  return neg ? '-' + out : out;
}

function trimFloat(n: number): string {
  return String(Number(n.toFixed(9)));
}

/** strconv.Quote 的近似：Go 的 %q 保留可打印 Unicode，只转义引号、反斜杠与控制字符。 */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + '"';
}

function parseGoInt(raw: string): number {
  const s = raw.replace(/_/g, '');
  const m = /^([+-])?(0[xX][0-9a-fA-F]+|0[oO]?[0-7]+|0[bB][01]+|[0-9]+)$/.exec(s);
  if (!m) throw new Error(`strconv.ParseInt: parsing ${goQuote(raw)}: invalid syntax`);
  const body = m[2];
  let value: number;
  if (/^0[xX]/.test(body)) value = parseInt(body.slice(2), 16);
  else if (/^0[bB]/.test(body)) value = parseInt(body.slice(2), 2);
  else if (/^0[oO]/.test(body)) value = parseInt(body.slice(2), 8);
  else if (body.length > 1 && body.startsWith('0')) value = parseInt(body.slice(1), 8);
  else value = parseInt(body, 10);
  return m[1] === '-' ? -value : value;
}

/** strconv.ParseFloat 的常用子集：十进制、科学计数法、inf / infinity / nan（不区分大小写，可带正负号）。 */
function parseGoFloat(raw: string): number {
  const s = raw.trim() === raw ? raw : '';
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^nan$/i.test(s)) return NaN;
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  throw new Error(`strconv.ParseFloat: parsing ${goQuote(raw)}: invalid syntax`);
}

function parseGoBool(raw: string): boolean {
  if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(raw)) return true;
  if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(raw)) return false;
  throw new Error(`strconv.ParseBool: parsing ${goQuote(raw)}: invalid syntax`);
}

/** pflag 的 stringSlice 用 CSV 读一行。 */
function readCSV(value: string): string[] {
  if (value === '') return [];
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === '"' && value[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

export class FlagSet {
  readonly formal = new Map<string, Flag>();
  private readonly shorthands = new Map<string, Flag>();

  private add(flag: Omit<Flag, 'changed' | 'noOptDefVal' | 'hidden'> & { noOptDefVal?: string }): void {
    if (this.formal.has(flag.name)) throw new Error(`flag redefined: ${flag.name}`);
    const full: Flag = { changed: false, noOptDefVal: '', hidden: false, ...flag };
    this.formal.set(flag.name, full);
    if (flag.shorthand) this.shorthands.set(flag.shorthand, full);
  }

  addFlag(flag: Flag): void {
    if (this.formal.has(flag.name)) return;
    this.formal.set(flag.name, flag);
    if (flag.shorthand) this.shorthands.set(flag.shorthand, flag);
  }

  stringVar(target: Ref<string>, name: string, def: string, usage: string, shorthand = ''): void {
    target.value = def;
    this.add({ name, shorthand, usage, type: 'string', defValue: def, set: (v) => (target.value = v) });
  }

  boolVar(target: Ref<boolean>, name: string, def: boolean, usage: string, shorthand = ''): void {
    target.value = def;
    this.add({
      name,
      shorthand,
      usage,
      type: 'bool',
      defValue: String(def),
      set: (v) => (target.value = parseGoBool(v)),
      noOptDefVal: 'true',
    });
  }

  intVar(target: Ref<number>, name: string, def: number, usage: string, shorthand = ''): void {
    target.value = def;
    this.add({
      name,
      shorthand,
      usage,
      type: 'int',
      defValue: String(def),
      set: (v) => (target.value = parseGoInt(v)),
    });
  }

  float64Var(target: Ref<number>, name: string, def: number, usage: string, shorthand = ''): void {
    target.value = def;
    this.add({
      name,
      shorthand,
      usage,
      type: 'float64',
      defValue: formatG(def),
      set: (v) => (target.value = parseGoFloat(v)),
    });
  }

  durationVar(target: Ref<Duration>, name: string, def: Duration, usage: string, shorthand = ''): void {
    target.value = def;
    this.add({
      name,
      shorthand,
      usage,
      type: 'duration',
      defValue: formatDuration(def),
      set: (v) => (target.value = parseDuration(v)),
    });
  }

  /** StringArrayVar：每次出现追加一项，不按逗号拆。第一次出现时先清掉默认值。 */
  stringArrayVar(target: Ref<string[]>, name: string, def: string[], usage: string, shorthand = ''): void {
    target.value = [...def];
    let fresh = true;
    this.add({
      name,
      shorthand,
      usage,
      type: 'stringArray',
      defValue: '[' + def.join(',') + ']',
      set: (v) => {
        target.value = fresh ? [v] : [...target.value, v];
        fresh = false;
      },
    });
  }

  /** StringSliceVar：每次出现按 CSV 拆开追加。第一次出现时先清掉默认值。 */
  stringSliceVar(target: Ref<string[]>, name: string, def: string[], usage: string, shorthand = ''): void {
    target.value = [...def];
    let fresh = true;
    this.add({
      name,
      shorthand,
      usage,
      type: 'stringSlice',
      defValue: '[' + def.join(',') + ']',
      set: (v) => {
        const parts = readCSV(v);
        target.value = fresh ? parts : [...target.value, ...parts];
        fresh = false;
      },
    });
  }

  lookup(name: string): Flag | undefined {
    return this.formal.get(name);
  }

  changed(name: string): boolean {
    return this.formal.get(name)?.changed ?? false;
  }

  shorthandLookup(short: string): Flag | undefined {
    return this.shorthands.get(short);
  }

  sorted(): Flag[] {
    return [...this.formal.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  hasAvailable(): boolean {
    return [...this.formal.values()].some((f) => !f.hidden);
  }

  /** pflag FlagSet.FlagUsages（不折行）。 */
  usages(): string {
    const lines: string[] = [];
    let maxlen = 0;
    for (const flag of this.sorted()) {
      if (flag.hidden) continue;
      let line = flag.shorthand ? `  -${flag.shorthand}, --${flag.name}` : `      --${flag.name}`;
      const [varname, usage] = unquoteUsage(flag);
      if (varname) line += ' ' + varname;
      if (flag.noOptDefVal && !(flag.type === 'bool' && flag.noOptDefVal === 'true')) {
        line += flag.type === 'string' ? `[="${flag.noOptDefVal}"]` : `[=${flag.noOptDefVal}]`;
      }
      line += '\x00';
      // Go 的 len 按字节计。
      if (Buffer.byteLength(line) > maxlen) maxlen = Buffer.byteLength(line);
      line += usage;
      if (!defaultIsZero(flag))
        line += flag.type === 'string' ? ` (default ${goQuote(flag.defValue)})` : ` (default ${flag.defValue})`;
      lines.push(line);
    }
    let out = '';
    for (const line of lines) {
      const sidx = line.indexOf('\x00');
      const left = line.slice(0, sidx);
      const spacing = ' '.repeat(maxlen - Buffer.byteLength(line.slice(0, sidx)));
      const rest = line.slice(sidx + 1).replace(/\n/g, '\n' + ' '.repeat(maxlen + 2));
      out += `${left} ${spacing} ${rest}\n`;
    }
    return out;
  }
}

function unquoteUsage(flag: Flag): [string, string] {
  const usage = flag.usage;
  const i = usage.indexOf('`');
  if (i >= 0) {
    const j = usage.indexOf('`', i + 1);
    if (j >= 0) {
      const name = usage.slice(i + 1, j);
      return [name, usage.slice(0, i) + name + usage.slice(j + 1)];
    }
  }
  const names: Record<FlagType, string> = {
    string: 'string',
    bool: '',
    int: 'int',
    float64: 'float',
    stringArray: 'stringArray',
    stringSlice: 'strings',
    duration: 'duration',
  };
  return [names[flag.type], usage];
}

function defaultIsZero(flag: Flag): boolean {
  switch (flag.type) {
    case 'bool':
      return flag.defValue === 'false' || flag.defValue === '';
    case 'duration':
      return flag.defValue === '0' || flag.defValue === '0s';
    case 'int':
    case 'float64':
      return flag.defValue === '0';
    case 'string':
      return flag.defValue === '';
    case 'stringArray':
    case 'stringSlice':
      return flag.defValue === '[]';
  }
}
