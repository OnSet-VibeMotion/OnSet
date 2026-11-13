import { sortedKeys } from '../gojson';
import { failure, SourceExam } from './episode';
import { EventManualEdit } from './events';
import { StatusActive, type Memory } from './memory';
import type { Retest } from './exam';
import { suspectMemories, weakMemories, type Suspect, type Weak } from './stats';
import type { Store } from './store';
import { compareBytes } from '../gojson';

/** 记忆库的现状。 */
export interface StatusReport {
  dir: string;
  snapshot: number;
  /** 按「层/状态」计数，如 lesson/active。 */
  counts: Record<string, number>;
  /** 相对最新快照被人工改动过的生效记忆；recorded_snapshot 非 0 时已记成新快照。 */
  drift: string[];
  recorded_snapshot: number;
  /** 解析失败的记忆文件及原因。 */
  broken: Record<string, string>;
  /** 待沉睡候选。 */
  weak: Weak[];
  /** 召回后它要防的错照样发生的生效经验，建议重考。 */
  suspect: Suspect[];
  /** 模型换过、需要重考的生效经验。 */
  retest: Retest[];
  episodes: number;
  pending_failures: number;
  last_consolidated: string;
}

export function statusReportToJSON(r: StatusReport): Record<string, unknown> {
  return {
    dir: r.dir,
    snapshot: r.snapshot,
    counts: sortedKeys(r.counts),
    drift: r.drift,
    recorded_snapshot: r.recorded_snapshot || undefined,
    broken: Object.keys(r.broken).length > 0 ? sortedKeys(r.broken) : undefined,
    weak: r.weak.map((w) => ({ name: w.name, renderer: w.renderer, rate: w.rate, baseline: w.baseline, recalled: w.recalled })),
    suspect: r.suspect.map((s) => ({ name: s.name, renderer: s.renderer, recalled: s.recalled, harmful: s.harmful, checks: s.checks })),
    retest: r.retest.map((t) => ({ name: t.name, renderer: t.renderer, examined_models: t.examined_models, current_model: t.current_model })),
    episodes: r.episodes,
    pending_failures: r.pending_failures,
    last_consolidated: r.last_consolidated || undefined,
  };
}

/**
 * 汇总记忆库现状。record 为 true 时，把人工编辑记成新快照
 * （标为「人工编辑，未经考试」）。currentModel 给出各渲染工具现在的模型，
 * 用来找出需要重考的经验；为 null 时不判定。
 */
export function status(s: Store, record: boolean, currentModel: ((renderer: string) => string) | null): StatusReport {
  const report: StatusReport = {
    dir: s.dir,
    snapshot: 0,
    counts: {},
    drift: [],
    recorded_snapshot: 0,
    broken: {},
    weak: [],
    suspect: [],
    retest: [],
    episodes: 0,
    pending_failures: 0,
    last_consolidated: '',
  };
  const { memories: all, broken } = s.memories();
  for (const [file, problem] of Object.entries(broken)) report.broken[file] = problem.message;
  const active: string[] = [];
  const activeMemories: Memory[] = [];
  for (const m of all) {
    const key = `${m.kind}/${m.status}`;
    report.counts[key] = (report.counts[key] ?? 0) + 1;
    if (m.status === StatusActive) {
      active.push(m.name);
      activeMemories.push(m);
    }
  }
  const drift = s.drift();
  if (drift !== null) report.drift = drift;
  if (drift !== null && drift.length > 0 && record) {
    const snapshot = s.takeSnapshot(EventManualEdit, '人工编辑，未经考试：' + drift.join('、'), true);
    report.recorded_snapshot = snapshot.id;
    s.log({
      time: '',
      type: EventManualEdit,
      snapshot: snapshot.id,
      summary: '发现人工编辑，记为快照 #' + snapshot.id + '（未经考试）',
      detail: { memories: drift },
    });
  }
  const latest = s.latestSnapshot();
  if (latest !== null) report.snapshot = latest.id;
  const episodes = s.episodes();
  report.episodes = episodes.length;
  report.last_consolidated = s.lastConsolidation();
  for (const e of episodes) {
    if (compareBytes(e.created_at, report.last_consolidated) > 0 && failure(e) && e.source !== SourceExam) report.pending_failures++;
  }
  const weak = weakMemories(episodes, active);
  if (weak !== null) report.weak = weak;
  const suspect = suspectMemories(episodes, activeMemories);
  if (suspect !== null) report.suspect = suspect;
  const retest = s.retestNeeded(currentModel);
  if (retest !== null) report.retest = retest;
  return report;
}
