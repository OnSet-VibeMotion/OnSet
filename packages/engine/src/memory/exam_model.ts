import type { Attempt, Scene } from '../scene';
import { type Usage, usageJSON } from '../tools';
import type { Finding } from './checks';
import { omitEmpty } from './util';

/** 考试的一组：对照组只带当前生效记忆，试用组再加上试用记忆。 */
export type Arm = string;
export const ArmControl: Arm = 'control';
export const ArmTrial: Arm = 'trial';

/** 一道考题。 */
export interface Question {
  id: string;
  /** 错题的来源经历；留出题为空。 */
  episode: string;
  holdout: boolean;
  scene_id: string;
  /** 重放用的镜头输入目录。 */
  input: string;
}

export function questionToJSON(q: Question): Record<string, unknown> {
  return { id: q.id, episode: q.episode || undefined, holdout: q.holdout, scene_id: q.scene_id, input: q.input };
}

/** 考试矩阵的一格：一道题 × 一个渲染工具 × 一组 × 第几次重复。 */
export interface Cell {
  question: string;
  holdout: boolean;
  renderer: string;
  model: string;
  arm: Arm;
  repeat: number;
  outcome: string;
  passed: boolean;
  problems: number;
  checks: string[] | null;
  seconds: number;
  usage: Usage | null;
  error: string;
  /** 渲染工具自身故障（认证失效、崩溃、被中断），这一格没有有效结果。 */
  invalid: boolean;
  recalled: string[] | null;
  episode: string;
  workdir: string;
  /** 检查所需证据不完整，不能用该格的缺失申报证明质量增益。 */
  incomplete?: boolean;
}

export function newCell(fields: Partial<Cell> = {}): Cell {
  return {
    question: '',
    holdout: false,
    renderer: '',
    model: '',
    arm: '',
    repeat: 0,
    outcome: '',
    passed: false,
    problems: 0,
    checks: null,
    seconds: 0,
    usage: null,
    error: '',
    invalid: false,
    recalled: null,
    episode: '',
    workdir: '',
    ...fields,
  };
}

export function cellToJSON(c: Cell): Record<string, unknown> {
  return {
    question: c.question,
    holdout: c.holdout,
    renderer: c.renderer,
    model: c.model || undefined,
    arm: c.arm,
    repeat: c.repeat,
    outcome: c.outcome,
    passed: c.passed,
    problems: c.problems,
    checks: omitEmpty(c.checks),
    seconds: c.seconds,
    usage: c.usage ? usageJSON(c.usage) : undefined,
    error: c.error || undefined,
    invalid: c.invalid || undefined,
    recalled: omitEmpty(c.recalled),
    episode: c.episode || undefined,
    workdir: c.workdir,
    incomplete: c.incomplete || undefined,
  };
}

/**
 * 一格的确定性得分：一次通过全部硬校验得 10 分，否则每个失败项扣 1 分。
 * 耗时与 token 只记录，不计分。
 */
export function cellScore(c: Cell): number {
  if (c.invalid) return 0;
  if (c.passed) return 10;
  return -c.problems;
}

/** 考试门槛的判定结果。 */
export interface Verdict {
  /** 为 true 时试用记忆转为生效。 */
  pass: boolean;
  /** 为 true 时整场考试无效：既不生效也不拒绝。 */
  invalid: boolean;
  /** 为 true 时规则变过、经验未召回或检查证据不足，保留原状态，需核实后重考。 */
  needs_human: boolean;
  control_score: number;
  trial_score: number;
  reasons: string[];
}

export function verdictToJSON(v: Verdict): Record<string, unknown> {
  return {
    pass: v.pass,
    invalid: v.invalid,
    needs_human: v.needs_human,
    control_score: v.control_score,
    trial_score: v.trial_score,
    reasons: v.reasons,
  };
}

/**
 * 渲染一格考题并返回这次尝试的记录。sc 已挂好召回结果。
 * 渲染工具自身故障时返回的 outcome 为 failed 或 interrupted。
 * 作答者由调用方注入（cli 接上 scene.run），memory 不依赖调度层。
 */
export type ExamRunner = (sc: Scene, renderer: string, signal?: AbortSignal) => Promise<Attempt>;

/** 作答通过产物校验后补跑的事后检查。 */
export type PostCheck = (sc: Scene, checks: string[], signal?: AbortSignal) => Promise<Finding[]> | Finding[];

/** 一场考试的设置。 */
export interface ExamOptions {
  renderers: string[];
  /** 参加考试的试用记忆名；为空时取全部试用经验。 */
  trial?: string[] | null;
  /** 错题来源经历；为空时取试用记忆的 from_episodes。 */
  episodes?: string[] | null;
  /** 留出题的镜头目录。 */
  holdout?: string[] | null;
  /** 仅验证未参与总结的新镜头；用于旧题已被用户批准例外取代后的迁移验证。 */
  holdoutOnly?: boolean;
  maxQuestions?: number;
  repeat?: number;
  jobs?: number;
  budget: number;
  /** 放考场目录的位置，必须在项目里，渲染器才找得到项目的技能。 */
  workspace: string;
  run: ExamRunner | null;
  /** 渲染工具当前的模型，召回按它筛选限定了模型的经验；为 null 时视为未知。 */
  modelOf?: ((renderer: string) => string) | null;
  /**
   * 要重考的生效、停用或被拒经验名：对照组去掉它们、试用组按真实条件召回。模型换了以后，
   * 旧考试的结论不再可信，见 StatusReport.retest。通过时补记考试编号，不通过时
   * 状态不变、只在结果里写明；停用或被拒经验通过后恢复生效并生成快照。
   */
  retest?: string[] | null;
  /**
   * 在作答通过产物校验后补跑事后检查（空白帧、阅读时间），只跑试用经验
   * 引用到的那几个；需要补查的考试未提供此回调时，在渲染前报错。
   */
  postCheck?: PostCheck | null;
  /** 为 true 时只出结果，不改记忆状态。 */
  dryRun?: boolean;
  signal?: AbortSignal;
}

/** 一场考试的完整记录，写进 exams/<id>/result.json。 */
export interface ExamResult {
  id: string;
  created_at: string;
  trials: string[] | null;
  renderers: string[] | null;
  questions: Question[] | null;
  cells: Cell[] | null;
  verdict: Verdict;
  snapshot_before: number;
  /** 考试结果怎样落到记忆状态上：promoted、rejected、retest-passed、retest-failed 或 none。 */
  applied: string;
  snapshot: number;
}

/** 进度与最终成绩分开保存：未交卷的格子不能参与判分或改变记忆状态。 */
export interface ExamProgress {
  id: string;
  pid: number;
  created_at: string;
  updated_at: string;
  workspace: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  trials: { name: string; description: string; checks: string[] }[];
  questions: (Question & { text: string })[];
  cells: {
    question: string;
    renderer: string;
    arm: Arm;
    repeat: number;
    status: 'queued' | 'running' | 'completed' | 'cancelled';
    started_at?: string;
    finished_at?: string;
    result?: Cell;
  }[];
}

export function examProgressToJSON(p: ExamProgress): Record<string, unknown> {
  return { ...p, cells: p.cells.map((c) => ({ ...c, result: c.result ? cellToJSON(c.result) : undefined })) };
}

export function examResultToJSON(r: ExamResult): Record<string, unknown> {
  return {
    id: r.id,
    created_at: r.created_at,
    trials: r.trials,
    renderers: r.renderers,
    questions: r.questions === null ? null : r.questions.map(questionToJSON),
    cells: r.cells === null ? null : r.cells.map(cellToJSON),
    verdict: verdictToJSON(r.verdict),
    snapshot_before: r.snapshot_before,
    applied: r.applied,
    snapshot: r.snapshot || undefined,
  };
}

/**
 * 一条需要重考的生效经验：它通过考试时某个渲染工具用的模型，
 * 与那个渲染工具现在的模型不一样了。
 */
export interface Retest {
  name: string;
  renderer: string;
  examined_models: string[];
  current_model: string;
}
