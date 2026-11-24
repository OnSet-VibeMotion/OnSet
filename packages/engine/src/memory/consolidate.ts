import fs from 'node:fs';
import path from 'node:path';
import { goQuote } from '../gofmt';
import { compareBytes, sortedKeys } from '../gojson';
import { consolidationBrief, kindLabel, revisionBrief } from './consolidate_brief';
import { type Cluster, clusterSince, clusterToJSON, copyContrastCode } from './consolidate_cluster';
import { EventConsolidate, EventDraftReject, EventTrial } from './events';
import { compactStamp } from './gostr';
import { readDirSorted, writeJSON } from './io';
import { lint } from './lint';
import { type Kind, KindLesson, KindPreference, kindDir, type Memory, parse, StatusTrial } from './memory';
import type { Store } from './store';

export { consolidationBrief, contrastLine, distribution, kindLabel } from './consolidate_brief';
export {
  type Cluster,
  ClusterKeyHuman,
  type Contrast,
  clusterFailures,
  clusterToJSON,
  contrastToJSON,
  copyContrastCode,
  MaxContrasts,
} from './consolidate_cluster';

/** 上一次整理的时间（RFC3339），没有时为空。 */
export function lastConsolidation(s: Store): string {
  let last = '';
  for (const event of s.timeline()) {
    if (event.type === EventConsolidate) last = event.time;
  }
  return last;
}

/**
 * 让整理者读 workdir 里的说明，把草稿写进 workdir/drafts/。
 * 由调用方接上 ORCHESTRATOR；memory 包不关心是哪个工具。抛错表示整理者执行失败。
 */
export type Drafter = (workdir: string, prompt: string, signal?: AbortSignal) => Promise<void>;

/** 一次整理的设置。 */
export interface ConsolidateOptions {
  /** 一组失败至少出现几次才值得提炼。 */
  minCount?: number;
  /** 为 true 时不看上次整理时间，把全部经历都算进来。 */
  all?: boolean;
  /**
   * 起草经验；draftsDir 非空时不调用它，直接收录该目录下现成的草稿
   * （lessons/*.md 与 preferences/*.md）。
   */
  drafter?: Drafter | null;
  draftsDir?: string;
  signal?: AbortSignal;
}

/** 一次整理的结果。 */
export interface ConsolidateResult {
  run: string;
  workdir: string;
  clusters: Cluster[];
  accepted: string[];
  /** 草稿路径 → 不合格项。 */
  rejected: Record<string, string[]>;
}

export function consolidateResultToJSON(r: ConsolidateResult): Record<string, unknown> {
  return {
    run: r.run,
    workdir: r.workdir,
    clusters: r.clusters.map(clusterToJSON),
    accepted: r.accepted,
    rejected: sortedKeys(r.rejected),
  };
}

/**
 * 整理：失败经历聚类 → 交给整理者起草或修订 → 格式校验（被拒的交回去改一稿）→ 合格的进入试用。
 * 失败时抛出的错误带 result 属性（Go 版返回的部分结果）。
 */
export async function consolidate(s: Store, opts: ConsolidateOptions): Promise<ConsolidateResult> {
  const minCount = opts.minCount && opts.minCount >= 1 ? opts.minCount : 1;
  const episodes = s.episodes();
  const since = opts.all ? '' : lastConsolidation(s);
  const fresh = episodes.filter((e) => compareBytes(e.created_at, since) > 0);
  const clusters = clusterSince(fresh, episodes, since).filter((c) => c.count >= minCount);
  const run = 'run-' + compactStamp(s.clock());
  const result: ConsolidateResult = { run, workdir: '', clusters, accepted: [], rejected: {} };
  let drafts = opts.draftsDir ?? '';
  if (drafts === '') {
    if (clusters.length === 0) return result;
    if (!opts.drafter) throw withResult(new Error('没有配置整理者'), result);
    const workdir = path.join(s.dir, 'consolidate', run);
    for (const sub of ['drafts/lessons', 'drafts/preferences'])
      fs.mkdirSync(path.join(workdir, sub), { recursive: true });
    result.workdir = workdir;
    const existing = s.memories().memories;
    copyContrastCode(workdir, clusters);
    const brief = consolidationBrief(clusters, existing);
    fs.writeFileSync(path.join(workdir, 'brief.md'), brief, { mode: 0o644 });
    writeJSON(path.join(workdir, 'clusters.json'), clusters.map(clusterToJSON));
    try {
      await opts.drafter(workdir, brief, opts.signal);
    } catch (err) {
      throw withResult(
        new Error(`整理者执行失败：${err instanceof Error ? err.message : String(err)}`, { cause: err }),
        result,
      );
    }
    drafts = path.join(workdir, 'drafts');
  }
  const allowed = new Set<string>();
  for (const c of clusters) for (const id of c.episodes ?? []) allowed.add(id);
  // 直接收录现成草稿时没有聚类约束，来源经历只要存在即可。
  if (opts.draftsDir) for (const e of episodes) allowed.add(e.id);
  const texts = episodes.map((e) => e.text);
  ingestDrafts(s, drafts, allowed, texts, result, null);
  // 被拒的草稿带着原因交回整理者改一稿：超长、漏写字段这类问题改一下就能收，
  // 不改的话一整次整理（一次模型调用）什么都留不下。只改一轮，再不合格照实记为被拒。
  const firstRejected = Object.keys(result.rejected).sort(compareBytes);
  if (!opts.draftsDir && opts.drafter && firstRejected.length > 0) {
    const brief = revisionBrief(result.rejected);
    fs.writeFileSync(path.join(result.workdir, 'revise.md'), brief, { mode: 0o644 });
    let revised = true;
    try {
      await opts.drafter(result.workdir, brief, opts.signal);
    } catch {
      // 改稿没跑成：第一轮的结果照旧。
      revised = false;
    }
    if (revised) {
      for (const label of firstRejected) delete result.rejected[label];
      ingestDrafts(s, drafts, allowed, texts, result, new Set(firstRejected));
    }
  }
  s.log({
    time: '',
    type: EventConsolidate,
    summary: `整理：${clusters.length} 组高频失败 → ${result.accepted.length} 条进入试用，${Object.keys(result.rejected).length} 条草稿被拒`,
    detail: {
      run,
      clusters: clusters.length > 0 ? clusters.map(clusterToJSON) : null,
      accepted: result.accepted,
      rejected: sortedKeys(result.rejected),
    },
  });
  return result;
}

function withResult(err: Error, result: ConsolidateResult): Error {
  return Object.assign(err, { result });
}

/** only 非空时只收录这几份（改稿后的第二轮），其余文件第一轮已经处理过。 */
function ingestDrafts(
  s: Store,
  dir: string,
  allowedEpisodes: Set<string>,
  sceneTexts: string[],
  result: ConsolidateResult,
  only: Set<string> | null,
): void {
  for (const kind of [KindLesson, KindPreference] as Kind[]) {
    const entries = readDirSorted(path.join(dir, kindDir(kind)));
    if (entries === null) continue;
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.name.endsWith('.md')) continue;
      const label = kindDir(kind) + '/' + entry.name;
      if (only !== null && !only.has(label)) continue;
      const body = fs.readFileSync(path.join(dir, kindDir(kind), entry.name));
      let m: Memory;
      try {
        m = parse(kind, body);
      } catch (err) {
        result.rejected[label] = [err instanceof Error ? err.message : String(err)];
        continue;
      }
      m.status = StatusTrial;
      m.verified_by = [];
      m.rejected_reason = '';
      const existing = s.memories().memories;
      const problems = lint(m, { existing, sceneTexts });
      if (m.name + '.md' !== entry.name) problems.push(`name ${goQuote(m.name)} 与文件名不一致`);
      for (const other of existing) {
        if (other.name === m.name) problems.push(`记忆 ${m.name} 已存在；修订请换一个新名字并写 revises: ${m.name}`);
      }
      if (m.from_episodes.length === 0) problems.push('from_episodes 为空：经验必须说明从哪些经历来');
      for (const id of m.from_episodes) {
        if (!allowedEpisodes.has(id)) problems.push(`from_episodes 引用了不在本次整理范围内的经历：${id}`);
      }
      if (problems.length > 0) {
        result.rejected[label] = problems;
        s.log({
          time: '',
          type: EventDraftReject,
          summary: `草稿 ${label} 未通过格式校验`,
          detail: { draft: label, problems },
        });
        continue;
      }
      s.write(m);
      result.accepted.push(m.name);
      let summary = `新${kindLabel(m.kind)} ${m.name} 进入试用：${m.description}`;
      if (m.revises !== '') summary = `${m.revises} 的修订 ${m.name} 进入试用：${m.description}`;
      s.log({
        time: '',
        type: EventTrial,
        summary,
        detail: {
          memory: m.name,
          kind: m.kind,
          from_episodes: m.from_episodes.length > 0 ? m.from_episodes : null,
          revises: m.revises,
        },
      });
    }
  }
  result.accepted.sort(compareBytes);
}
