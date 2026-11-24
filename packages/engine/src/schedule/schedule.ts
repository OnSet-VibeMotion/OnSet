import path from 'node:path';
import type { Scene } from '../scene';
import * as scene from '../scene';
import { dispatchOrder } from './plan';
import {
  asError,
  emptyCounts,
  errorMessage,
  Failed,
  FatalError,
  newReport,
  newSceneResult,
  OutcomeError,
  type RunReport,
  reportExitCode,
  type SceneResult,
  type Status,
  Succeeded,
} from './report';

export {
  chromeMemoryBytes,
  coverageProblems,
  dispatchOrder,
  plan,
  renderWorkers,
  sceneDirs,
  startOffsets,
  systemMemory,
} from './plan';
export {
  attachUsage,
  emptyCounts,
  Failed,
  FatalError,
  fatal,
  newReport,
  newSceneResult,
  OutcomeError,
  outcome,
  type Report,
  type RunReport,
  renderReport,
  reportExitCode,
  reportToJSON,
  type SceneResult,
  Skipped,
  Stale,
  type Status,
  Succeeded,
  sceneResultToJSON,
  writeReportJSON,
} from './report';

/**
 * 渲染一个镜头。Go 版返回 error，这里抛出（或返回被拒绝的 Promise）即表示失败；
 * 用 outcome() / fatal() 包装的错误按各自的语义处理。signal 对应 Go 的 ctx。
 */
export type Runner = (signal: AbortSignal, s: Scene) => Promise<void>;

/** 两次重试之间的等待时间（毫秒），与下发 PROMPT 里写的「退避 10 秒与 30 秒」一致。重试次数超过表长时沿用最后一项。 */
let retryBackoff: number[] = [10_000, 30_000];

/** 读出当前的退避表（毫秒）。 */
export function getRetryBackoff(): number[] {
  return [...retryBackoff];
}

/** 替换退避表（毫秒），返回原来的，供测试还原。 */
export function setRetryBackoff(next: number[]): number[] {
  const previous = retryBackoff;
  retryBackoff = [...next];
  return previous;
}

export type WaitFunc = (signal: AbortSignal, ms: number) => Promise<void>;

/**
 * 默认的等待实现：计时器到点或 signal 取消，先到者返回。
 * 取消后不再坐等剩下的退避（最长 30 秒）。
 */
const defaultWait: WaitFunc = (signal, ms) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

let waitFunc: WaitFunc = defaultWait;

/** 替换等待实现，返回原来的，供测试换成不真等待的版本。 */
export function setWaitFunc(next: WaitFunc): WaitFunc {
  const previous = waitFunc;
  waitFunc = next;
  return previous;
}

/** 在第 attempt 次尝试失败后退避，signal 取消时立即返回。 */
async function waitBeforeRetry(signal: AbortSignal, attempt: number): Promise<void> {
  if (retryBackoff.length === 0) return;
  const index = Math.min(Math.max(attempt - 1, 0), retryBackoff.length - 1);
  await waitFunc(signal, retryBackoff[index]);
}

/**
 * 描述上一次失败，供下一次渲染的提示词引用。
 * 日志位置写成相对镜头目录的路径：渲染器被锁在镜头目录内工作。
 */
export function retryNote(s: Pick<Scene, 'directory'>, reason: string, archived: string): string {
  if (archived === '') return `- 失败原因：${reason}`;
  const relative = path.relative(s.directory, archived) || '.';
  return `- 失败原因：${reason}\n- 上一次的输出流与错误日志已归档到 ${relative.split(path.sep).join('/')}/，先读它们的末尾定位问题。`;
}

function seconds(begin: number): number {
  return (performance.now() - begin) / 1000;
}

/**
 * 以 jobs 个并发 worker 渲染全部镜头，失败的按 retries 次重试。
 * 报告按传入的时间轴顺序输出；signal 取消后不再派发新镜头，返回已完成部分的报告（interrupted）。
 */
export interface QueueEvent {
  kind: 'started' | 'finished';
  scene_id: string;
  worker: number;
  elapsed_seconds: number;
  active: number;
  pending: number;
  slot_idle_ms: number;
  status?: Status;
}

export interface RunOptions {
  priority?: readonly string[];
  onEvent?: (event: QueueEvent) => void;
  unstarted?: ReadonlyMap<string, SceneResult>;
}

export async function runAll(
  signal: AbortSignal,
  scenes: readonly Scene[],
  jobs: number,
  retries: number,
  runner: Runner,
  options: RunOptions = {},
): Promise<RunReport> {
  const started = performance.now();
  if (jobs < 1) jobs = 1;
  const byID = new Map(options.unstarted);
  const ranked = dispatchOrder(scenes.filter((s) => !byID.has(s.id)));
  const priority = new Map((options.priority ?? []).map((id, index) => [id, index]));
  const queue = priority.size
    ? ranked.sort((a, b) => {
        const first = priority.get(a.id);
        const second = priority.get(b.id);
        if (first === undefined) return second === undefined ? 0 : 1;
        return second === undefined ? -1 : first - second;
      })
    : ranked;
  // 监控输出失败不能使 Promise.all 提前返回、留下仍在写文件的 worker。
  const notify = (event: QueueEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      /* 调用方负责报告监控故障。 */
    }
  };
  let next = 0;
  let active = 0;

  const runOne = async (s: Scene): Promise<SceneResult> => {
    const result = newSceneResult({ scene_id: s.id, status: Failed });
    let current = s;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      result.attempts = attempt;
      let err: unknown = null;
      let failed = false;
      try {
        await runner(signal, current);
      } catch (e) {
        failed = true;
        err = e;
      }
      if (!failed) {
        result.status = Succeeded;
        result.reason = '';
        break;
      }
      const out = asError(err, OutcomeError);
      if (out) {
        result.status = out.status;
        result.reason = out.reason;
        result.attempts = 0;
        break;
      }
      result.reason = errorMessage(err);
      // 确定性失败：重跑只会得到同样的结果，而每次重试都是一次
      // 完整的 AI CLI 调用。状态和实际尝试次数照常保留。
      if (asError(err, FatalError)) break;
      if (signal.aborted) break;
      if (attempt <= retries) {
        const archived = scene.archiveAttempt(s);
        current = scene.withRetryNote(s, retryNote(s, result.reason, archived));
        await waitBeforeRetry(signal, attempt);
      }
    }
    return result;
  };

  const worker = async (workerIndex: number) => {
    let available = performance.now();
    while (next < queue.length && !signal.aborted) {
      const s = queue[next++];
      const begin = performance.now();
      active++;
      notify({
        kind: 'started',
        scene_id: s.id,
        worker: workerIndex,
        elapsed_seconds: seconds(started),
        active,
        pending: queue.length - next,
        slot_idle_ms: begin - available,
      });
      const result = await runOne(s);
      result.seconds = seconds(begin);
      byID.set(result.scene_id, result);
      active--;
      available = performance.now();
      notify({
        kind: 'finished',
        scene_id: s.id,
        worker: workerIndex,
        elapsed_seconds: seconds(started),
        active,
        pending: queue.length - next,
        slot_idle_ms: 0,
        status: result.status,
      });
    }
  };
  await Promise.all(Array.from({ length: jobs }, (_, index) => worker(index)));

  const ordered: SceneResult[] = [];
  const counts = emptyCounts();
  for (const s of scenes) {
    const result = byID.get(s.id);
    if (result) {
      ordered.push(result);
      counts[result.status] = (counts[result.status] ?? 0) + 1;
    }
  }
  const report: RunReport = {
    ...newReport({ schema_version: 1, seconds: seconds(started), interrupted: signal.aborted, counts }),
    scenes: ordered,
  };
  report.exit_code = reportExitCode(report);
  return report;
}
