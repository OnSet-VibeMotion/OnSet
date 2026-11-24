import { OutcomeSucceeded, OutcomeVerificationFailed } from '../scene';
import { type Usage, usageJSON } from '../tools';
import type { Exploration } from './recall';
import { omitEmpty } from './util';

// 经历来源。
/** 正式渲染（onset scene run / run-all）。 */
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
  /** 这次渲染所属的批次（一次 onset scene run / run-all 调用），用于按批次对比。 */
  run: string;
  /** Studio 对话的会话与轮次，只对 SourceConversation 有值。 */
  session: string;
  turn: string;
  /** 考试编号，只对 SourceExam 有值。 */
  exam: string;
  feedback: Feedback | null;
  /** 导入来源（原始路径加开始时间），只对 onset memory import 导入的经历有值，用于去重。 */
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
    explored: e.explored
      ? { dropped: e.explored.dropped, added: e.explored.added, propensity: e.explored.propensity }
      : undefined,
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
    credits: o.credits === undefined || o.credits === null ? null : num(o.credits),
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
      explored: explored
        ? { dropped: str(explored.dropped), added: str(explored.added), propensity: num(explored.propensity) }
        : null,
      run: str(o.run),
      session: str(o.session),
      turn: str(o.turn),
      exam: str(o.exam),
      feedback: feedback
        ? {
            verdict: str(feedback.verdict),
            note: str(feedback.note),
            seconds: num(feedback.seconds),
            region:
              feedback.region === undefined || feedback.region === null
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
