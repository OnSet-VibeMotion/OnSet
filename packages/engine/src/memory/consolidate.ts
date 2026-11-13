// 移植自 internal/memory/consolidate.go。
import fs from 'node:fs';
import path from 'node:path';
import { goQuote } from '../gofmt';
import { compareBytes, sortedKeys } from '../gojson';
import { load as loadScene, loadRecord } from '../scene';
import { preferenceSignals, signalToJSON, type Signal } from './conversation';
import { failure, SourceConversation, SourceExam, SourceFeedback, SourceRender, type Episode } from './episode';
import { EventConsolidate, EventDraftReject, EventTrial } from './events';
import { featureDescriptions, knownCheckers } from './features';
import { compactStamp } from './gostr';
import { readDirSorted, walkDir, writeJSON } from './io';
import { lint } from './lint';
import { appliesScoped, kindDir, KindLesson, KindPreference, parse, StatusActive, StatusTrial, type Kind, type Memory } from './memory';
import { checkFailures, effectivelyPassed } from './stats';
import type { Store } from './store';
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
   * 通过那次的输入指纹：镜头目录里 .am-render.json 的指纹与它相同时，
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
function clusterSince(fresh: readonly Episode[], all: readonly Episode[], since: string): Cluster[] {
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
    if (!failure(e) || e.source === SourceExam || e.source === SourceFeedback || e.source === SourceConversation) continue;
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
        if (check === key && i < problems.length && (c.examples?.length ?? 0) < 4 && !contains(c.examples, problems[i])) {
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
 * 没有被这个校验器判过失败。同一镜头后来改对的优先，其次同渲染工具、共同特征多的。
 */
function contrasts(c: Cluster, byID: Map<string, Episode>, all: readonly Episode[], failedChecks: Set<string>): Contrast[] {
  const out: Contrast[] = [];
  const used = new Set<string>();
  for (const id of c.episodes ?? []) {
    if (out.length >= MaxContrasts) break;
    const failed = byID.get(id);
    if (!failed) continue;
    let best: Episode | null = null;
    let bestScore = 0;
    for (const e of all) {
      if (e.source !== SourceRender || !effectivelyPassed(e, failedChecks) || used.has(e.id) || contains(e.checks, c.key)) continue;
      const shared = intersect(failed.features, e.features);
      let score = shared?.length ?? 0;
      if (e.scene_dir !== '' && e.scene_dir === failed.scene_dir) score += 100;
      if (e.renderer === failed.renderer) score += 0.5;
      if (score === 0) continue;
      if (best === null || score > bestScore || (score === bestScore && compareBytes(e.created_at, best.created_at) > 0)) {
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
      if (copySourceTree(pair.passed_dir, path.join(workdir, rel)) > 0) pair.passed_code = rel.split(path.sep).join('/');
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
        if (entry !== null && ['attempts', 'node_modules', '.studio-frames', '.git', 'fonts'].includes(entry.name)) return 'skip';
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
 * 整理：失败经历聚类 → 交给整理者起草或修订 → 格式校验 → 合格的进入试用。
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
    for (const sub of ['drafts/lessons', 'drafts/preferences']) fs.mkdirSync(path.join(workdir, sub), { recursive: true });
    result.workdir = workdir;
    const existing = s.memories().memories;
    copyContrastCode(workdir, clusters);
    const brief = consolidationBrief(clusters, existing);
    fs.writeFileSync(path.join(workdir, 'brief.md'), brief, { mode: 0o644 });
    writeJSON(path.join(workdir, 'clusters.json'), clusters.map(clusterToJSON));
    try {
      await opts.drafter(workdir, brief, opts.signal);
    } catch (err) {
      throw withResult(new Error(`整理者执行失败：${err instanceof Error ? err.message : String(err)}`, { cause: err }), result);
    }
    drafts = path.join(workdir, 'drafts');
  }
  const allowed = new Set<string>();
  for (const c of clusters) for (const id of c.episodes ?? []) allowed.add(id);
  // 直接收录现成草稿时没有聚类约束，来源经历只要存在即可。
  if (opts.draftsDir) for (const e of episodes) allowed.add(e.id);
  const texts = episodes.map((e) => e.text);
  ingestDrafts(s, drafts, allowed, texts, result);
  s.log({
    time: '',
    type: EventConsolidate,
    summary: `整理：${clusters.length} 组高频失败 → ${result.accepted.length} 条进入试用，${Object.keys(result.rejected).length} 条草稿被拒`,
    detail: { run, clusters: clusters.length > 0 ? clusters.map(clusterToJSON) : null, accepted: result.accepted, rejected: sortedKeys(result.rejected) },
  });
  return result;
}

function withResult(err: Error, result: ConsolidateResult): Error {
  return Object.assign(err, { result });
}

function ingestDrafts(s: Store, dir: string, allowedEpisodes: Set<string>, sceneTexts: string[], result: ConsolidateResult): void {
  for (const kind of [KindLesson, KindPreference] as Kind[]) {
    const entries = readDirSorted(path.join(dir, kindDir(kind)));
    if (entries === null) continue;
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.name.endsWith('.md')) continue;
      const label = kindDir(kind) + '/' + entry.name;
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
        detail: { memory: m.name, kind: m.kind, from_episodes: m.from_episodes.length > 0 ? m.from_episodes : null, revises: m.revises },
      });
    }
  }
  result.accepted.sort(compareBytes);
}

export function kindLabel(kind: Kind): string {
  return kind === KindPreference ? '偏好' : '经验';
}

/** 交给整理者的说明。 */
export function consolidationBrief(clusters: readonly Cluster[], existing: readonly Memory[] | null): string {
  let b = `# 整理渲染经验

你要把下面几组反复出现的渲染失败，提炼成可检验的经验，或修订已经被召回却仍然失败的旧经验。
这些经验会在以后每个镜头开工前按镜头特征召回，注入给负责渲染的 AI。记忆库由多种渲染工具与模型共用，
不同模型犯的错并不一样：通病写成通用经验，某个模型特有的毛病限定范围。

只在当前目录的 drafts/ 下写文件：经验写进 drafts/lessons/<name>.md，人工反馈里的审美取向写进 drafts/preferences/<name>.md。
不要改动其他任何文件，不要渲染，不要运行其他命令。写完即结束。

## 文件格式

\`\`\`markdown
---
name: font-local-block
description: 中文字体用镜头目录内的本地文件，font-display 写 block，否则会静默回退
status: trial
applies_when:
  features: [cjk_text]
  keywords: [字体, font]
  # 只对某些渲染工具或模型成立时才写，下面两项都可省略：
  # renderers: [codex]
  # models: [gpt-6]
checked_by: [determinism.font-display, determinism.remote-font]
from_episodes: [ep-20261102-101500-a1b2c3]
---

中文字体必须用镜头目录内的本地文件，通过 @font-face 引入，font-display 写 block。

反例：
    @import url('https://fonts.googleapis.com/...');

正例：
    @font-face { font-family: 'X'; src: url('./fonts/x.woff2'); font-display: block; }
\`\`\`

## 硬性要求（不满足的草稿会被直接拒收）

- name 用小写字母、数字与连字符，与文件名一致，不得与已有记忆重名。
- 经验必须写成一条可检验的约束，正文同时给出「反例」与「正例」代码片段，正文不超过 600 字，description 不超过 80 字。
- checked_by 优先用能在单镜头里判定的校验器（output.*、determinism.*、frames.blank）：只由 reads.* 或
  review.handoff 判定的经验要看整片，考试考不了，只能等人确认。
- checked_by 只能取下面「校验器」里的 ID，写明这条经验由哪个校验器判定；偏好的 checked_by 写 [human]。
- applies_when.features 只能取下面「镜头特征」里的值；适用于所有镜头时省略 applies_when。
- from_episodes 列出这条经验来自哪些经历编号，只能取下面各组里出现的编号。
- 正文、description 与 keywords 里不得出现渲染工具名、模型名或厂商名。
- 先看每组的「渲染工具/模型分布」判断范围：几种渲染工具或模型都出现的是通病，不写范围；
  集中在某个渲染工具或模型上的，用 applies_when.renderers（渲染工具 ID）或 applies_when.models
  （模型名，按前缀匹配，如 gpt-6 匹配 gpt-6-astra）限定，只对它们召回。只有一个样本时不要凭它下结论说是通病。
- 不得包含具体镜头的文案、镜头编号或素材文件名：经验要能迁移到别的文章。
- 已有记忆说的是同一件事时，写成修订：换一个新名字，加 revises: <旧名>，正文写完整的新版本。不要并列新增。
  修订必须保留旧版的全部 checked_by，正文不得短于旧版的一半：只改错的地方、补漏掉的情况，
  不要为了简洁删掉旧版里仍然成立的细节、数值和反例正例。
- 每个镜头最多注入 3 条经验：宁可一条写准，不要拆成几条泛泛的。
- 只为确有共性的失败写经验；拿不准的组宁可不写。
- 有「成败对照」的组，先读 contrasts/ 下通过那一版的合成代码：失败的一次犯了这个错，通过的一次没犯。
  经验写成「通过的那一边是怎么做的」，正例尽量取自通过的写法，不要只是把报错改写成禁令。
- 「用户的反应」一组写成偏好：从回退、反复提的要求与 👍 / 👎 里归纳用户长期的取向（节奏、配色、
  信息密度、语气……），不是复述某一次的修改要求。只在一个项目里出现的写 scope: <项目名>，
  几个项目都出现的不写 scope。偏好要用户确认后才生效，宁可少写。

`;
  b += '## 镜头特征\n\n';
  const features = featureDescriptions();
  for (const name of Object.keys(features).sort(compareBytes)) b += `- \`${name}\`：${features[name]}\n`;
  b += '- `handoff:<手法>`：交接用了某种手法（carry、match、push_in、flood、pan、settle）\n\n## 校验器\n\n';
  for (const id of knownCheckers()) b += `- \`${id}\`\n`;
  b += '\n## 已有记忆\n\n';
  let count = 0;
  for (const m of existing ?? []) {
    if (m.status !== StatusActive && m.status !== StatusTrial) continue;
    count++;
    const scope = appliesScoped(m.applies_when) ? [...m.applies_when.renderers, ...m.applies_when.models].join(', ') : '不限';
    b +=
      `### ${m.name}（${kindLabel(m.kind)}，${m.status}）\n\n${m.description}\n\n` +
      `checked_by: ${(m.checked_by ?? []).join(', ')}；features: ${m.applies_when.features.join(', ')}；渲染工具/模型：${scope}\n\n${m.body}\n\n`;
  }
  if (count === 0) b += '（暂无）\n\n';
  b += '## 高频失败\n\n';
  for (const c of clusters) {
    const title = c.key === ClusterKeyHuman ? '用户的反应（回退、反复提的要求、👍 / 👎）' : '校验器 `' + c.key + '`';
    b += `### ${title}：${c.count} 次\n\n`;
    b += `- 经历：${(c.episodes ?? []).join(', ')}\n`;
    if (Object.keys(c.models).length > 0) b += `- 渲染工具/模型分布：${distribution(c.models)}\n`;
    if ((c.features?.length ?? 0) > 0) b += `- 共同特征：${c.features!.join(', ')}\n`;
    if ((c.recalled?.length ?? 0) > 0) b += `- 失败时已召回的记忆（没帮上忙，考虑修订）：${c.recalled!.join(', ')}\n`;
    for (const example of c.examples ?? []) b += `- 报错示例：${example}\n`;
    for (const note of c.notes ?? []) b += `- ${note}\n`;
    for (const pair of c.contrasts ?? []) b += contrastLine(pair);
    b += '\n';
  }
  return b;
}

export function contrastLine(pair: Contrast): string {
  const kind = pair.same_scene ? '同一个镜头后来改对了' : '特征相近的另一个镜头通过了';
  let line = `- 成败对照（${kind}）：失败 ${pair.failed}，通过 ${pair.passed}`;
  if (pair.passed_code !== '') line += '；通过那一版的合成代码拷在当前目录的 ' + pair.passed_code + '/';
  else line += '；通过那一版的代码已被后来的渲染覆盖，只能对照报错与特征';
  if ((pair.shared_features?.length ?? 0) > 0) line += '；共同特征 ' + pair.shared_features!.join(', ');
  return line + '\n';
}

/** 把计数写成「a × 3、b × 1」，按次数降序。 */
export function distribution(counts: Record<string, number>): string {
  const keys = Object.keys(counts).sort((a, b) => (counts[a] !== counts[b] ? counts[b] - counts[a] : compareBytes(a, b)));
  return keys.map((key) => `${key} × ${counts[key]}`).join('、');
}

const signalLabels: Record<string, string> = { reverted: '回退了这一轮', repeated: '反复提到', liked: '👍', disliked: '👎' };

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
