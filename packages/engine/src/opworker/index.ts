/**
 * onset 操作执行进程（`onset.cjs __op <名字> <参数 JSON>`）的输出协议。执行进程在 packages/cli/src/ops/worker.ts，
 * 调用方是工具服务（MCP）与客户端后端（studio/tasks.ts）。
 *
 * stdout 先是操作写下的文字（边跑边出），最后一行是 ResultMarker 加一段 JSON（WorkerResult）。
 * 没有这一行说明进程没跑完就退出了。
 */

export const ResultMarker = '\u0000am-result ';

/** 执行进程的入口参数：`<onset> __op <名字> <参数 JSON>`。 */
export const WorkerArg = '__op';
export * from './broker';

/** 执行进程只跑这个权限范围里的操作（如 orchestrator）；不设不限。客户端替第三方插件调 onset 操作时设它。 */
export const OpScopeEnv = 'ONSET_OP_SCOPE';

export interface WorkerResult {
  ok: boolean;
  /** 结构化结果（操作返回的 data）。 */
  data?: unknown;
  /** 失败原因。 */
  error?: string;
  /** 参数不对（而不是操作本身失败）。 */
  param_error?: boolean;
  exit_code: number;
}

/** 从执行进程的完整输出里拆出文字与结果。 */
export function parseWorkerOutput(output: string): { text: string; result: WorkerResult | null } {
  const at = output.lastIndexOf(ResultMarker);
  if (at < 0) return { text: output, result: null };
  const line = output.slice(at + ResultMarker.length).split('\n')[0] ?? '';
  try {
    return { text: output.slice(0, at), result: JSON.parse(line) as WorkerResult };
  } catch {
    return { text: output, result: null };
  }
}

/** 流式输出里去掉结果行，只留给人看的文字（实时转发时用）。 */
export function visibleText(chunk: string): string {
  const at = chunk.indexOf(ResultMarker);
  return at < 0 ? chunk : chunk.slice(0, at);
}

/** 执行进程的命令行参数。 */
export function workerArgs(name: string, params: Record<string, unknown>): string[] {
  return [WorkerArg, name, JSON.stringify(params)];
}
