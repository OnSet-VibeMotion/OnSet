import crypto from 'node:crypto';
import { goTrimSpace } from '../gofmt';
import { compareBytes } from '../gojson';
import type { Scene } from '../scene';
import { projectOf } from './episode';
import { features as sceneFeatures, promptText } from './features';
import { goToLower, runeCount } from './gostr';
import { appliesEmpty, appliesInScope, KindLesson, KindPreference, ruleDigest, type Kind, type Memory, type Status } from './memory';
import { snapshotMemories } from './snapshot';
import { smoothedRate, type Stat } from './stats';
import type { Store } from './store';
import { contains, omitEmpty } from './util';

/** 一条被考虑的记忆及其召回理由。 */
export interface RecallItem {
  name: string;
  kind: Kind;
  status: Status;
  description: string;
  score: number;
  global: boolean;
  renderers: string[];
  models: string[];
  matched_features: string[];
  matched_keywords: string[];
  /** 排序时用的一次通过率估计（拉普拉斯平滑，无样本时为 0.5）。 */
  rate: number;
  chars: number;
  /** 这条记忆注入提示词的原文。 */
  text: string;
  /** 只对 omitted 里的条目有值：budget（字数预算用完）、limit（经验条数到顶）或 explore（被探索换下）。 */
  omit_reason: string;
  /** 规则摘要（Go 的未导出字段 digest），不进 JSON。 */
  digest: string;
}

export function recallItemToJSON(i: RecallItem): Record<string, unknown> {
  return {
    name: i.name,
    kind: i.kind,
    status: i.status,
    description: i.description,
    score: i.score,
    global: i.global || undefined,
    renderers: omitEmpty(i.renderers),
    models: omitEmpty(i.models),
    matched_features: omitEmpty(i.matched_features),
    matched_keywords: omitEmpty(i.matched_keywords),
    rate: i.rate,
    chars: i.chars,
    text: i.text,
    omit_reason: i.omit_reason || undefined,
  };
}

/** 用一句话说明为什么想起这条记忆。 */
export function recallReason(i: RecallItem): string {
  const parts: string[] = [];
  if (i.global) {
    parts.push('全局适用');
  } else {
    const matched: string[] = [];
    if (i.matched_features.length > 0) matched.push('特征 ' + i.matched_features.join('、'));
    if (i.matched_keywords.length > 0) matched.push('关键词 ' + i.matched_keywords.join('、'));
    parts.push('匹配' + matched.join('，'));
  }
  const scope = [...i.renderers, ...i.models];
  if (scope.length > 0) parts.push('专为 ' + scope.join('、'));
  return parts.join('；');
}

/**
 * 记下一次探索：把召回里排最后的经验 dropped 换成排在上限外的第一条 added。
 *
 * 召回排序用的一次通过率只统计了「当时被召回」的经验，排在上限外的经验永远攒不到
 * 样本，排序就固化了（Kiyohara et al. 2025 讨论的日志 bandit 数据偏差）。探索给它们
 * 机会，propensity 是这次换的概率，日后可以按它做反倾向加权的离线评估。
 *
 * 探索是这一次运行（agent 一次 onset scene run / run-all）的决定，不是镜头的属性：
 * 输入指纹仍用不探索时的召回，镜头不会因为探索被判 Stale，也不会因为某次探索
 * 过就以后都被判 Stale。
 */
export interface Exploration {
  dropped: string;
  added: string;
  propensity: number;
}

/** 一个镜头的召回结果。 */
export interface RecallResult {
  snapshot: number;
  renderer: string;
  model: string;
  features: string[];
  budget: number;
  used: number;
  /** 本次召回的经验条数上限。 */
  max_lessons: number;
  items: RecallItem[];
  /** 匹配上但超出字数预算或条数上限的记忆。 */
  omitted: RecallItem[];
  /** 非空表示这次召回做了探索：items 是探索后真正注入的，canonical 是不探索时的摘要，写进输入指纹。 */
  explored: Exploration | null;
  /** Go 的未导出字段，不进 JSON。 */
  canonical: string;
}

export function recallResultToJSON(r: RecallResult): Record<string, unknown> {
  return {
    snapshot: r.snapshot,
    renderer: r.renderer,
    model: r.model || undefined,
    features: r.features,
    budget: r.budget,
    used: r.used,
    max_lessons: r.max_lessons,
    items: r.items.map(recallItemToJSON),
    omitted: r.omitted.length > 0 ? r.omitted.map(recallItemToJSON) : undefined,
    explored: r.explored ? { dropped: r.explored.dropped, added: r.explored.added, propensity: r.explored.propensity } : undefined,
  };
}

/** 召回的记忆名，按注入顺序。 */
export function recallNames(r: RecallResult): string[] {
  return r.items.map((item) => item.name);
}

/**
 * 注入提示词的记忆段；没有召回时为空。
 *
 * 文本里刻意不写快照号：回退到内容相同的快照、或快照只多了与本镜头无关的
 * 记忆时，召回段逐字不变，镜头不该因此变成 Stale。
 */
export function recallSection(r: RecallResult): string {
  if (r.items.length === 0) return '';
  let b = '\n记忆（召回，来自以往渲染的经验，按本镜头特征选取；与上面的强制要求冲突时以上面为准）：\n';
  for (const item of r.items) b += item.text;
  return b;
}

/** 召回条目规则内容的摘要，写进输入指纹的 memory 项。探索过的召回返回不探索时的摘要。 */
export function recallDigest(r: RecallResult): string {
  if (r.canonical !== '') return r.canonical;
  return itemsDigest(r.items);
}

function itemsDigest(items: readonly RecallItem[]): string {
  const h = crypto.createHash('sha256');
  for (const item of items) h.update(`${item.name}=${item.digest}\n`, 'utf8');
  return h.digest('hex');
}

/** 把召回结果挂到镜头上（返回副本），供 buildPrompt 注入、fingerprint 记录。 */
export function attachRecall(r: RecallResult, s: Scene): Scene {
  if (r.items.length === 0) return { ...s, memory: null };
  return { ...s, memory: { snapshot: r.snapshot, names: recallNames(r), section: recallSection(r), digest: recallDigest(r) } };
}

/** 一次召回的全部输入。同样的输入永远得到同样的结果。 */
export interface RecallInput {
  memories: readonly Memory[] | null;
  stats?: Record<string, Record<string, Stat>> | null;
  renderer: string;
  /** 当前渲染工具的模型，未知时为空。 */
  model?: string;
  features: readonly string[] | null;
  /** 参与关键词匹配的文本（镜头文本与创意方向）。 */
  text?: string;
  project?: string;
  budget: number;
  /** 经验条数上限，0 表示 DefaultMaxLessons。 */
  maxLessons?: number;
}

/**
 * 每个镜头最多注入的经验条数。
 *
 * SkillsBench（2026，87 个任务、18 种模型与 harness 组合）里，给 1 到 3 条技能时
 * 通过率提升 18 到 19 个百分点，4 条及以上只剩 10 个百分点：条数多了，指导之间互相
 * 冲突、分散注意力。字数预算拦不住「很多条短经验」，所以单独设上限。
 * 偏好不计入：那是用户亲口说的取向，只受字数预算约束。
 */
export const DefaultMaxLessons = 3;

/**
 * 选出要注入的记忆：按适用条件匹配，按匹配度 × 效果排序，取到字数预算用完，
 * 经验最多取 maxLessons 条。
 *
 * 只用特征加关键词，不用向量检索：召回要可解释（能说出为什么想起它）、
 * 可复现（同一快照同一结果）、零依赖。
 */
export function recall(input: RecallInput): RecallResult {
  const maxLessons = input.maxLessons && input.maxLessons > 0 ? input.maxLessons : DefaultMaxLessons;
  const model = input.model ?? '';
  const result: RecallResult = {
    snapshot: 0,
    renderer: input.renderer,
    model,
    features: [...(input.features ?? [])],
    budget: input.budget,
    used: 0,
    max_lessons: maxLessons,
    items: [],
    omitted: [],
    explored: null,
    canonical: '',
  };
  const features = new Set(input.features ?? []);
  const text = goToLower(input.text ?? '');
  const candidates: RecallItem[] = [];
  for (const m of input.memories ?? []) {
    if (m.kind === KindPreference && m.scope !== '' && m.scope !== (input.project ?? '')) continue;
    if (!appliesInScope(m.applies_when, input.renderer, model)) continue;
    const item: RecallItem = {
      name: m.name,
      kind: m.kind,
      status: m.status,
      description: m.description,
      score: 0,
      global: false,
      renderers: m.applies_when.renderers,
      models: m.applies_when.models,
      matched_features: [],
      matched_keywords: [],
      rate: 0,
      chars: 0,
      text: '',
      omit_reason: '',
      digest: ruleDigest(m),
    };
    let match = 0;
    if (appliesEmpty(m.applies_when)) {
      item.global = true;
      match = 0.5;
    } else {
      for (const feature of m.applies_when.features) {
        if (features.has(feature)) {
          item.matched_features.push(feature);
          match++;
        }
      }
      for (const keyword of m.applies_when.keywords) {
        if (keyword !== '' && text.includes(goToLower(keyword))) {
          item.matched_keywords.push(keyword);
          match += 0.5;
        }
      }
      if (match === 0) continue;
    }
    // 专为当前渲染工具 / 模型写的经验更可能对症，排在通用经验前面。
    if (m.applies_when.renderers.length > 0) match += 0.5;
    if (m.applies_when.models.length > 0) match++;
    item.rate = smoothedRate(input.stats?.[m.name], input.renderer, model);
    item.score = match * (0.5 + item.rate);
    item.text = renderItem(m);
    item.chars = runeCount(item.text);
    candidates.push(item);
  }
  // sort.SliceStable：分数降序，同分按名字。
  candidates.sort((a, b) => (a.score !== b.score ? b.score - a.score : compareBytes(a.name, b.name)));
  let lessons = 0;
  for (const original of candidates) {
    const item = { ...original };
    if (item.kind === KindLesson && lessons >= maxLessons) item.omit_reason = 'limit';
    else if (result.used + item.chars > input.budget) item.omit_reason = 'budget';
    if (item.omit_reason !== '') {
      result.omitted.push(item);
      continue;
    }
    if (item.kind === KindLesson) lessons++;
    result.used += item.chars;
    result.items.push(item);
  }
  return result;
}

function renderItem(m: Memory): string {
  const label = m.kind === KindPreference ? '（偏好，未经机器验证）' : '';
  let b = `- 【${m.name}】${label}${m.description}\n`;
  for (const line of goTrimSpace(m.body).split('\n')) {
    if (goTrimSpace(line) === '') {
      b += '\n';
      continue;
    }
    b += '  ' + line + '\n';
  }
  return b;
}

/** 对一个镜头做召回时的设置。 */
export interface RecallOptions {
  /** 为 0 时跟随最新快照（考试内部用 -1 表示「没有快照」）。 */
  snapshot?: number;
  budget: number;
  /** 经验条数上限，0 表示 DefaultMaxLessons。 */
  maxLessons?: number;
  renderer?: string;
  /** 当前渲染工具的模型，见 Store.currentModel；未知时为空。 */
  model?: string;
  /** 额外参与召回的记忆（考试里的试用记忆）。 */
  extra?: readonly Memory[] | null;
  /** 不参与召回的记忆名（重考生效记忆时的对照组）。 */
  exclude?: readonly string[] | null;
  /**
   * 探索的概率，0 不探索；exploreSeed 决定这一次抽中与否
   * （同一批次里同一镜头的重试拿到同一个决定）。
   */
  explore?: number;
  exploreSeed?: string;
}

/** 对一个镜头做召回。记忆库还没有快照且没有 extra 时什么也不召回。 */
export function recallScene(s: Store, sc: Scene, opts: RecallOptions): RecallResult {
  const features = sceneFeatures(sc);
  let memories: Memory[] = [];
  let stats: Record<string, Record<string, Stat>> = {};
  let snapshotID = 0;
  const snapshot = s.resolveSnapshot(opts.snapshot ?? 0);
  if (snapshot !== null) {
    snapshotID = snapshot.id;
    memories = snapshotMemories(snapshot);
    if (snapshot.stats !== null) stats = snapshot.stats;
  }
  memories = withExtra(memories, opts.extra ?? []);
  if (opts.exclude && opts.exclude.length > 0) memories = memories.filter((m) => !contains(opts.exclude, m.name));
  let result = recall({
    memories,
    stats,
    renderer: opts.renderer ?? '',
    model: opts.model ?? '',
    features,
    text: sc.text + '\n' + promptText(sc),
    project: projectOf(sc.directory),
    budget: opts.budget,
    maxLessons: opts.maxLessons ?? 0,
  });
  result.snapshot = snapshotID;
  if ((opts.explore ?? 0) > 0) result = explore(result, opts.explore!, (opts.exploreSeed ?? '') + '|' + sc.directory);
  return result;
}

/**
 * 以 rate 的概率把注入的最后一条经验换成 omitted 里第一条换得进去的经验
 * （字数预算仍然成立）。抽签由 seed 的哈希决定，可复现。
 */
export function explore(r: RecallResult, rate: number, seed: string): RecallResult {
  let last = -1;
  r.items.forEach((item, i) => {
    if (item.kind === KindLesson) last = i;
  });
  if (last < 0) return r;
  const dropped = { ...r.items[last] };
  let pick = -1;
  for (let i = 0; i < r.omitted.length; i++) {
    const item = r.omitted[i];
    if (item.kind === KindLesson && r.used - dropped.chars + item.chars <= r.budget) {
      pick = i;
      break;
    }
  }
  if (pick < 0 || draw(seed) >= rate) return r;
  const out: RecallResult = { ...r };
  const added = { ...r.omitted[pick] };
  out.canonical = itemsDigest(r.items);
  added.omit_reason = '';
  const items = [...r.items];
  items[last] = added;
  const omitted = [...r.omitted.slice(0, pick), ...r.omitted.slice(pick + 1)];
  dropped.omit_reason = 'explore';
  out.items = items;
  out.omitted = [...omitted, dropped];
  out.used = r.used + added.chars - dropped.chars;
  out.explored = { dropped: dropped.name, added: added.name, propensity: rate };
  return out;
}

/**
 * 把 seed 映射到 [0, 1)：sha256 的前 8 字节按大端读成 uint64，右移 11 位留下 53 位，除以 2^53。
 * 与 Go 版逐位相同，同一个种子在两边抽到同一个结果。
 */
export function draw(seed: string): number {
  const sum = crypto.createHash('sha256').update(seed, 'utf8').digest();
  const n = sum.readBigUInt64BE(0) >> 11n;
  return Number(n) / 2 ** 53;
}

/**
 * 把试用记忆加进召回池；试用记忆是某条生效记忆的修订时，
 * 被修订的旧版本退出召回池——两版同时注入就等于并列新增。
 */
export function withExtra(memories: readonly Memory[], extra: readonly Memory[]): Memory[] {
  const replaced = new Set<string>();
  for (const m of extra) {
    if (m.revises !== '') replaced.add(m.revises);
  }
  return [...memories.filter((m) => !replaced.has(m.name)), ...extra];
}
