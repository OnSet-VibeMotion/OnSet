/**
 * 操作（onset 工具）的共用零件：内置插件在 apply 里登记操作（ctx.op）时用，cli 的操作表也从这里取同一份
 * （ops/common.ts、ops/op.ts 的 ParamError 都是转出）。这里不依赖任何功能包。
 */
import type { PluginParamSpec } from '../plugin/types';

/** 参数校验或调用方式不对：工具服务把它原样交给 agent，不当成操作失败的堆栈。 */
export class ParamError extends Error {}

/** Go 的 time.Duration，单位纳秒，用 number 表示（够用到约 104 天）。 */
export type Duration = number;

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

/** 项目根目录。工具服务与客户端后端都在项目根里执行，缺省「.」即可。 */
export const projectRoot: PluginParamSpec = { type: 'string', description: '项目根目录', default: '.' };

/** 超时，Go 的 time.Duration 写法（90s、30m、2h）。 */
export function timeout(def: string, what: string): PluginParamSpec {
  return { type: 'duration', description: `${what}的最长等待时间（例如 30m）`, default: def };
}

/** 解析 duration 参数；必须为正。 */
export function positiveDuration(value: unknown, name: string): Duration {
  let d: Duration;
  try {
    d = parseDuration(String(value));
  } catch (err) {
    throw new ParamError(`${name}：${(err as Error).message}`);
  }
  if (d <= 0) throw new ParamError(`${name} 必须为正`);
  return d;
}

/** context.WithTimeout：父信号与超时任一触发即取消。setTimeout 只认 2^31-1 毫秒以内，更长的超时等于不设。 */
export function withTimeoutSignal(parent: AbortSignal, timeout: Duration): AbortSignal {
  const ms = timeout / 1e6;
  if (ms > 2 ** 31 - 1) return parent;
  return AbortSignal.any([parent, AbortSignal.timeout(Math.max(1, Math.ceil(ms)))]);
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

export function bool(v: unknown): boolean {
  return v === true;
}

export function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

export function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
