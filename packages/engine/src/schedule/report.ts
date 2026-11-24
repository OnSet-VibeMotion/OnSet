import { atomicWrite } from '../fsutil';
import { formatFixed } from '../gofmt';
import { compareBytes, marshalIndent } from '../gojson';
import { formatUsage, newUsage, type Usage, usageAdd, usageEmpty, usageJSON } from '../tools';

export type Status = 'succeeded' | 'skipped' | 'stale' | 'failed';

export const Succeeded: Status = 'succeeded';
export const Skipped: Status = 'skipped';
export const Stale: Status = 'stale';
export const Failed: Status = 'failed';

export interface SceneResult {
  scene_id: string;
  status: Status;
  attempts: number;
  seconds: number;
  reason: string;
  /** 这个镜头在这一批里全部尝试（含重试）的用量合计；跳过的镜头没有（null）。 */
  usage: Usage | null;
}

export interface Report {
  schema_version: number;
  seconds: number;
  interrupted: boolean;
  exit_code: number;
  /** Go 的 map[Status]int：写出时按键排序。 */
  counts: Record<Status, number>;
  /** null 对应 Go 的 nil 切片（零值报告）；runAll 给出的总是数组。 */
  scenes: SceneResult[] | null;
  /** 这一批全部渲染的用量合计；null 表示没有。 */
  usage: Usage | null;
  /** 未登记组件的镜头留给下一批，不占 worker。 */
  component_waiting?: { scene_id: string; components: { name: string; source_scene: string }[] }[];
}

/** runAll 给出的报告：scenes 总是数组（按时间轴顺序）。 */
export interface RunReport extends Report {
  scenes: SceneResult[];
}

export function newSceneResult(fields: Partial<SceneResult> = {}): SceneResult {
  return { scene_id: '', status: Failed, attempts: 0, seconds: 0, reason: '', usage: null, ...fields };
}

export function emptyCounts(): Record<Status, number> {
  return { succeeded: 0, skipped: 0, stale: 0, failed: 0 };
}

export function newReport(fields: Partial<Report> = {}): Report {
  return {
    schema_version: 0,
    seconds: 0,
    interrupted: false,
    exit_code: 0,
    counts: emptyCounts(),
    scenes: null,
    usage: null,
    ...fields,
  };
}

/** 把各镜头的用量填进报告并算出合计。由调用方收集（调度层不读输出流）。原地修改 r。 */
export function attachUsage(r: Report, byScene: ReadonlyMap<string, Usage> | Record<string, Usage>): void {
  const map: ReadonlyMap<string, Usage> = byScene instanceof Map ? byScene : new Map(Object.entries(byScene));
  const total = newUsage();
  for (const result of r.scenes ?? []) {
    const usage = map.get(result.scene_id);
    if (usage === undefined) continue;
    result.usage = { ...usage };
    usageAdd(total, usage);
  }
  if (!usageEmpty(total) || map.size > 0) r.usage = total;
}

export function reportExitCode(r: Report): number {
  if (r.interrupted) return 130;
  if ((r.counts.failed ?? 0) > 0) return 1;
  return 0;
}

function countsJSON(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(counts).sort(compareBytes)) out[key] = counts[key];
  return out;
}

/** 按 Go struct 的字段顺序排出可交给 gojson 的对象。 */
export function reportToJSON(r: Report): unknown {
  return {
    schema_version: r.schema_version,
    seconds: r.seconds,
    interrupted: r.interrupted,
    exit_code: r.exit_code,
    counts: r.counts === null || r.counts === undefined ? null : countsJSON(r.counts),
    scenes: r.scenes === null || r.scenes === undefined ? null : r.scenes.map(sceneResultToJSON),
    usage: r.usage ? usageJSON(r.usage) : undefined,
    component_waiting: r.component_waiting,
  };
}

export function sceneResultToJSON(s: SceneResult): unknown {
  return {
    scene_id: s.scene_id,
    status: s.status,
    attempts: s.attempts,
    seconds: s.seconds,
    reason: s.reason,
    usage: s.usage ? usageJSON(s.usage) : undefined,
  };
}

export function writeReportJSON(r: Report, file: string): void {
  atomicWrite(file, marshalIndent(reportToJSON(r)) + '\n', 0o644);
}

export function renderReport(r: Report): string {
  const c = r.counts;
  const text = `镜头汇总（${(r.scenes ?? []).length} 个）\n  成功 ${c.succeeded ?? 0}  跳过 ${c.skipped ?? 0}  过期 ${c.stale ?? 0}  失败 ${c.failed ?? 0}\n\n耗时 ${formatFixed(r.seconds, 1)} 秒`;
  if (r.usage === null || r.usage === undefined) return text;
  const lines: string[] = [];
  for (const s of r.scenes ?? []) {
    if (s.usage !== null && s.usage !== undefined) lines.push(`  ${s.scene_id}：${formatUsage(s.usage)}`);
  }
  return text + '\n用量合计：' + formatUsage(r.usage) + '\n' + lines.join('\n');
}

/** 不算尝试的结果（跳过、过期）：RunAll 记下状态并且不重试。 */
export class OutcomeError extends Error {
  readonly status: Status;
  readonly reason: string;
  constructor(status: Status, reason: string) {
    super(reason);
    this.name = 'OutcomeError';
    this.status = status;
    this.reason = reason;
  }
}

export function outcome(status: Status, reason: string): OutcomeError {
  return new OutcomeError(status, reason);
}

/** 标记「重试也不会变的失败」。 */
export class FatalError extends Error {
  readonly err: unknown;
  constructor(err: unknown) {
    super(errorMessage(err), { cause: err });
    this.name = 'FatalError';
    this.err = err;
  }
}

/**
 * 把错误标记为不可重试，runAll 遇到它立刻停止本镜头的重试循环。
 *
 * 存在的理由：产物规格校验失败是确定性的——同样的提示词和同样的渲染器，
 * 重跑只会得到同样不合规的产物。而每次重试都是一次完整的 AI CLI 调用，
 * 代价以分钟和 token 计。下发给用户的 PROMPT 里也是这么承诺的：
 * 「产物校验失败不会重试——那通常意味着提示词或时长声明有问题」。
 *
 * err 为 null / undefined 时返回 null（Go 的 Fatal(nil) == nil）。
 */
export function fatal(err: unknown): FatalError | null {
  if (err === null || err === undefined) return null;
  return new FatalError(err);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** errors.As：沿 cause 链找指定类型的错误。 */
export function asError<T>(err: unknown, type: new (...args: never[]) => T): T | null {
  let current: unknown = err;
  for (let depth = 0; current !== null && current !== undefined && depth < 100; depth++) {
    if (current instanceof type) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}
