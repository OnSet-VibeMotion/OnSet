/**
 * 操作的执行进程：`am.cjs __op <名字> <参数 JSON>`。工具服务与客户端后端都起这个进程跑一条操作——
 * 渲染、拼接动辄几小时，放在单独的进程里才能整组取消，崩了也不拖垮调用方。
 *
 * 输出协议见 @am/engine/opworker。
 */
import * as envutil from '@am/engine/envutil';
import { ExitError, type Out } from '../cobra';
import { ResultMarker, type WorkerResult } from '@am/engine/opworker';
import { findOp, normalizeParams, opScopes, ParamError, type OpScope, type ParamValues } from './op';
import { OpScopeEnv } from '@am/engine/opworker';

/** 失败的退出码：与命令行相同，127 缺外部命令，130 被中断，ExitError 透传子进程的。 */
export function exitCodeOf(err: unknown, signal: AbortSignal): number {
  if (err instanceof ExitError) return err.code;
  if (signal.aborted) return 130;
  if (String((err as Error)?.message ?? '').includes(envutil.MissingToolPrefix)) return 127;
  return 1;
}

export async function runOpWorker(name: string, paramsJSON: string, out: Out, signal: AbortSignal, unsafe: boolean): Promise<number> {
  const finish = (r: WorkerResult): number => {
    out.write(ResultMarker + JSON.stringify(r) + '\n');
    return r.exit_code;
  };
  const op = findOp(name);
  if (!op) return finish({ ok: false, error: `没有这个操作：${name}`, param_error: true, exit_code: 1 });
  // 调用方要求的权限范围（客户端替第三方插件调 am 操作时给 orchestrator）：不在范围里的操作一律拒绝。
  const scope = process.env[OpScopeEnv];
  if (scope && !opScopes(op).includes(scope as OpScope)) return finish({ ok: false, error: `${name} 不在 ${scope} 能调用的范围里`, param_error: true, exit_code: 1 });
  let params: ParamValues;
  try {
    const parsed: unknown = paramsJSON.trim() === '' ? {} : JSON.parse(paramsJSON);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ParamError('参数要是一个 JSON 对象');
    params = normalizeParams(op, parsed as ParamValues);
  } catch (err) {
    return finish({ ok: false, error: (err as Error).message, param_error: true, exit_code: 1 });
  }
  try {
    const result = await op.run(params, { out, err: out, signal, unsafe });
    return finish({ ok: true, data: result ? result.data : undefined, exit_code: 0 });
  } catch (err) {
    const message = err instanceof ExitError ? err.bare : String((err as Error)?.message ?? err);
    return finish({ ok: false, error: message, param_error: err instanceof ParamError, exit_code: exitCodeOf(err, signal) });
  }
}
