import fs from 'node:fs';
import path from 'node:path';
import { compareBytes, sortedKeys } from '../gojson';
import { loadRecord, load as loadScene } from '../scene';
import { preferenceSignals, type Signal, signalToJSON } from './conversation';
import { type Episode, failure, SourceConversation, SourceExam, SourceFeedback, SourceRender } from './episode_schema';
import { walkDir } from './io';
import { checkFailures, effectivelyPassed } from './stats';
import { contains, intersect, omitEmpty, rendererModel, uniqueSorted } from './util';

/** 一组同类失败：同一个校验器（或人工 👎）下的经历。 */
export interface Cluster {
  key: string;
  count: number;
  episodes: string[] | null;
  renderers: Record<string, number>;
  /**
   * 按「渲染工具/模型」计数，模型未知时只写渲染工具。整理者据此判断
   * 这类失败是通病，还是某个模型特有的毛病。
   */
  models: Record<string, number>;
  /** 这组经历里至少一半都带的镜头特征。 */
  features: string[] | null;
  examples: string[] | null;
  notes: string[] | null;
  /** 这组经历失败时已经召回的记忆：它们没帮上忙，可能要修订。 */
  recalled: string[] | null;
  /** 只对人工组（ClusterKeyHuman）有值：回退、反复提的要求与带说明的 👍 / 👎。 */
  signals: Signal[] | null;
  /** 成败对照：这组里的一次失败，配上一次没犯这个错的通过渲染。 */
  contrasts: Contrast[] | null;
}

function newCluster(key: string): Cluster {
  return {
    key,
    count: 0,
    episodes: null,
    renderers: {},
    models: {},
    features: null,
    examples: null,
    notes: null,
    recalled: null,
    signals: null,
    contrasts: null,
  };
}

/**
 * 一组成败对照。
 *
 * 只看失败，整理者只能猜「怎样才对」；ExpeL、ReasoningBank 都从成败对比里提炼经验。
 * 最好的对照是同一个镜头后来改对了（same_scene），其次是同一渲染工具、特征最接近的
 * 另一个通过的镜头。
 */
export interface Contrast {
  failed: string;
  failed_dir: string;
  passed: string;
  passed_dir: string;
  /**
   * 通过那次的输入指纹：镜头目录里 .onset-render.json 的指纹与它相同时，
   * 目录里的合成代码就是那次通过的版本。
   */
  passed_fingerprint: string;
  same_scene: boolean;
  shared_features: string[] | null;
  /**
   * 整理工作目录里通过那一版合成代码的副本（相对工作目录）；镜头目录里的
   * 代码已被后来的渲染覆盖、或读不到时为空。整理者可能只被允许读工作目录，所以要拷进来。
   */
  passed_code: string;
}

export function contrastToJSON(c: Contrast): Record<string, unknown> {
  return {
    failed: c.failed,
    failed_dir: c.failed_dir,
    passed: c.passed,
    passed_dir: c.passed_dir,
    passed_fingerprint: c.passed_fingerprint || undefined,
    same_scene: c.same_scene || undefined,
    shared_features: omitEmpty(c.shared_features),
    passed_code: c.passed_code || undefined,
  };
}

export function clusterToJSON(c: Cluster): Record<string, unknown> {
  return {
    key: c.key,
    count: c.count,
    episodes: c.episodes,
    renderers: sortedKeys(c.renderers),
    models: sortedKeys(c.models),
    features: omitEmpty(c.features),
    examples: omitEmpty(c.examples),
    notes: omitEmpty(c.notes),
    recalled: omitEmpty(c.recalled),
    signals: c.signals && c.signals.length > 0 ? c.signals.map(signalToJSON) : undefined,
    contrasts: c.contrasts && c.contrasts.length > 0 ? c.contrasts.map(contrastToJSON) : undefined,
  };
}

/** 每组最多附上的成败对照数。 */
export const MaxContrasts = 2;

/** 人工 👎 的聚类键。 */
export const ClusterKeyHuman = 'human';

/**
 * 把失败经历按校验器聚类，按出现次数降序；人的反应（回退、
 * 反复提的要求、带说明的 👍 / 👎）汇成一组 ClusterKeyHuman。
 * 一段经历命中几个校验器就进几组：一次渲染常常同时犯几类错。
 */
export function clusterFailures(episodes: readonly Episode[]): Cluster[] {
  return clusterSince(episodes, episodes, '');
}

/**
 * 用 fresh 聚类校验失败；偏好信号要看全部历史才认得出「反复」，
 * 但只保留含有 since 之后新经历的信号，已经整理过的不再交给整理者。
 */
export function clusterSince(fresh: readonly Episode[], all: readonly Episode[], since: string): Cluster[] {
  const groups = new Map<string, Cluster>();
  const featureCounts = new Map<string, Map<string, number>>();
  const get = (key: string): Cluster => {
    let c = groups.get(key);
    if (!c) {
      c = newCluster(key);
      groups.set(key, c);
      featureCounts.set(key, new Map());
    }
    return c;
  };
  for (const e of fresh) {
    if (!failure(e) || e.source === SourceExam || e.source === SourceFeedback || e.source === SourceConversation)
      continue;
    for (const key of uniqueSorted(e.checks) ?? []) {
      const c = get(key);
      c.count++;
      c.episodes = [...(c.episodes ?? []), e.id];
      if (e.renderer !== '') {
        c.renderers[e.renderer] = (c.renderers[e.renderer] ?? 0) + 1;
        const model = rendererModel(e.renderer, e.model);
        c.models[model] = (c.models[model] ?? 0) + 1;
      }
      const counts = featureCounts.get(key)!;
      for (const feature of e.features ?? []) counts.set(feature, (counts.get(feature) ?? 0) + 1);
      (e.checks ?? []).forEach((check, i) => {
        const problems = e.problems ?? [];
        if (
          check === key &&
          i < problems.length &&
          (c.examples?.length ?? 0) < 4 &&
          !contains(c.examples, problems[i])
        ) {
          c.examples = [...(c.examples ?? []), problems[i]];
        }
      });
      for (const name of e.recalled ?? []) {
        if (!contains(c.recalled, name)) c.recalled = [...(c.recalled ?? []), name];
      }
    }
  }
  const out: Cluster[] = [];
  for (const [key, c] of groups) {
    for (const [feature, count] of featureCounts.get(key)!) {
      if (count * 2 >= c.count) c.features = [...(c.features ?? []), feature];
    }
    c.features?.sort(compareBytes);
    c.recalled?.sort(compareBytes);
    out.push(c);
  }
  const byID = new Map<string, Episode>();
  for (const e of fresh) byID.set(e.id, e);
  const failedChecks = checkFailures(all);
  for (const c of out) {
    const pairs = contrasts(c, byID, all, failedChecks);
    c.contrasts = pairs.length > 0 ? pairs : null;
  }
  const human = humanCluster(all, since);
  if (human !== null) out.push(human);
  return out.sort((a, b) => (a.count !== b.count ? b.count - a.count : compareBytes(a.key, b.key)));
}

/**
 * 为一组失败找成败对照：通过的正式渲染、事后检查也没查出问题、
 * 没有被这个校验器判过失败。同一镜头后来通过的优先，其次同渲染工具、共同特征多的。
 * 同镜头更早的成功不能当成修复；跨镜头至少要有共同特征，同工具本身不是可比条件。
 */
function contrasts(
  c: Cluster,
  byID: Map<string, Episode>,
  all: readonly Episode[],
  failedChecks: Set<string>,
): Contrast[] {
  const out: Contrast[] = [];
  const used = new Set<string>();
  for (const id of c.episodes ?? []) {
    if (out.length >= MaxContrasts) break;
    const failed = byID.get(id);
    if (!failed) continue;
    let best: Episode | null = null;
    let bestScore = 0;
    for (const e of all) {
      if (
        e.source !== SourceRender ||
        !effectivelyPassed(e, failedChecks) ||
        used.has(e.id) ||
        contains(e.checks, c.key)
      )
        continue;
      const shared = intersect(failed.features, e.features);
      const sameScene = e.scene_dir !== '' && e.scene_dir === failed.scene_dir;
      if (sameScene && compareBytes(e.created_at, failed.created_at) <= 0) continue;
      if (!sameScene && (shared?.length ?? 0) === 0) continue;
      let score = shared?.length ?? 0;
      if (sameScene) score += 100;
      if (e.renderer === failed.renderer) score += 0.5;
      if (e.renderer === failed.renderer && e.model !== '' && e.model === failed.model) score += 0.25;
      if (score === 0) continue;
      if (
        best === null ||
        score > bestScore ||
        (score === bestScore && compareBytes(e.created_at, best.created_at) > 0)
      ) {
        best = e;
        bestScore = score;
      }
    }
    if (best === null) continue;
    used.add(best.id);
    out.push({
      failed: failed.id,
      failed_dir: failed.scene_dir,
      passed: best.id,
      passed_dir: best.scene_dir,
      passed_fingerprint: best.fingerprint,
      same_scene: best.scene_dir !== '' && best.scene_dir === failed.scene_dir,
      shared_features: intersect(failed.features, best.features),
      passed_code: '',
    });
  }
  return out;
}

// 拷进整理工作目录的合成代码：只拷文本源码，单个文件与总量都有上限。
const contrastFileLimit = 256 << 10;
const contrastTotalLimit = 1 << 20;

const contrastExtensions = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json']);

/**
 * 把每组对照里通过那一版的合成代码拷进 workdir/contrasts/。
 * 只在镜头目录现在的产物记录与那次的指纹相同时拷：否则目录里已经是别的版本。
 */
export function copyContrastCode(workdir: string, clusters: Cluster[]): void {
  let n = 0;
  for (const cluster of clusters) {
    for (const pair of cluster.contrasts ?? []) {
      if (pair.passed_dir === '' || pair.passed_fingerprint === '') continue;
      let record;
      try {
        record = loadRecord(loadScene(pair.passed_dir));
      } catch {
        continue;
      }
      if (record === null || record.fingerprint !== pair.passed_fingerprint) continue;
      n++;
      const rel = path.join('contrasts', `${String(n).padStart(2, '0')}-${pair.passed}`);
      if (copySourceTree(pair.passed_dir, path.join(workdir, rel)) > 0)
        pair.passed_code = rel.split(path.sep).join('/');
    }
  }
}

function goExtLower(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function copySourceTree(src: string, dst: string): number {
  let copied = 0;
  let total = 0;
  try {
    walkDir(src, (file, entry, isDir, err) => {
      if (err) return 'skip';
      if (isDir) {
        if (entry !== null && ['attempts', 'node_modules', '.studio-frames', '.git', 'fonts'].includes(entry.name))
          return 'skip';
        return;
      }
      if (entry === null) return;
      const name = entry.name;
      if (!contrastExtensions.has(goExtLower(name)) || name.startsWith('.') || name.endsWith('.attempt.json')) return;
      let size: number;
      try {
        size = fs.lstatSync(file).size;
      } catch {
        return;
      }
      if (size > contrastFileLimit || total + size > contrastTotalLimit) return;
      let body: Buffer;
      try {
        body = fs.readFileSync(file);
      } catch {
        return;
      }
      const target = path.join(dst, path.relative(src, file));
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body, { mode: 0o644 });
      } catch {
        return;
      }
      copied++;
      total += body.length;
    });
  } catch {
    // filepath.WalkDir 的错误被忽略。
  }
  return copied;
}

const signalLabels: Record<string, string> = {
  reverted: '回退了这一轮',
  repeated: '反复提到',
  liked: '👍',
  disliked: '👎',
};

function humanCluster(all: readonly Episode[], since: string): Cluster | null {
  const created = new Map<string, string>();
  for (const e of all) created.set(e.id, e.created_at);
  const c = newCluster(ClusterKeyHuman);
  for (const signal of preferenceSignals(all)) {
    const fresh = (signal.episodes ?? []).some((id) => compareBytes(created.get(id) ?? '', since) > 0);
    if (!fresh) continue;
    c.signals = [...(c.signals ?? []), signal];
    c.count += signal.count;
    c.episodes = [...(c.episodes ?? []), ...(signal.episodes ?? [])];
    let note = `（${signalLabels[signal.kind] ?? ''}）${signal.text}`;
    if (signal.kind === 'repeated') note = `（在 ${signal.count} 轮对话里反复提到）${signal.text}`;
    if (signal.project !== '') note += '　〔项目 ' + signal.project + '〕';
    c.notes = [...(c.notes ?? []), note];
  }
  return c.signals !== null ? c : null;
}
