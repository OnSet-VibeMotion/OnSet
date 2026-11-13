// 移植自 internal/memory/report.go。
import { compareBytes, sortedKeys } from '../gojson';
import { OutcomeInterrupted } from '../scene';
import { usageNormalized } from '../tools';
import { firstTry, SourceCheck, SourceRender, type Episode } from './episode';
import { checkFailures, effectivelyPassed, statKey } from './stats';

/** 一组镜头尝试的指标。 */
export interface RunStats {
  /** 这一批渲染的镜头数（按首次尝试计）。 */
  scenes: number;
  /** 首次尝试就通过全部硬校验、事后检查也没查出问题的镜头数。 */
  passed_first_try: number;
  pass_rate: number;
  retries: number;
  /** 首次尝试的失败项总数加事后检查查出的问题数。 */
  problems: number;
  /** 其中事后检查（阅读时间、交接、空白帧）查出的部分。 */
  check_problems: number;
  seconds: number;
  input_tokens: number;
  output_tokens: number;
  /** 平均每个镜头召回的记忆条数。 */
  recalled: number;
  /** 这一批用到的记忆快照号。 */
  snapshots: number[];
  /** 做了记忆探索的镜头数，explored_passed 是其中一次通过的。 */
  explored: number;
  explored_passed: number;
}

/**
 * 一次 am scene run / run-all 调用（一个批次）的汇总。
 *
 * 「第二次比第一次好」要能被机器量出来：一次通过率、重试次数、失败项数、耗时与
 * token 都按批次汇总，并按「渲染工具/模型」分开——混在一起的话，换了渲染工具
 * 带来的变化会被算成记忆的功劳。
 */
export interface RunSummary extends RunStats {
  run: string;
  started_at: string;
  project: string;
  /** 按「渲染工具/模型」分开的同一组指标。 */
  by_model: Record<string, RunStats>;
}

function runStatsFields(s: RunStats): Record<string, unknown> {
  return {
    scenes: s.scenes,
    passed_first_try: s.passed_first_try,
    pass_rate: s.pass_rate,
    retries: s.retries,
    problems: s.problems,
    check_problems: s.check_problems,
    seconds: s.seconds,
    input_tokens: s.input_tokens,
    output_tokens: s.output_tokens,
    recalled: s.recalled,
    snapshots: s.snapshots,
    explored: s.explored,
    explored_passed: s.explored_passed,
  };
}

export function runStatsToJSON(s: RunStats): Record<string, unknown> {
  return runStatsFields(s);
}

export function runSummaryToJSON(s: RunSummary): Record<string, unknown> {
  const byModel: Record<string, unknown> = {};
  for (const [key, stats] of Object.entries(s.by_model)) byModel[key] = runStatsFields(stats);
  return {
    run: s.run,
    started_at: s.started_at,
    project: s.project || undefined,
    ...runStatsFields(s),
    by_model: sortedKeys(byModel),
  };
}

function zeroStats(): RunStats {
  return {
    scenes: 0,
    passed_first_try: 0,
    pass_rate: 0,
    retries: 0,
    problems: 0,
    check_problems: 0,
    seconds: 0,
    input_tokens: 0,
    output_tokens: 0,
    recalled: 0,
    snapshots: [],
    explored: 0,
    explored_passed: 0,
  };
}

class RunAccumulator {
  stats = zeroStats();
  private recalled = 0;
  private snaps = new Set<number>();

  add(e: Episode, failed: Set<string>): void {
    if (e.usage !== null) {
      const usage = usageNormalized(e.usage);
      this.stats.input_tokens += usage.input_tokens ?? 0;
      this.stats.output_tokens += usage.output_tokens ?? 0;
    }
    this.stats.seconds += e.seconds;
    if (!firstTry(e)) {
      this.stats.retries++;
      return;
    }
    this.stats.scenes++;
    this.recalled += e.recalled?.length ?? 0;
    this.snaps.add(e.snapshot);
    const ok = effectivelyPassed(e, failed);
    if (ok) this.stats.passed_first_try++;
    if (e.explored !== null) {
      this.stats.explored++;
      if (ok) this.stats.explored_passed++;
    }
    this.stats.problems += e.problems?.length ?? 0;
  }

  finish(): RunStats {
    const stats = { ...this.stats };
    if (stats.scenes > 0) {
      stats.pass_rate = stats.passed_first_try / stats.scenes;
      stats.recalled = this.recalled / stats.scenes;
    }
    stats.snapshots = [...this.snaps].sort((a, b) => a - b);
    return stats;
  }
}

/**
 * 按批次汇总正式渲染的经历，按开始时间升序。
 * 没有批次编号的经历（引入批次之前的、导入的）不进报告。
 */
export function runReport(episodes: readonly Episode[]): RunSummary[] {
  const failed = checkFailures(episodes);
  interface Group {
    run: string;
    startedAt: string;
    project: string;
    total: RunAccumulator;
    models: Map<string, RunAccumulator>;
  }
  const groups = new Map<string, Group>();
  const order: string[] = [];
  for (const e of episodes) {
    if (e.source !== SourceRender || e.run === '' || e.outcome === OutcomeInterrupted) continue;
    let g = groups.get(e.run);
    if (!g) {
      g = { run: e.run, startedAt: e.created_at, project: e.project, total: new RunAccumulator(), models: new Map() };
      groups.set(e.run, g);
      order.push(e.run);
    }
    if (compareBytes(e.created_at, g.startedAt) < 0) g.startedAt = e.created_at;
    const key = statKey(e.renderer, e.model);
    if (!g.models.has(key)) g.models.set(key, new RunAccumulator());
    g.total.add(e, failed);
    g.models.get(key)!.add(e, failed);
  }
  // 事后检查查出的问题记到出问题的那一批上（检查经历继承了渲染的批次编号）。
  for (const e of episodes) {
    const g = groups.get(e.run);
    if (e.source !== SourceCheck || !g) continue;
    const n = e.problems?.length ?? 0;
    g.total.stats.problems += n;
    g.total.stats.check_problems += n;
    const m = g.models.get(statKey(e.renderer, e.model));
    if (m) {
      m.stats.problems += n;
      m.stats.check_problems += n;
    }
  }
  const out: RunSummary[] = order.map((run) => {
    const g = groups.get(run)!;
    const byModel: Record<string, RunStats> = {};
    for (const [key, acc] of g.models) byModel[key] = acc.finish();
    return { run: g.run, started_at: g.startedAt, project: g.project, ...g.total.finish(), by_model: byModel };
  });
  return out
    .map((summary, index) => ({ summary, index }))
    .sort((a, b) => {
      const c = compareBytes(a.summary.started_at, b.summary.started_at);
      return c !== 0 ? c : a.index - b.index;
    })
    .map(({ summary }) => summary);
}
