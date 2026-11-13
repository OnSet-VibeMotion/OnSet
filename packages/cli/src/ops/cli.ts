/**
 * 操作表的命令行适配：给开发与 CI 用（`am beat import track.mp3`），不对外提供。
 * 每条操作按 cli 路径挂进命令树，位置参数与 --flag 从 params 生成，解析完照常走 normalizeParams。
 */
import { Command, type Out, parseDuration, type PositionalArgs, ref, type Ref } from '../cobra';
import { allOps, normalizeParams, type Op, type ParamSpec, type ParamValues } from './op';

/** 命令组（`am beat`、`am memory` 这一层）的说明。 */
export interface Group {
  path: string[];
  summary: string;
  description?: string;
}

const groups = new Map<string, Group>();

export function defineGroup(group: Group): Group {
  groups.set(group.path.join(' '), group);
  return group;
}

export function flagName(key: string, spec: ParamSpec): string {
  return spec.flag ?? key.replace(/_/g, '-');
}

function positionalUse(op: Op): string {
  const pos = Object.entries(op.params)
    .filter(([, s]) => s.positional !== undefined)
    .sort(([, a], [, b]) => (a.positional === 'rest' ? 1e9 : (a.positional as number)) - (b.positional === 'rest' ? 1e9 : (b.positional as number)));
  return pos
    .map(([k, s]) => {
      const name = k.toUpperCase();
      if (s.positional === 'rest') return s.required ? `${name}...` : `[${name}...]`;
      return s.required ? name : `[${name}]`;
    })
    .join(' ');
}

function positionalCheck(op: Op): PositionalArgs {
  const fixed = Object.values(op.params).filter((s) => typeof s.positional === 'number');
  const rest = Object.values(op.params).find((s) => s.positional === 'rest');
  const min = fixed.filter((s) => s.required).length + (rest?.required ? 1 : 0);
  const max = rest ? Infinity : fixed.length;
  return (cmd, args) => {
    if (max === 0 && args.length > 0) throw new Error(`${cmd.commandPath()} 不接受位置参数，实际收到 ${args.length} 个：${args.join(' ')}；用法：${cmd.useLine()}`);
    if (args.length < min || args.length > max) {
      const want = max === Infinity ? `至少 ${min} 个` : min === max ? `${min} 个` : `${min} 到 ${max} 个`;
      throw new Error(`${cmd.commandPath()} 需要 ${want}位置参数，实际收到 ${args.length} 个；用法：${cmd.useLine()}`);
    }
  };
}

/** 把一条操作做成命令。 */
export function opCommand(op: Op, stdout: Out, stderr: Out, unsafe: Ref<boolean>): Command {
  const refs = new Map<string, Ref<unknown>>();
  const leaf = op.cli[op.cli.length - 1]!;
  const use = [leaf, positionalUse(op)].filter((s) => s !== '').join(' ');
  const cmd = new Command({
    use,
    short: op.summary,
    long: op.description ?? '',
    example: (op.examples ?? []).map((e) => '  ' + e).join('\n'),
    disableFlagParsing: op.passthrough,
    args: op.passthrough ? undefined : positionalCheck(op),
    runE: async (c, args) => {
      const values: ParamValues = {};
      if (op.passthrough) {
        values.args = args;
      } else {
        for (const [key, spec] of Object.entries(op.params)) {
          if (spec.positional === undefined) {
            const r = refs.get(key)!;
            // 没在命令行里写的参数交给 normalizeParams 补缺省值，免得 flag 的零值盖过 Op 的缺省。
            if (c.flags().changed(flagName(key, spec))) values[key] = r.value;
            continue;
          }
          if (spec.positional === 'rest') {
            const start = Object.values(op.params).filter((s) => typeof s.positional === 'number').length;
            const rest = args.slice(start);
            if (rest.length > 0) values[key] = rest;
          } else if (args[spec.positional] !== undefined) {
            values[key] = args[spec.positional];
          }
        }
      }
      const result = await op.run(normalizeParams(op, values), { out: stdout, err: stderr, signal: c.context(), unsafe: unsafe.value });
      void result;
    },
  });
  if (!op.passthrough) {
    for (const [key, spec] of Object.entries(op.params)) {
      if (spec.positional !== undefined) continue;
      const name = flagName(key, spec);
      const usage = spec.description;
      const short = spec.shorthand ?? '';
      const f = cmd.flags();
      switch (spec.type) {
        case 'boolean': {
          const r = ref(Boolean(spec.default ?? false));
          f.boolVar(r, name, r.value, usage, short);
          refs.set(key, r as Ref<unknown>);
          break;
        }
        case 'integer': {
          const r = ref(Number(spec.default ?? 0));
          f.intVar(r, name, r.value, usage, short);
          refs.set(key, r as Ref<unknown>);
          break;
        }
        case 'number': {
          const r = ref(Number(spec.default ?? 0));
          f.float64Var(r, name, r.value, usage, short);
          refs.set(key, r as Ref<unknown>);
          break;
        }
        case 'strings': {
          const r = ref<string[]>(Array.isArray(spec.default) ? [...spec.default] : []);
          f.stringArrayVar(r, name, r.value, usage, short);
          refs.set(key, r as Ref<unknown>);
          break;
        }
        case 'duration': {
          // 命令行照 Go 的写法解析（90s、2h），交给操作时转回字符串，与工具服务的写法一致。
          const def = String(spec.default ?? '0s');
          const r = ref(parseDuration(def));
          f.durationVar(r, name, r.value, usage, short);
          const text = { get value(): unknown { return durationText(r.value); }, set value(_v: unknown) {} };
          refs.set(key, text as Ref<unknown>);
          break;
        }
        default: {
          const r = ref(String(spec.default ?? ''));
          f.stringVar(r, name, r.value, usage, short);
          refs.set(key, r as Ref<unknown>);
        }
      }
    }
  }
  return cmd;
}

/** Duration（纳秒）→ Go 写法，交给操作再解析。 */
function durationText(ns: number): string {
  return `${ns}ns`;
}

/** 把全部操作挂进根命令，按 cli 路径建出中间的命令组。 */
export function mountOps(root: Command, stdout: Out, stderr: Out, unsafe: Ref<boolean>): void {
  const groupCommands = new Map<string, Command>();
  const groupOf = (path: string[]): Command => {
    if (path.length === 0) return root;
    const key = path.join(' ');
    let g = groupCommands.get(key);
    if (g) return g;
    const parent = groupOf(path.slice(0, -1));
    const name = path[path.length - 1]!;
    // 命令行专用的内部命令（studio permission-mcp 等）先挂上了同名的组时，接着往里挂。
    const existing = parent.commands().find((c) => c.name() === name);
    if (existing) {
      groupCommands.set(key, existing);
      return existing;
    }
    const def = groups.get(key);
    g = new Command({ use: name, short: def?.summary ?? '', long: def?.description ?? '' });
    parent.addCommand(g);
    groupCommands.set(key, g);
    return g;
  };
  for (const op of allOps()) groupOf(op.cli.slice(0, -1)).addCommand(opCommand(op, stdout, stderr, unsafe));
}
