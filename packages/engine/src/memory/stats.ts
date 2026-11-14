import { compareBytes, sortedKeys } from '../gojson';
import { OutcomeInterrupted } from '../scene';
import { firstTry, passed, SourceCheck, SourceRender, type Episode } from './episode';
import { KindLesson, StatusActive, type Memory } from './memory';
import type { Store } from './store';
import { contains, intersect, rendererModel } from './util';

/**
 * 一条记忆在某个「渲染工具/模型」上的效果统计。只计正式渲染的首次尝试：
 * 调度层的重试带着上一次的失败说明，不是记忆的功劳；考试是人为安排的，也不算。
 */
export interface Stat {
  recalled: number;
  passed_first_try: number;
}

/** 一次通过率；没有样本时返回 -1。 */
export function statRate(s: Stat): number {
  if (s.recalled === 0) return -1;
  return s.passed_first_try / s.recalled;
}

/** map[string]map[string]Stat 的 JSON（两层都按键排序）。 */
export function statsToJSON(stats: Record<string, Record<string, Stat>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, byKey] of Object.entries(stats)) {
    const inner: Record<string, unknown> = {};
    for (const [key, stat] of Object.entries(byKey)) inner[key] = { recalled: stat.recalled, passed_first_try: stat.passed_first_try };
    out[name] = sortedKeys(inner);
  }
  return sortedKeys(out);
}

export function countable(e: Episode): boolean {
  return e.source === SourceRender && firstTry(e) && e.outcome !== OutcomeInterrupted;
}

/**
 * 统计的键：渲染工具/模型，模型未知时只有渲染工具。
 * 同一渲染工具换了模型，犯的错可能完全不同，统计不能混在一起。
 */
export function statKey(renderer: string, model: string): string {
  return rendererModel(renderer, model);
}

function checkKey(e: Episode): string {
  return e.scene_dir + '|' + e.fingerprint;
}

/** 事后检查（阅读时间、交接、空白帧）查出问题的产物。 */
export function checkFailures(episodes: readonly Episode[]): Set<string> {
  const failed = new Set<string>();
  for (const e of episodes) {
    if (e.source === SourceCheck && e.fingerprint !== '') failed.add(checkKey(e));
  }
  return failed;
}

/** 渲染时通过了校验、事后检查又查出问题的产物不算通过。 */
export function effectivelyPassed(e: Episode, failed: Set<string>): boolean {
  return passed(e) && !(e.fingerprint !== '' && failed.has(checkKey(e)));
}

/** 由经历聚合出每条记忆按「渲染工具/模型」分开的效果统计。 */
export function computeStats(episodes: readonly Episode[]): Record<string, Record<string, Stat>> {
  const failed = checkFailures(episodes);
  const out: Record<string, Record<string, Stat>> = {};
  for (const e of episodes) {
    if (!countable(e)) continue;
    const key = statKey(e.renderer, e.model);
    for (const name of e.recalled ?? []) {
      if (!Object.hasOwn(out, name)) out[name] = {};
      const stat = out[name][key] ?? { recalled: 0, passed_first_try: 0 };
      stat.recalled++;
      if (effectivelyPassed(e, failed)) stat.passed_first_try++;
      out[name][key] = stat;
    }
  }
  return out;
}

/** 读出全部经历并聚合效果统计。 */
export function storeStats(s: Store): Record<string, Record<string, Stat>> {
  return computeStats(s.episodes());
}

/**
 * 估计一条记忆在当前渲染工具/模型上的一次通过率（拉普拉斯平滑）。
 *
 * 只用当前模型自己的样本；没有时退到同一渲染工具的其他模型，再退到全部渲染工具，
 * 这两档都向 0.5 收缩一半：别的模型上的效果只能当弱证据，模型换了就该重新攒统计。
 */
export function smoothedRate(stats: Record<string, Stat> | undefined, renderer: string, model: string): number {
  const laplace = (s: Stat) => (s.passed_first_try + 1) / (s.recalled + 2);
  const all = stats ?? {};
  const own = all[statKey(renderer, model)];
  if (own && Object.hasOwn(all, statKey(renderer, model)) && own.recalled > 0) return laplace(own);
  const sameRenderer: Stat = { recalled: 0, passed_first_try: 0 };
  const total: Stat = { recalled: 0, passed_first_try: 0 };
  // Go 遍历 map 的顺序是随机的，但这里只做整数求和，顺序不影响结果。
  for (const [key, stat] of Object.entries(all)) {
    total.recalled += stat.recalled;
    total.passed_first_try += stat.passed_first_try;
    if (key === renderer || key.startsWith(renderer + '/')) {
      sameRenderer.recalled += stat.recalled;
      sameRenderer.passed_first_try += stat.passed_first_try;
    }
  }
  const pick = sameRenderer.recalled > 0 ? sameRenderer : total;
  return 0.5 + (laplace(pick) - 0.5) / 2;
}

/** 判定一条记忆「没帮上忙」前至少要有的召回次数（设计里的 K）。 */
export const DormancyMinRecalls = 5;

/**
 * 一条在某个渲染工具/模型上没帮上忙的生效记忆：召回后的一次通过率
 * 不高于同一渲染工具/模型上没召回它时的基线。
 */
export interface Weak {
  name: string;
  renderer: string;
  rate: number;
  baseline: number;
  recalled: number;
}

/**
 * 找出待沉睡的记忆。它只给出候选，不改状态：
 * 淘汰同样要经过考试确认，或由人决定。没有候选时返回 null。
 */
export function weakMemories(episodes: readonly Episode[], active: readonly string[] | null): Weak[] | null {
  const stats = computeStats(episodes);
  const failed = checkFailures(episodes);
  const out: Weak[] = [];
  for (const name of active ?? []) {
    for (const [key, stat] of Object.entries(stats[name] ?? {})) {
      if (stat.recalled < DormancyMinRecalls) continue;
      const base: Stat = { recalled: 0, passed_first_try: 0 };
      for (const e of episodes) {
        if (countable(e) && statKey(e.renderer, e.model) === key && !contains(e.recalled, name)) {
          base.recalled++;
          if (effectivelyPassed(e, failed)) base.passed_first_try++;
        }
      }
      if (base.recalled === 0 || statRate(stat) > statRate(base)) continue;
      out.push({ name, renderer: key, rate: statRate(stat), baseline: statRate(base), recalled: stat.recalled });
    }
  }
  out.sort((a, b) => (a.name !== b.name ? compareBytes(a.name, b.name) : compareBytes(a.renderer, b.renderer)));
  return out.length > 0 ? out : null;
}

/** 判定一条生效经验「可疑」至少要有的有害次数。 */
export const SuspectMinHarm = 2;

/**
 * 一条可疑的生效经验：召回了它，它要防的那个校验器却照样判了失败。
 *
 * 「待沉睡」（Weak）看的是一次通过率有没有比基线高，要攒够样本才判得出；
 * 这里看的是更直接的负证据——经验点名要防的错，注入之后还在发生，说明它没写对，
 * 或者对这个模型不管用。做法借鉴 ExpeL 对 insight 的增减投票与 ACE 的
 * helpful/harmful 计数，但只给出候选、不自动改状态：重考或人来决定。
 */
export interface Suspect {
  name: string;
  renderer: string;
  recalled: number;
  harmful: number;
  /** 召回后仍然失败的、这条经验的 checked_by 里的校验器。 */
  checks: string[] | null;
}

/**
 * 找出可疑的生效经验，按「渲染工具/模型」分开计。
 * 有害计入正式渲染的首次尝试与事后检查：事后检查继承了那次渲染召回的记忆。
 * 没有候选时返回 null。
 */
export function suspectMemories(episodes: readonly Episode[], active: readonly Memory[] | null): Suspect[] | null {
  interface Tally {
    recalled: number;
    harmful: number;
    checks: string[] | null;
  }
  const counts = new Map<string, Map<string, Tally>>();
  const get = (name: string, key: string): Tally => {
    let byKey = counts.get(name);
    if (!byKey) counts.set(name, (byKey = new Map()));
    let t = byKey.get(key);
    if (!t) byKey.set(key, (t = { recalled: 0, harmful: 0, checks: null }));
    return t;
  };
  const lessons = new Map<string, Memory>();
  for (const m of active ?? []) {
    if (m.kind === KindLesson && m.status === StatusActive) lessons.set(m.name, m);
  }
  for (const e of episodes) {
    const render = countable(e);
    if (!render && e.source !== SourceCheck) continue;
    const key = statKey(e.renderer, e.model);
    for (const name of e.recalled ?? []) {
      const m = lessons.get(name);
      if (!m) continue;
      const t = get(name, key);
      if (render) t.recalled++;
      const hit = intersect(e.checks, m.checked_by);
      if (hit === null) continue;
      t.harmful++;
      for (const id of hit) {
        if (!contains(t.checks, id)) t.checks = [...(t.checks ?? []), id];
      }
    }
  }
  const out: Suspect[] = [];
  for (const [name, byKey] of counts) {
    for (const [key, t] of byKey) {
      if (t.harmful < SuspectMinHarm || t.harmful * 2 < t.recalled) continue;
      out.push({ name, renderer: key, recalled: t.recalled, harmful: t.harmful, checks: t.checks ? [...t.checks].sort(compareBytes) : null });
    }
  }
  out.sort((a, b) => (a.name !== b.name ? compareBytes(a.name, b.name) : compareBytes(a.renderer, b.renderer)));
  return out.length > 0 ? out : null;
}
