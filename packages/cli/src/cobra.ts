/**
 * cobra（v1.10）+ pflag（v1.0.9）的最小 TypeScript 复刻。
 *
 * 不用 commander：编排工具与用户都会读 `onset xxx --help`，Go 版的帮助格式（Usage / Flags / Global Flags
 * 分段、pflag 按字节对齐的列、(default "…") 的写法、Did you mean 建议）是他们已经见过的样子，
 * help_test 也在断言帮助内容。这里只实现 internal/cli 实际用到的部分：StringVar、BoolVar、IntVar、
 * StringArrayVar、StringSliceVar、DurationVar，持久参数，参数个数校验，help 子命令与 --version。
 * 文案与格式照抄 cobra / pflag 源码（见各函数注释里对应的上游函数名）。
 */

import { FlagSet, goQuote, ref } from './cobra_flags';
import { formatHelp, formatUsage, minNamePadding, suggestionsFor } from './cobra_help';
import { firstNonFlag, parseFlags } from './cobra_parse';

export {
  type Duration,
  FlagSet,
  formatDuration,
  goQuote,
  Hour,
  Microsecond,
  Millisecond,
  Minute,
  Nanosecond,
  parseDuration,
  type Ref,
  ref,
  Second,
} from './cobra_flags';

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
    if (args.length < min || args.length > max)
      throw new Error(`accepts between ${min} and ${max} arg(s), received ${args.length}`);
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
      this.local.boolVar(
        versionTarget,
        'version',
        false,
        `version for ${this.name() || 'this command'}`,
        this.local.shorthandLookup('v') ? '' : 'v',
      );
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
    return formatUsage(this, this.localFlags(), this.inheritedFlags());
  }

  /** cobra defaultHelpFunc。 */
  helpString(): string {
    return formatHelp(this, this.children.length > 0, () => this.usageString());
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

  /** 解析并执行。错误照 cobra 抛出，由调用方（cli.execute）决定打印与退出码。 */
  async execute(argv: string[]): Promise<void> {
    this.addHelpCommand();
    const [cmd, rest] = this.find(argv);
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
    const positional = parseFlags(cmd.allFlags(), rest);
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
        throw new Error(
          `unknown command ${goQuote(positional[0])} for ${goQuote(cmd.commandPath())}${suggestionsFor(cmd.commands(), positional[0])}`,
        );
      }
      cmd.outOrStdout().write(cmd.helpString());
      return;
    }
    if (cmd.args) cmd.args(cmd, positional);
    else if (!cmd.parent && cmd.children.length > 0 && positional.length > 0) {
      throw new Error(
        `unknown command ${goQuote(positional[0])} for ${goQuote(cmd.commandPath())}${suggestionsFor(cmd.commands(), positional[0])}`,
      );
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
