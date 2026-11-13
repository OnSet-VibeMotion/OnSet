import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import { goQuote } from '../gofmt';
import { blockExtraInputDirs, FrameFile, frameSource, OutcomeSucceeded, OutcomeVerificationFailed, inputFiles, type Attempt, type Scene } from '../scene';
import { usageJSON, type Usage } from '../tools';
import { features as sceneFeatures } from './features';
import { compactStamp, monthStamp, rfc3339Nano } from './gostr';
import { copyFile, readJSON, walkDir, writeJSON } from './io';
import type { Exploration } from './recall';
import { EventEpisode } from './events';
import type { Store } from './store';
import { omitEmpty, rendererModel, uniqueSorted } from './util';

// 经历来源。
/** 正式渲染（am scene run / run-all）。 */
export const SourceRender = 'render';
/**
 * 考试里的作答。不进入整理，也不计入效果统计：
 * 考试是人为安排的对照实验，混进来会让统计偏向考题。
 */
export const SourceExam = 'exam';
/** 人工反馈。 */
export const SourceFeedback = 'feedback';
/**
 * Studio 对话里用户说的话。单独一句不说明什么，
 * 反复提到的要求、被回退的一轮才是偏好信号，见 preferenceSignals。
 */
export const SourceConversation = 'conversation';
/**
 * 渲染之后的质量检查（阅读时间、交接、空白帧）发现的问题。
 * 它们决定观感，却不在产物校验里：渲染当时判了通过，事后才查出来。
 */
export const SourceCheck = 'check';

/** 人工反馈经历的 outcome。 */
export const OutcomeFeedback = 'feedback';

/** 一条人工反馈。 */
export interface Feedback {
  /** up 或 down（对话经历还有 said）。 */
  verdict: string;
  note: string;
  /** 被评价的画面在镜头内的时间点，负数表示未指定。 */
  seconds: number;
  /** 框选区域，归一化坐标 x,y,w,h；空表示整帧。 */
  region: number[] | null;
  /** 点选的元素描述（选择器或文字）。 */
  element: string;
}

export function newFeedback(fields: Partial<Feedback> = {}): Feedback {
  return { verdict: '', note: '', seconds: 0, region: null, element: '', ...fields };
}

export function feedbackToJSON(f: Feedback): Record<string, unknown> {
  return {
    verdict: f.verdict,
    note: f.note || undefined,
    seconds: f.seconds,
    region: omitEmpty(f.region),
    element: f.element || undefined,
  };
}

/** 一段经历：一次渲染尝试或一条人工反馈的完整记录。只增不改。 */
export interface Episode {
  schema: number;
  id: string;
  created_at: string;
  source: string;
  /** 镜头所在项目根的目录名；偏好的作用范围按它划分。 */
  project: string;
  scene_dir: string;
  scene_id: string;
  text: string;
  renderer: string;
  model: string;
  fingerprint: string;
  outcome: string;
  retry: boolean;
  seconds: number;
  usage: Usage | null;
  error: string;
  problems: string[] | null;
  checks: string[] | null;
  features: string[] | null;
  /** 这次渲染召回的记忆名；snapshot 是召回依据的快照号。 */
  recalled: string[] | null;
  snapshot: number;
  /** 非空表示这次召回做了探索，recalled 是探索后真正注入的。 */
  explored: Exploration | null;
  /** 这次渲染所属的批次（一次 am scene run / run-all 调用），用于按批次对比。 */
  run: string;
  /** Studio 对话的会话与轮次，只对 SourceConversation 有值。 */
  session: string;
  turn: string;
  /** 考试编号，只对 SourceExam 有值。 */
  exam: string;
  feedback: Feedback | null;
  /** 导入来源（原始路径加开始时间），只对 am memory import 导入的经历有值，用于去重。 */
  imported: string;
  /** 冻结输入相对经历目录的路径；考试从这里原样重放。 */
  input: string;
  /** 经历目录，读出时填入，不落盘。 */
  dir: string;
}

export function newEpisode(fields: Partial<Episode> = {}): Episode {
  return {
    schema: 0,
    id: '',
    created_at: '',
    source: '',
    project: '',
    scene_dir: '',
    scene_id: '',
    text: '',
    renderer: '',
    model: '',
    fingerprint: '',
    outcome: '',
    retry: false,
    seconds: 0,
    usage: null,
    error: '',
    problems: null,
    checks: null,
    features: null,
    recalled: null,
    snapshot: 0,
    explored: null,
    run: '',
    session: '',
    turn: '',
    exam: '',
    feedback: null,
    imported: '',
    input: '',
    dir: '',
    ...fields,
  };
}

/** Episode 的 JSON（字段顺序与 omitempty 同 Go）。 */
export function episodeToJSON(e: Episode): Record<string, unknown> {
  return {
    schema: e.schema,
    id: e.id,
    created_at: e.created_at,
    source: e.source,
    project: e.project || undefined,
    scene_dir: e.scene_dir,
    scene_id: e.scene_id,
    text: e.text,
    renderer: e.renderer || undefined,
    model: e.model || undefined,
    fingerprint: e.fingerprint || undefined,
    outcome: e.outcome,
    retry: e.retry,
    seconds: e.seconds || undefined,
    usage: e.usage ? usageJSON(e.usage) : undefined,
    error: e.error || undefined,
    problems: omitEmpty(e.problems),
    checks: omitEmpty(e.checks),
    features: e.features,
    recalled: omitEmpty(e.recalled),
    snapshot: e.snapshot || undefined,
    explored: e.explored ? { dropped: e.explored.dropped, added: e.explored.added, propensity: e.explored.propensity } : undefined,
    run: e.run || undefined,
    session: e.session || undefined,
    turn: e.turn || undefined,
    exam: e.exam || undefined,
    feedback: e.feedback ? feedbackToJSON(e.feedback) : undefined,
    imported: e.imported || undefined,
    input: e.input || undefined,
  };
}

// ---- 读入（json.Unmarshal 进 Episode；类型不符时整段跳过，与 Go 的 readJSON 失败相同） ----

class Mismatch extends Error {}

function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Mismatch();
  return v;
}
function num(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number') throw new Mismatch();
  return v;
}
function int(v: unknown): number {
  const n = num(v);
  if (!Number.isInteger(n)) throw new Mismatch();
  return n;
}
function bool(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new Mismatch();
  return v;
}
function strs(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new Mismatch();
  return v.map((item) => str(item));
}
function obj(v: unknown): Record<string, unknown> | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Mismatch();
  return v as Record<string, unknown>;
}

function parseUsage(v: unknown): Usage | null {
  const o = obj(v);
  if (o === null) return null;
  const u: Usage = {
    input_tokens: int(o.input_tokens),
    output_tokens: int(o.output_tokens),
    cached_input_tokens: int(o.cached_input_tokens),
    cost_usd: o.cost_usd === undefined || o.cost_usd === null ? null : num(o.cost_usd),
    turns: int(o.turns),
    partial: bool(o.partial),
    basis: str(o.basis),
    source: str(o.source),
  };
  return u;
}

/** 解析一份 episode.json；读不懂时返回 null。 */
export function parseEpisode(raw: unknown): Episode | null {
  try {
    const o = obj(raw);
    if (o === null) return null;
    const explored = obj(o.explored);
    const feedback = obj(o.feedback);
    return newEpisode({
      schema: int(o.schema),
      id: str(o.id),
      created_at: str(o.created_at),
      source: str(o.source),
      project: str(o.project),
      scene_dir: str(o.scene_dir),
      scene_id: str(o.scene_id),
      text: str(o.text),
      renderer: str(o.renderer),
      model: str(o.model),
      fingerprint: str(o.fingerprint),
      outcome: str(o.outcome),
      retry: bool(o.retry),
      seconds: num(o.seconds),
      usage: parseUsage(o.usage),
      error: str(o.error),
      problems: strs(o.problems),
      checks: strs(o.checks),
      features: strs(o.features),
      recalled: strs(o.recalled),
      snapshot: int(o.snapshot),
      explored: explored ? { dropped: str(explored.dropped), added: str(explored.added), propensity: num(explored.propensity) } : null,
      run: str(o.run),
      session: str(o.session),
      turn: str(o.turn),
      exam: str(o.exam),
      feedback: feedback
        ? {
            verdict: str(feedback.verdict),
            note: str(feedback.note),
            seconds: num(feedback.seconds),
            region: feedback.region === undefined || feedback.region === null
              ? null
              : (() => {
                  if (!Array.isArray(feedback.region)) throw new Mismatch();
                  return feedback.region.map((x) => num(x));
                })(),
            element: str(feedback.element),
          }
        : null,
      imported: str(o.imported),
      input: str(o.input),
    });
  } catch (err) {
    if (err instanceof Mismatch) return null;
    throw err;
  }
}

/** 报告这是不是镜头的首次尝试（调度层重试不算）。 */
export function firstTry(e: Episode): boolean {
  return !e.retry;
}

/** 报告这次尝试是否通过全部硬校验。 */
export function passed(e: Episode): boolean {
  return e.outcome === OutcomeSucceeded;
}

/**
 * 报告这段经历是不是整理的原料：校验失败，或人工 👎。
 * 渲染器崩溃、被中断不算——那不是渲染写法的问题，记忆帮不上忙。
 */
export function failure(e: Episode): boolean {
  if (e.source === SourceFeedback) return e.feedback !== null && e.feedback.verdict === 'down';
  return e.outcome === OutcomeVerificationFailed && (e.checks?.length ?? 0) > 0;
}

function newEpisodeID(now: Date): string {
  return 'ep-' + compactStamp(now) + '-' + crypto.randomBytes(3).toString('hex');
}

/** Go 的 filepath.Dir。 */
function goFileDir(p: string): string {
  return path.dirname(p === '' ? '.' : p);
}

function goFileBase(p: string): string {
  if (p === '') return '.';
  const base = path.basename(p);
  return base === '' ? '/' : base;
}

/** dir 所在项目的名字（项目根目录名：向上找含 article-to-motion.conf 的目录），不在项目里时为空。 */
export function projectName(dir: string): string {
  return projectOf(dir);
}

export function projectOf(dir: string): string {
  let current = dir;
  for (;;) {
    try {
      fs.statSync(path.join(current, 'article-to-motion.conf'));
      return goFileBase(current);
    } catch {
      // 继续向上找。
    }
    const parent = goFileDir(current);
    if (parent === current) return '';
    current = parent;
  }
}

/** 一次渲染尝试从哪来。 */
export interface AttemptSource {
  /** SourceRender 或 SourceExam。 */
  source: string;
  /** 批次编号，见 Episode.run。 */
  run?: string;
  /** 考试编号，只对 SourceExam 有值。 */
  exam?: string;
  /** 这次召回的探索，见 RecallResult.explored。 */
  explored?: Exploration | null;
}

function featuresOrNull(sc: Scene): string[] | null {
  try {
    return sceneFeatures(sc);
  } catch {
    return null;
  }
}

/** 把一次渲染尝试写成经历，冻结镜头输入，并写进时间线。 */
export function recordAttempt(s: Store, sc: Scene, attempt: Attempt, from: AttemptSource): Episode {
  const episode = newEpisode({
    source: from.source,
    scene_id: sc.id,
    text: sc.text,
    renderer: attempt.renderer,
    model: attempt.model,
    fingerprint: attempt.fingerprint,
    outcome: attempt.outcome,
    retry: attempt.retry,
    seconds: attempt.seconds,
    usage: attempt.usage,
    error: attempt.error,
    problems: attempt.problems,
    checks: attempt.checks,
    features: featuresOrNull(sc),
    exam: from.exam ?? '',
    run: from.run ?? '',
  });
  if (sc.memory !== null) {
    episode.recalled = sc.memory.names && sc.memory.names.length > 0 ? [...sc.memory.names] : null;
    episode.snapshot = sc.memory.snapshot;
    episode.explored = from.explored ?? null;
  }
  s.observeModel(attempt.renderer, attempt.model);
  return saveEpisode(s, sc, episode);
}

/** 把一条人工反馈写成经历。 */
export function recordFeedback(s: Store, sc: Scene, feedback: Feedback): Episode {
  if (feedback.verdict !== 'up' && feedback.verdict !== 'down') {
    throw new Error(`反馈只能是 up 或 down，收到 ${goQuote(feedback.verdict)}`);
  }
  return saveEpisode(
    s,
    sc,
    newEpisode({
      source: SourceFeedback,
      scene_id: sc.id,
      text: sc.text,
      renderer: sc.renderer,
      outcome: OutcomeFeedback,
      features: featuresOrNull(sc),
      feedback: { ...feedback },
    }),
  );
}

export function saveEpisode(s: Store, sc: Scene, episode: Episode): Episode {
  const now = s.clock();
  episode = { ...episode };
  episode.schema = 1;
  episode.id = newEpisodeID(now);
  episode.created_at = rfc3339Nano(now);
  episode.scene_dir = sc.directory;
  episode.project = projectOf(sc.directory);
  if (episode.features === null) episode.features = [];
  const dir = path.join(s.dir, 'episodes', monthStamp(now), episode.id);
  fs.mkdirSync(dir, { recursive: true });
  // 对话信号不属于某个镜头，没有输入可冻结。
  if (sc.id !== '') {
    try {
      freezeInput(sc, path.join(dir, 'input'));
      episode.input = 'input';
    } catch {
      // 冻结失败时这段经历不能用来考试，但照样记下。
    }
  }
  writeJSON(path.join(dir, 'episode.json'), episodeToJSON(episode));
  episode.dir = dir;
  s.log({
    time: '',
    type: EventEpisode,
    summary: episodeSummary(episode),
    project: episode.project,
    detail: {
      episode: episode.id,
      scene: episode.scene_id,
      renderer: episode.renderer,
      model: episode.model,
      outcome: episode.outcome,
      checks: episode.checks,
      recalled: episode.recalled,
      source: episode.source,
      exam: episode.exam,
    },
  });
  return episode;
}

function episodeSummary(e: Episode): string {
  const prefix = e.source === SourceExam ? '考试 ' + e.exam + '：' : '';
  return prefix + episodeOutcome(e);
}

function episodeOutcome(e: Episode): string {
  if (e.source === SourceConversation) {
    if (e.feedback !== null && e.feedback.verdict === 'down') return '用户回退了一轮对话：' + e.text;
    return '用户说：' + e.text;
  }
  if (e.source === SourceFeedback) {
    const verdict = e.feedback!.verdict === 'down' ? '👎' : '👍';
    return `镜头 ${e.scene_id} 收到人工反馈 ${verdict} ${e.feedback!.note}`;
  }
  if (passed(e)) return `镜头 ${e.scene_id}（${rendererModel(e.renderer, e.model)}）通过校验，召回 ${e.recalled?.length ?? 0} 条记忆`;
  if ((e.checks?.length ?? 0) > 0) {
    return `镜头 ${e.scene_id}（${rendererModel(e.renderer, e.model)}）校验失败：${(uniqueSorted(e.checks) ?? []).join('、')}`;
  }
  return `镜头 ${e.scene_id}（${e.renderer}）${e.outcome}`;
}

/**
 * 把镜头声明过的输入原样拷进 target，供考试重放。
 * 清单与输入指纹同源（scene.inputFiles），另加镜头扩展块要带的目录（例如角色包），
 * 以及镜头当时就近读到的 frame.md：画幅只从 frame.md 取，重放要按当时的画幅。
 */
export function freezeInput(sc: Scene, target: string): void {
  for (const rel of inputFiles(sc)) copyFile(path.join(sc.directory, rel), path.join(target, rel));
  const frame = frameSource(sc);
  if (frame) copyFile(path.join(frame.directory, frame.file), path.join(target, FrameFile));
  for (const rel of blockExtraInputDirs(sc)) {
    const root = path.join(sc.directory, rel);
    walkDir(root, (file, entry, _isDir, err) => {
      if (err) throw err;
      if (entry === null || !entry.isFile()) return;
      copyFile(file, path.join(target, path.relative(sc.directory, file)));
    });
  }
}

/** 读出全部经历，按时间升序。 */
export function episodes(s: Store): Episode[] {
  const out: Episode[] = [];
  const root = path.join(s.dir, 'episodes');
  walkDir(root, (file, entry, isDir, err) => {
    if (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'skip';
      throw err;
    }
    if (isDir && entry !== null && entry.name === 'input') return 'skip';
    if (isDir || entry === null || entry.name !== 'episode.json') return;
    let raw: unknown;
    try {
      raw = readJSON(file);
    } catch {
      return;
    }
    const episode = parseEpisode(raw);
    if (episode === null || episode.id === '') return;
    episode.dir = path.dirname(file);
    out.push(episode);
  });
  out.sort((a, b) => {
    if (a.created_at !== b.created_at) return compareBytes(a.created_at, b.created_at);
    return compareBytes(a.id, b.id);
  });
  return out;
}

/** 按编号找经历。 */
export function episodeByID(s: Store, id: string): Episode {
  const found = episodes(s).find((e) => e.id === id);
  if (!found) throw new Error(`经历 ${id} 不存在`);
  return found;
}
