/**
 * cobra（v1.10）+ pflag（v1.0.9）的最小 TypeScript 复刻。
 *
 * 不用 commander：编排工具与用户都会读 `am xxx --help`，Go 版的帮助格式（Usage / Flags / Global Flags
 * 分段、pflag 按字节对齐的列、(default "…") 的写法、Did you mean 建议）是他们已经见过的样子，
 * help_test 也在断言帮助内容。这里只实现 internal/cli 实际用到的部分：StringVar、BoolVar、IntVar、
 * StringArrayVar、StringSliceVar、DurationVar，持久参数，参数个数校验，help 子命令与 --version。
 * 文案与格式照抄 cobra / pflag 源码（见各函数注释里对应的上游函数名）。
 */

import { formatG } from '@am/engine/gofmt';

export interface Out {
  write(text: string): void;
  /** 输出是不是终端（对应 Go 里 *os.File 且 term.IsTerminal）。process.stdout 自带这个字段。 */
  isTTY?: boolean;
}

/** 带退出码的错误。message 为空表示命令已经自己把结果打在屏幕上，Execute 不再补一行。对应 internal/cli 的 exitError。 */
export class ExitError extends Error {
  /** 不带退出码后缀的原始消息。 */
  readonly bare: string;

  constructor(
    readonly code: number,
    message = '',
  ) {
    // Go 版 exitError.Error() 是「消息（退出码 N）」。
    super(message + '（退出码 ' + code + '）');
    this.bare = message;
  }
}

// ---------------------------------------------------------------- flags

type FlagType = 'string' | 'bool' | 'int' | 'float64' | 'stringArray' | 'stringSlice' | 'duration';

interface Flag {
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

class FlagError extends Error {}

/** Go 的 time.Duration，单位纳秒，用 number 表示（够用到约 104 天）。 */
export type Duration = number;
export const Nanosecond = 1;
export const Microsecond = 1000;
export const Millisecond = 1_000_000;
export const Second = 1_000_000_000;
export const Minute = 60 * Second;
export const Hour = 60 * Minute;

const unitMap: Record<string, number> = { ns: 1, us: 1e3, µs: 1e3, μs: 1e3, ms: 1e6, s: 1e9, m: 60e9, h: 3600e9 };

/** time.ParseDuration。错误文案照抄 Go。 */
export function parseDuration(s: string): Duration {
  const orig = s;
  let d = 0;
  let neg = false;
  if (s && (s[0] === '-' || s[0] === '+')) {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  if (s === '0') return 0;
  if (s === '') throw new Error(`time: invalid duration ${JSON.stringify(orig)}`);
  while (s !== '') {
    const m = /^(\d*)(?:\.(\d*))?/.exec(s)!;
    if (!m[1] && !m[2]) throw new Error(`time: invalid duration ${JSON.stringify(orig)}`);
    s = s.slice(m[0].length);
    const u = /^[^\d.]+/.exec(s)?.[0] ?? '';
    if (!u) throw new Error(`time: missing unit in duration ${JSON.stringify(orig)}`);
    const unit = unitMap[u];
    if (unit === undefined) throw new Error(`time: unknown unit ${JSON.stringify(u)} in duration ${JSON.stringify(orig)}`);
    s = s.slice(u.length);
    d += Number(m[1] || '0') * unit + (m[2] ? Number('0.' + m[2]) * unit : 0);
  }
  return Math.round(neg ? -d : d);
}

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
  let body = m[2];
  let value: number;
  if (/^0[xX]/.test(body)) value = parseInt(body.slice(2), 16);
  else if (/^0[bB]/.test(body)) value = parseInt(body.slice(2), 2);
  else if (/^0[oO]/.test(body)) value = parseInt(body.slice(2), 8);
  else if (body.length > 1 && body.startsWith('0')) value = parseInt(body.slice(1), 8);
  else value = parseInt((body = body), 10);
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
    this.add({ name, shorthand, usage, type: 'bool', defValue: String(def), set: (v) => (target.value = parseGoBool(v)), noOptDefVal: 'true' });
  }

  intVar(target: Ref<number>, name: string, def: number, usage: string, shorthand = ''): void {
    target.value = def;
    this.add({ name, shorthand, usage, type: 'int', defValue: String(def), set: (v) => (target.value = parseGoInt(v)) });
  }

  float64Var(target: Ref<number>, name: string, def: number, usage: string, shorthand = ''): void {
    target.value = def;
    this.add({ name, shorthand, usage, type: 'float64', defValue: formatG(def), set: (v) => (target.value = parseGoFloat(v)) });
  }

  durationVar(target: Ref<Duration>, name: string, def: Duration, usage: string, shorthand = ''): void {
    target.value = def;
    this.add({ name, shorthand, usage, type: 'duration', defValue: formatDuration(def), set: (v) => (target.value = parseDuration(v)) });
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
      if (!defaultIsZero(flag)) line += flag.type === 'string' ? ` (default ${goQuote(flag.defValue)})` : ` (default ${flag.defValue})`;
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
  const names: Record<FlagType, string> = { string: 'string', bool: '', int: 'int', float64: 'float', stringArray: 'stringArray', stringSlice: 'strings', duration: 'duration' };
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

// ---------------------------------------------------------------- args validators

export type PositionalArgs = (cmd: Command, args: string[]) => void;

export const NoArgs: PositionalArgs = (cmd, args) => {
  if (args.length > 0) throw new Error(`unknown command ${goQuote(args[0])} for ${goQuote(cmd.commandPath())}`);
};
export const ArbitraryArgs: PositionalArgs = () => {};
export const ExactArgs =
  (n: number): PositionalArgs =>
  (_cmd, args) => {
    if (args.length !== n) throw new Error(`accepts ${n} arg(s), received ${args.length}`);
  };
export const MinimumNArgs =
  (n: number): PositionalArgs =>
  (_cmd, args) => {
    if (args.length < n) throw new Error(`requires at least ${n} arg(s), only received ${args.length}`);
  };
export const MaximumNArgs =
  (n: number): PositionalArgs =>
  (_cmd, args) => {
    if (args.length > n) throw new Error(`accepts at most ${n} arg(s), received ${args.length}`);
  };
export const RangeArgs =
  (min: number, max: number): PositionalArgs =>
  (_cmd, args) => {
    if (args.length < min || args.length > max) throw new Error(`accepts between ${min} and ${max} arg(s), received ${args.length}`);
  };

// ---------------------------------------------------------------- command

export interface CommandOptions {
  use: string;
  short?: string;
  long?: string;
  example?: string;
  aliases?: string[];
  version?: string;
  hidden?: boolean;
  /** 不解析参数，原样交给 runE（cobra DisableFlagParsing）；--help 也一并转交。 */
  disableFlagParsing?: boolean;
  args?: PositionalArgs;
  runE?: (cmd: Command, args: string[]) => void | Promise<void>;
}

const minNamePadding = 11;

export class Command {
  use: string;
  short: string;
  long: string;
  example: string;
  aliases: string[];
  version: string;
  hidden: boolean;
  disableFlagParsing: boolean;
  args?: PositionalArgs;
  runE?: (cmd: Command, args: string[]) => void | Promise<void>;
  parent?: Command;
  private readonly children: Command[] = [];
  private readonly local = new FlagSet();
  private readonly persistent = new FlagSet();
  private out?: Out;
  private err?: Out;
  private signal?: AbortSignal;

  constructor(options: CommandOptions) {
    this.use = options.use;
    this.short = options.short ?? '';
    this.long = options.long ?? '';
    this.example = options.example ?? '';
    this.aliases = options.aliases ?? [];
    this.version = options.version ?? '';
    this.hidden = options.hidden ?? false;
    this.disableFlagParsing = options.disableFlagParsing ?? false;
    this.args = options.args;
    this.runE = options.runE;
  }

  name(): string {
    return this.use.split(' ')[0];
  }

  addCommand(...cmds: Command[]): void {
    for (const cmd of cmds) {
      cmd.parent = this;
      this.children.push(cmd);
    }
  }

  /** 子命令，按名字排序（cobra 默认 EnableCommandSorting）。 */
  commands(): Command[] {
    return [...this.children].sort((a, b) => (a.name() < b.name() ? -1 : a.name() > b.name() ? 1 : 0));
  }

  flags(): FlagSet {
    return this.local;
  }

  persistentFlags(): FlagSet {
    return this.persistent;
  }

  runnable(): boolean {
    return this.runE !== undefined;
  }

  hasParent(): boolean {
    return this.parent !== undefined;
  }

  root(): Command {
    return this.parent ? this.parent.root() : this;
  }

  commandPath(): string {
    return this.parent ? `${this.parent.commandPath()} ${this.name()}` : this.name();
  }

  isAvailableCommand(): boolean {
    return !this.hidden && (this.runnable() || this.children.some((c) => c.isAvailableCommand()));
  }

  hasAvailableSubCommands(): boolean {
    return this.children.some((c) => c.isAvailableCommand());
  }

  /** 持久参数：自己与祖先声明的 PersistentFlags。 */
  private inheritedFlags(): FlagSet {
    const set = new FlagSet();
    for (let p = this.parent; p; p = p.parent) for (const f of p.persistent.formal.values()) set.addFlag(f);
    return set;
  }

  /** LocalFlags：本命令的 Flags 加上自己声明的持久参数。 */
  private localFlags(): FlagSet {
    const set = new FlagSet();
    for (const f of this.local.formal.values()) set.addFlag(f);
    for (const f of this.persistent.formal.values()) set.addFlag(f);
    return set;
  }

  private allFlags(): FlagSet {
    const set = this.localFlags();
    for (const f of this.inheritedFlags().formal.values()) set.addFlag(f);
    return set;
  }

  private initDefaultFlags(): void {
    if (!this.local.lookup('help')) {
      const helpTarget = ref(false);
      this.local.boolVar(helpTarget, 'help', false, `help for ${this.name() || 'this command'}`, 'h');
    }
    if (this.version && !this.local.lookup('version')) {
      const versionTarget = ref(false);
      this.local.boolVar(versionTarget, 'version', false, `version for ${this.name() || 'this command'}`, this.local.shorthandLookup('v') ? '' : 'v');
    }
  }

  useLine(): string {
    const useline = this.parent ? `${this.parent.commandPath()} ${this.use}` : this.use;
    this.initDefaultFlags();
    return this.allFlags().hasAvailable() && !useline.includes('[flags]') ? useline + ' [flags]' : useline;
  }

  namePadding(): number {
    if (!this.parent) return minNamePadding;
    const max = Math.max(0, ...this.parent.children.map((c) => c.name().length));
    return Math.max(minNamePadding, max);
  }

  /** cobra defaultUsageFunc。 */
  usageString(): string {
    this.initDefaultFlags();
    let w = 'Usage:';
    if (this.runnable()) w += `\n  ${this.useLine()}`;
    if (this.hasAvailableSubCommands()) w += `\n  ${this.commandPath()} [command]`;
    if (this.aliases.length > 0) w += `\n\nAliases:\n  ${[this.name(), ...this.aliases].join(', ')}`;
    if (this.example) w += `\n\nExamples:\n${this.example}`;
    if (this.hasAvailableSubCommands()) {
      w += '\n\nAvailable Commands:';
      for (const sub of this.commands()) {
        if (sub.isAvailableCommand() || sub.name() === 'help') w += `\n  ${sub.name().padEnd(sub.namePadding())} ${sub.short}`;
      }
    }
    const local = this.localFlags();
    if (local.hasAvailable()) w += '\n\nFlags:\n' + local.usages().trimEnd();
    const inherited = this.inheritedFlags();
    if (inherited.hasAvailable()) w += '\n\nGlobal Flags:\n' + inherited.usages().trimEnd();
    if (this.hasAvailableSubCommands()) w += `\n\nUse "${this.commandPath()} [command] --help" for more information about a command.`;
    return w + '\n';
  }

  /** cobra defaultHelpFunc。 */
  helpString(): string {
    const text = (this.long || this.short).trimEnd();
    let out = text ? text + '\n\n' : '';
    if (this.runnable() || this.children.length > 0) out += this.usageString();
    return out;
  }

  // -------------------------------------------------------------- io

  setOut(out: Out): void {
    this.out = out;
  }

  setErr(err: Out): void {
    this.err = err;
  }

  outOrStdout(): Out {
    return this.out ?? this.parent?.outOrStdout() ?? { write: (t) => process.stdout.write(t) };
  }

  errOrStderr(): Out {
    return this.err ?? this.parent?.errOrStderr() ?? { write: (t) => process.stderr.write(t) };
  }

  setContext(signal: AbortSignal): void {
    this.signal = signal;
  }

  /** 对应 cmd.Context()：取消信号。 */
  context(): AbortSignal {
    return this.signal ?? this.parent?.context() ?? new AbortController().signal;
  }

  // -------------------------------------------------------------- execution

  private findNext(name: string): Command | undefined {
    return this.children.find((c) => c.name() === name || c.aliases.includes(name));
  }

  /** cobra Find：沿参数里的非参数词找到子命令；flag 与其取值跳过。 */
  private find(args: string[]): [Command, string[]] {
    let cmd: Command = this;
    let rest = [...args];
    for (;;) {
      const next = firstNonFlag(rest, cmd.allFlags());
      if (next === undefined) break;
      const child = cmd.findNext(next);
      if (!child) break;
      const index = rest.indexOf(next);
      rest = [...rest.slice(0, index), ...rest.slice(index + 1)];
      cmd = child;
    }
    return [cmd, rest];
  }

  private suggestionsFor(typed: string): string {
    const suggestions: string[] = [];
    for (const cmd of this.commands()) {
      if (!cmd.isAvailableCommand()) continue;
      const near = levenshtein(typed.toLowerCase(), cmd.name().toLowerCase()) <= 2;
      if (near || cmd.name().toLowerCase().startsWith(typed.toLowerCase())) suggestions.push(cmd.name());
    }
    return suggestions.length ? '\n\nDid you mean this?\n' + suggestions.map((s) => `\t${s}\n`).join('') : '';
  }

  /** pflag 的 Parse（interspersed）：返回非 flag 参数。 */
  private parseFlags(args: string[]): string[] {
    const flags = this.allFlags();
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') {
        positional.push(...args.slice(i + 1));
        break;
      }
      if (arg.startsWith('--') && arg.length > 2) {
        const body = arg.slice(2);
        if (body.startsWith('-') || body.startsWith('=')) throw new FlagError(`bad flag syntax: ${arg}`);
        const eq = body.indexOf('=');
        const name = eq >= 0 ? body.slice(0, eq) : body;
        const flag = flags.lookup(name);
        if (!flag) throw new FlagError(`unknown flag: --${name}`);
        let value: string;
        if (eq >= 0) value = body.slice(eq + 1);
        else if (flag.noOptDefVal) value = flag.noOptDefVal;
        else if (i + 1 < args.length) value = args[++i];
        else throw new FlagError(`flag needs an argument: --${name}`);
        setFlag(flag, value, `--${name}`);
      } else if (arg.startsWith('-') && arg.length > 1) {
        const shorts = arg.slice(1);
        for (let j = 0; j < shorts.length; j++) {
          const c = shorts[j];
          const flag = flags.shorthandLookup(c);
          if (!flag) throw new FlagError(`unknown shorthand flag: ${goQuote(c)} in -${shorts}`);
          let value: string;
          if (shorts[j + 1] === '=') {
            value = shorts.slice(j + 2);
            j = shorts.length;
          } else if (flag.noOptDefVal) value = flag.noOptDefVal;
          else if (j + 1 < shorts.length) {
            value = shorts.slice(j + 1);
            j = shorts.length;
          } else if (i + 1 < args.length) value = args[++i];
          else throw new FlagError(`flag needs an argument: ${goQuote(c)} in -${shorts}`);
          setFlag(flag, value, `-${flag.shorthand}, --${flag.name}`);
        }
      } else positional.push(arg);
    }
    return positional;
  }

  /** 解析并执行。错误照 cobra 抛出，由调用方（cli.execute）决定打印与退出码。 */
  async execute(argv: string[]): Promise<void> {
    this.addHelpCommand();
    let [cmd, rest] = this.find(argv);
    if (cmd.name() === 'help' && cmd.parent === this) {
      const [target] = this.find(rest.filter((a) => !a.startsWith('-')));
      cmd.outOrStdout().write(target.helpString());
      return;
    }
    cmd.initDefaultFlags();
    if (cmd.disableFlagParsing && cmd.runnable()) {
      await cmd.runE!(cmd, rest);
      return;
    }
    const positional = cmd.parseFlags(rest);
    if (cmd.local.lookup('help')?.changed && helpRequested(cmd)) {
      cmd.outOrStdout().write(cmd.helpString());
      return;
    }
    if (cmd.version && cmd.local.lookup('version')?.changed) {
      cmd.outOrStdout().write(`${cmd.name()} version ${cmd.version}\n`);
      return;
    }
    if (!cmd.runnable()) {
      // 有子命令的根命令遇到不认识的词：unknown command + 建议（cobra legacyArgs）。
      if (!cmd.parent && positional.length > 0 && cmd.children.length > 0) {
        throw new Error(`unknown command ${goQuote(positional[0])} for ${goQuote(cmd.commandPath())}${cmd.suggestionsFor(positional[0])}`);
      }
      cmd.outOrStdout().write(cmd.helpString());
      return;
    }
    if (cmd.args) cmd.args(cmd, positional);
    else if (!cmd.parent && cmd.children.length > 0 && positional.length > 0) {
      throw new Error(`unknown command ${goQuote(positional[0])} for ${goQuote(cmd.commandPath())}${cmd.suggestionsFor(positional[0])}`);
    }
    await cmd.runE!(cmd, positional);
  }

  private addHelpCommand(): void {
    if (this.children.length === 0 || this.children.some((c) => c.name() === 'help')) return;
    this.addCommand(
      new Command({
        use: 'help [command]',
        short: 'Help about any command',
        long: `Help provides help for any command in the application.\nSimply type ${this.name()} help [path to command] for full details.`,
        runE: () => {},
      }),
    );
  }
}

function helpRequested(cmd: Command): boolean {
  const flag = cmd.flags().lookup('help');
  return flag !== undefined;
}

function setFlag(flag: Flag, value: string, display: string): void {
  try {
    flag.set(value);
    flag.changed = true;
  } catch (err) {
    throw new FlagError(`invalid argument ${goQuote(value)} for ${goQuote(display)} flag: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** cobra stripFlags 的简化：找第一个既不是 flag 也不是 flag 取值的词。 */
function firstNonFlag(args: string[], flags: FlagSet): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return undefined;
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0];
      const flag = flags.lookup(name);
      if (!arg.includes('=') && flag && !flag.noOptDefVal) i++;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const last = arg[arg.length - 1];
      const flag = flags.shorthandLookup(last);
      if (arg.length === 2 && flag && !flag.noOptDefVal) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

function levenshtein(s: string, t: string): number {
  const d = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array(t.length).fill(0)]);
  for (let j = 0; j <= t.length; j++) d[0][j] = j;
  for (let j = 1; j <= t.length; j++) {
    for (let i = 1; i <= s.length; i++) {
      d[i][j] = s[i - 1] === t[j - 1] ? d[i - 1][j - 1] : Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]) + 1;
    }
  }
  return d[s.length][t.length];
}
