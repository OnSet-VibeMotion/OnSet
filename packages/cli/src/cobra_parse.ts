/**
 * cobra/pflag 复刻里的参数解析与子命令扫描。
 */

import { type Flag, FlagError, type FlagSet, goQuote } from './cobra_flags';

/** pflag 的 Parse（interspersed）：返回非 flag 参数。 */
export function parseFlags(flags: FlagSet, args: string[]): string[] {
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

function setFlag(flag: Flag, value: string, display: string): void {
  try {
    flag.set(value);
    flag.changed = true;
  } catch (err) {
    throw new FlagError(
      `invalid argument ${goQuote(value)} for ${goQuote(display)} flag: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** cobra stripFlags 的简化：找第一个既不是 flag 也不是 flag 取值的词。 */
export function firstNonFlag(args: string[], flags: FlagSet): string | undefined {
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
