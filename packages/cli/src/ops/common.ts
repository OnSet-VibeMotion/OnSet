/** 多条操作共用的参数定义。 */
import { parseDuration, type Duration } from '../cobra';
import { ParamError, type ParamSpec } from './op';

/** 项目根目录。工具服务与客户端后端都在项目根里执行，缺省「.」即可。 */
export const projectRoot: ParamSpec = { type: 'string', description: '项目根目录', default: '.' };

/** 超时，Go 的 time.Duration 写法（90s、30m、2h）。 */
export function timeout(def: string, what: string): ParamSpec {
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
