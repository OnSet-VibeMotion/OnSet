import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { formatFixed, goPathError } from '../gofmt';
import { compareBytes, marshalIndent } from '../gojson';
import * as scene from '../scene';
import type { Scene } from '../scene';
import { formatUsage, newUsage, usageAdd, usageEmpty, usageJSON, type Usage } from '../tools';

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
  return { schema_version: 0, seconds: 0, interrupted: false, exit_code: 0, counts: emptyCounts(), scenes: null, usage: null, ...fields };
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
    counts: r.counts == null ? null : countsJSON(r.counts),
    scenes: r.scenes == null ? null : r.scenes.map(sceneResultToJSON),
    usage: r.usage ? usageJSON(r.usage) : undefined,
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
  if (r.usage == null) return text;
  const lines: string[] = [];
  for (const s of r.scenes ?? []) {
    if (s.usage != null) lines.push(`  ${s.scene_id}：${formatUsage(s.usage)}`);
  }
  return text + '\n用量合计：' + formatUsage(r.usage) + '\n' + lines.join('\n');
}

/**
 * 列出 root 下所有含 scene.json 的子目录，按目录名升序返回——
 * 这个顺序就是镜头在时间轴上的先后顺序。
 *
 * 单抽出来的理由与 startOffsets 相同：am dialogue beats 不能走 plan
 * （plan 里的 scene.load 会因为过期的 cast.beats 越界而拒绝加载，而那正是
 * 该命令要修的东西），但它必须与 plan 用同一套顺序，否则镜头起点的累加
 * 就有了第二条路径。顺序规则放这里，两边共用；各自要读什么字段各自决定。
 */
export function sceneDirs(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(`无法读取镜头目录：${goPathError('open', root, err)}`, { cause: err });
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      fs.statSync(path.join(dir, 'scene.json'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
    }
    dirs.push(dir);
  }
  return dirs.sort((a, b) => compareBytes(path.basename(a), path.basename(b)));
}

export function plan(root: string): Scene[] {
  return sceneDirs(root).map((dir) => scene.load(dir));
}

/**
 * 给出每个镜头在项目全局时间轴上的起点：镜头首尾相接，
 * 第 i 个镜头的起点是它前面所有镜头 duration_seconds 之和。返回的数组与
 * 传入的 scenes 一一对应，顺序即 plan 给出的顺序。
 *
 * 单抽成一个函数是因为这条累加规则有两个方向的使用者：am dialogue beats
 * 用它把 dialogue.json 的全局台词切成镜头本地节拍，am validate cast 用它把
 * 镜头本地节拍换算回全局时间做覆盖比对。两处各写一遍 cursor += duration
 * 就是两个基准，正反向一旦漂开，校验通过与否取决于哪一边算错，而不取决
 * 于产物对不对。
 */
export function startOffsets(scenes: readonly Pick<Scene, 'duration_seconds'>[] | null): number[] {
  const list = scenes ?? [];
  const offsets: number[] = new Array(list.length);
  let cursor = 0;
  list.forEach((s, i) => {
    offsets[i] = cursor;
    cursor += s.duration_seconds;
  });
  return offsets;
}

/**
 * 检查一组镜头是否构成一条完整、不重不漏的时间轴。
 *
 * 这条规则本来只写在 PROMPT 里，靠编排 agent 自己复核：
 * 「所有镜头 scene.json 中 duration_seconds 之和应等于最后一条字幕结束时间
 * 减第一条字幕开始时间，误差不超过 0.1 秒」。规则是纯可判定的，却没有任何
 * 机器检查——漏掉一镜或某镜时长写错，要等全部渲染完拼接时才发现，
 * 而那时每一镜都已经烧掉一次完整的 AI CLI 调用。
 *
 * srtSpan 传 0 表示不比对字幕跨度，只检查镜头集合自身（编号唯一、时长有效）。
 */
export function coverageProblems(
  scenes: readonly Pick<Scene, 'id' | 'directory' | 'duration_seconds'>[] | null,
  srtSpan: number,
  tolerance: number,
): string[] {
  const problems: string[] = [];
  if (!scenes || scenes.length === 0) {
    problems.push('没有找到任何镜头');
    return problems;
  }
  const seen = new Map<string, string>();
  let total = 0;
  for (const s of scenes) {
    const previous = seen.get(s.id);
    if (previous !== undefined) {
      problems.push(`镜头编号重复：${s.id} 同时出现在 ${goBase(previous)} 和 ${goBase(s.directory)}`);
      continue;
    }
    seen.set(s.id, s.directory);
    total += s.duration_seconds;
  }
  if (srtSpan > 0 && Math.abs(total - srtSpan) > tolerance) {
    problems.push(
      `镜头总时长与字幕跨度不符：镜头合计 ${formatFixed(total, 3)} 秒，字幕跨度 ${formatFixed(srtSpan, 3)} 秒，相差 ${formatFixed(Math.abs(total - srtSpan), 3)} 秒（容差 ${formatFixed(tolerance, 3)}）`,
    );
  }
  return problems;
}

/** filepath.Base：空串得 "."，去掉末尾的分隔符。 */
function goBase(p: string): string {
  if (p === '') return '.';
  const trimmed = p.replace(/\/+$/, '');
  if (trimmed === '') return '/';
  return path.basename(trimmed);
}

/**
 * 渲染一个镜头。Go 版返回 error，这里抛出（或返回被拒绝的 Promise）即表示失败；
 * 用 outcome() / fatal() 包装的错误按各自的语义处理。signal 对应 Go 的 ctx。
 */
export type Runner = (signal: AbortSignal, s: Scene) => Promise<void>;

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
  if (err == null) return null;
  return new FatalError(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** errors.As：沿 cause 链找指定类型的错误。 */
function asError<T>(err: unknown, type: new (...args: never[]) => T): T | null {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 100; depth++) {
    if (current instanceof type) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

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

/**
 * 返回派发顺序：时长长的镜头先派发，时长相同时保持时间轴顺序。
 *
 * 镜头之间没有依赖，总耗时由最后完成的那个 worker 决定。按时间轴顺序派发时，
 * 排在末尾的长镜头会在其他 worker 都空闲后才开始，独自拖长整批耗时；先派发
 * 长镜头（LPT）让短镜头去填后面的空隙。渲染耗时与帧数大致成正比，时长是
 * 手头最好的估计。报告仍按时间轴顺序输出，与派发顺序无关。
 */
export function dispatchOrder<T extends Pick<Scene, 'duration_seconds'>>(scenes: readonly T[]): T[] {
  // Array.prototype.sort 是稳定排序，对应 sort.SliceStable。
  return [...scenes].sort((a, b) => (a.duration_seconds > b.duration_seconds ? -1 : a.duration_seconds < b.duration_seconds ? 1 : 0));
}

/** 单个帧捕获 Chrome 的内存估算，取 HyperFrames auto 的同一口径。 */
export const chromeMemoryBytes = 1536 * 2 ** 20;

/**
 * 给出每个镜头渲染可用的帧捕获 worker 数。
 *
 * HyperFrames 的 --workers auto 为单次渲染独占整机设计（0.8.14 源码）：worker
 * 数取「核数 - 2」「一半系统内存 / 1.5GB」「帧数 / 30」与上限
 * max(6, min(16, 核数/8)) 中的最小值。0.8.225 核对过这几项没变，只多了一道
 * 按 V8 堆大小的上限，只会让 auto 更少，不影响这里的均分。jobs 个镜头同时渲染时这些估算互不知情，
 * 每个都按独占 CPU 和一半内存算，合起来会超订。按 (核数 - 2) / jobs 均分，留两个核
 * 给编码与系统；内存同样按上游的口径（一半内存、每个 Chrome 1.5GB）均分——只分 CPU
 * 的话，16GB 的机器上三个镜头各开 4 个 Chrome 就开始换页，整批一起变慢。
 * memoryBytes 为 0 表示读不到内存大小，只按 CPU 分。jobs 为 1 时返回 0，表示沿用上游的 auto。
 */
export function renderWorkers(cpus: number, memoryBytes: number, jobs: number): number {
  if (jobs <= 1) return 0;
  let workers = Math.trunc((cpus - 2) / jobs);
  if (memoryBytes > 0) {
    workers = Math.min(workers, Math.trunc(Math.floor(memoryBytes / 2 / chromeMemoryBytes) / jobs));
  }
  return Math.max(1, workers);
}

/**
 * 返回物理内存字节数，读不到时返回 0。
 * Go 版在 darwin 读 sysctl hw.memsize、在 linux 读 /proc/meminfo 的 MemTotal，其余平台返回 0；
 * Node 的 os.totalmem() 在这两个平台上取的是同一个值。
 */
export function systemMemory(): number {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return 0;
  try {
    return os.totalmem();
  } catch {
    return 0;
  }
}

function seconds(begin: number): number {
  return (performance.now() - begin) / 1000;
}

/**
 * 以 jobs 个并发 worker 渲染全部镜头，失败的按 retries 次重试。
 * 报告按传入的时间轴顺序输出；signal 取消后不再派发新镜头，返回已完成部分的报告（interrupted）。
 */
export async function runAll(
  signal: AbortSignal,
  scenes: readonly Scene[],
  jobs: number,
  retries: number,
  runner: Runner,
): Promise<RunReport> {
  const started = performance.now();
  if (jobs < 1) jobs = 1;
  const queue = dispatchOrder(scenes);
  let next = 0;
  const byID = new Map<string, SceneResult>();

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

  const worker = async () => {
    while (next < queue.length && !signal.aborted) {
      const s = queue[next++];
      const begin = performance.now();
      const result = await runOne(s);
      result.seconds = seconds(begin);
      byID.set(result.scene_id, result);
    }
  };
  await Promise.all(Array.from({ length: jobs }, () => worker()));

  const ordered: SceneResult[] = [];
  const counts = emptyCounts();
  for (const s of scenes) {
    const result = byID.get(s.id);
    if (result) {
      ordered.push(result);
      counts[result.status] = (counts[result.status] ?? 0) + 1;
    }
  }
  const report: RunReport = { ...newReport({ schema_version: 1, seconds: seconds(started), interrupted: signal.aborted, counts }), scenes: ordered };
  report.exit_code = reportExitCode(report);
  return report;
}
