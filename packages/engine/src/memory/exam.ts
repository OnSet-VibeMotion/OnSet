import fs from 'node:fs';
import path from 'node:path';
import { formatFixed } from '../gofmt';
import { compareBytes } from '../gojson';
import {
  CheckFramesBlank,
  ReadsCheckPrefix,
  load as loadScene,
  OutcomeFailed,
  OutcomeSucceeded,
  OutcomeVerificationFailed,
  processAlive,
  type Attempt,
  type Scene,
} from '../scene';
import { usageJSON, type Usage } from '../tools';
import type { Finding } from './checks';
import { episodeByID, freezeInput, projectOf, SourceExam } from './episode';
import { EventDormant, EventExam, EventPromote, EventReject } from './events';
import { ReadsExamNote, readsChecks } from './examreads';
import { CheckerAudition, examinableLesson, features as sceneFeatures, promptText } from './features';
import { rfc3339 } from './gostr';
import { copyTree, isNotExist, readDirSorted, readJSON, writeJSON } from './io';
import { appliesInScope, cloneMemory, KindLesson, StatusActive, StatusDormant, StatusRejected, StatusTrial, type Memory, type Status } from './memory';
import { attachRecall, recall, recallNames, type RecallOptions, type RecallResult } from './recall';
import type { Snapshot } from './snapshot';
import type { Store } from './store';
import { contains, omitEmpty } from './util';

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
  /** 为 true 时生效记忆变过或待考经验未实际召回，保留原状态，需核实后重考或人工确认。 */
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

function cellKey(question: string, renderer: string, arm: Arm): string {
  return JSON.stringify([question, renderer, arm]);
}

/**
 * 考试门槛，纯函数：
 *
 *  1. 矩阵总分严格高于对照；
 *  2. 任意一个渲染工具上，对照组答对的题，试用组都没有答错；
 *  3. 留出题上任意一个渲染工具的一次通过数都不下降；
 *  4. 所有格子都有有效结果，渲染工具自身故障使整场考试无效；
 *  5. 考试期间生效记忆没有被改动过，否则转为待人工确认。
 *  6. 两组逐次唯一配对、实际模型相同，否则整场无效。
 *  7. 每条待考经验都实际出现在至少一对试用组中，否则保留原状态。
 *
 * 重复多次的格子按多数结果判定通过，得分取平均。
 */
export function judge(questions: readonly Question[], renderers: readonly string[], cells: readonly Cell[], activeChanged: boolean, trials: readonly string[] = []): Verdict {
  const v: Verdict = { pass: false, invalid: false, needs_human: false, control_score: 0, trial_score: 0, reasons: [] };
  const grouped = new Map<string, Cell[]>();
  for (const c of cells) {
    const k = cellKey(c.question, c.renderer, c.arm);
    grouped.set(k, [...(grouped.get(k) ?? []), c]);
    if (c.invalid) {
      v.invalid = true;
      v.reasons.push(`${c.question} × ${c.renderer} × ${c.arm} 渲染工具自身故障：${c.error}`);
    }
  }
  const passed = (k: string): boolean => {
    const list = grouped.get(k) ?? [];
    return list.filter((c) => c.passed).length * 2 > list.length;
  };
  const score = (k: string): number => {
    const list = grouped.get(k) ?? [];
    let total = 0;
    for (const c of list) total += cellScore(c);
    return total / list.length;
  };
  for (const q of questions) {
    for (const r of renderers) {
      for (const arm of [ArmControl, ArmTrial]) {
        if ((grouped.get(cellKey(q.id, r, arm))?.length ?? 0) === 0) {
          v.invalid = true;
          v.reasons.push(`${q.id} × ${r} × ${arm} 没有结果`);
        }
      }
      const control = grouped.get(cellKey(q.id, r, ArmControl)) ?? [];
      const trial = grouped.get(cellKey(q.id, r, ArmTrial)) ?? [];
      const repeats = new Set([...control, ...trial].map((c) => c.repeat));
      for (const repeat of repeats) {
        const a = control.filter((c) => c.repeat === repeat);
        const b = trial.filter((c) => c.repeat === repeat);
        if (a.length !== 1 || b.length !== 1) {
          v.invalid = true;
          v.reasons.push(`${q.id} × ${r} × 第 ${repeat} 次没有唯一配对的两组结果`);
        } else if (a[0].model !== b[0].model) {
          v.invalid = true;
          v.reasons.push(`${q.id} × ${r} × 第 ${repeat} 次两组模型不一致，不能把模型变化算成记忆效果`);
        }
      }
    }
  }
  if (v.invalid) return v;
  for (const q of questions) {
    for (const r of renderers) {
      const control = cellKey(q.id, r, ArmControl);
      const trial = cellKey(q.id, r, ArmTrial);
      v.control_score += score(control);
      v.trial_score += score(trial);
      if (passed(control) && !passed(trial)) v.reasons.push(`退步：${q.id} 在 ${r} 上对照组通过、试用组失败`);
    }
  }
  for (const r of renderers) {
    let controlPass = 0;
    let trialPass = 0;
    for (const q of questions) {
      if (!q.holdout) continue;
      if (passed(cellKey(q.id, r, ArmControl))) controlPass++;
      if (passed(cellKey(q.id, r, ArmTrial))) trialPass++;
    }
    if (trialPass < controlPass) v.reasons.push(`留出题退步：${r} 上一次通过数 ${controlPass} → ${trialPass}`);
  }
  if (v.trial_score <= v.control_score) {
    v.reasons.push(`总分没有提高：对照 ${formatFixed(v.control_score, 1)}，试用 ${formatFixed(v.trial_score, 1)}`);
  }
  if (activeChanged) {
    v.needs_human = true;
    v.reasons.push('考试期间生效记忆被改动过，结果转为待人工确认');
  }
  // 多条合考仍受真实召回预算与条数限制，未被注入的经验不能随整组通过而生效。
  // 这是缺少证据，保留试用，而不是把经验判为有害。
  for (const name of trials) {
    const exposed = cells.some((c) => c.arm === ArmTrial && contains(c.recalled, name) &&
      cells.some((a) => a.question === c.question && a.renderer === c.renderer && a.repeat === c.repeat &&
        a.arm === ArmControl && !contains(a.recalled, name)));
    if (!exposed) {
      v.needs_human = true;
      v.reasons.push(`${name} 没有在配对试用组中实际召回，证据不足；请单独考试或检查适用条件与召回预算`);
    }
  }
  v.pass = v.reasons.length === 0;
  return v;
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
   * 要重考的生效经验名：对照组去掉它们、试用组照常带上。模型换了以后，
   * 旧考试的结论不再可信，见 StatusReport.retest。通过时补记考试编号，不通过时
   * 状态不变、只在结果里写明，是否沉睡或限定范围由人决定。
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
    question: string; renderer: string; arm: Arm; repeat: number;
    status: 'queued' | 'running' | 'completed' | 'cancelled';
    started_at?: string; finished_at?: string; result?: Cell;
  }[];
}

export function examProgressToJSON(p: ExamProgress): Record<string, unknown> {
  return { ...p, cells: p.cells.map((c) => ({ ...c, result: c.result ? cellToJSON(c.result) : undefined })) };
}

/** 旧版本只有 result.json；不把缺少进度的旧考试推测为仍在运行。 */
export function examProgress(s: Store): ExamProgress[] {
  const rows: ExamProgress[] = [];
  for (const entry of readDirSorted(path.join(s.dir, 'exams')) ?? []) {
    if (!entry.isDirectory()) continue;
    try {
      const p = readJSON(path.join(s.dir, 'exams', entry.name, 'progress.json')) as ExamProgress;
      if (p.id === entry.name && Array.isArray(p.cells) && Array.isArray(p.questions)) {
        if (p.status === 'running' && p.pid > 0 && !processAlive(p.pid)) {
          p.status = 'failed';
          p.error = '考试进程已退出，未生成最终成绩；记忆是否生效以最终成绩为准';
          for (const c of p.cells) if (c.status === 'queued' || c.status === 'running') c.status = 'cancelled';
        }
        rows.push(p);
      }
    } catch { /* 未安装此功能的历史考试或未写完的进度不影响成绩读取。 */ }
  }
  return rows;
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

function strList(v: unknown): string[] | null {
  return Array.isArray(v) ? v.map((x) => String(x)) : null;
}

function parseExamResult(raw: unknown): ExamResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const verdict = (o.verdict ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    created_at: String(o.created_at ?? ''),
    trials: strList(o.trials),
    renderers: strList(o.renderers),
    questions: Array.isArray(o.questions)
      ? (o.questions as Array<Record<string, unknown>>).map((q) => ({
          id: String(q?.id ?? ''),
          episode: String(q?.episode ?? ''),
          holdout: q?.holdout === true,
          scene_id: String(q?.scene_id ?? ''),
          input: String(q?.input ?? ''),
        }))
      : null,
    cells: Array.isArray(o.cells)
      ? (o.cells as Array<Record<string, unknown>>).map((c) =>
          newCell({
            question: String(c?.question ?? ''),
            holdout: c?.holdout === true,
            renderer: String(c?.renderer ?? ''),
            model: String(c?.model ?? ''),
            arm: String(c?.arm ?? ''),
            repeat: Number(c?.repeat ?? 0),
            outcome: String(c?.outcome ?? ''),
            passed: c?.passed === true,
            problems: Number(c?.problems ?? 0),
            checks: strList(c?.checks),
            seconds: Number(c?.seconds ?? 0),
            usage: (c?.usage as Usage | undefined) ?? null,
            error: String(c?.error ?? ''),
            invalid: c?.invalid === true,
            recalled: strList(c?.recalled),
            episode: String(c?.episode ?? ''),
            workdir: String(c?.workdir ?? ''),
          }),
        )
      : null,
    verdict: {
      pass: verdict.pass === true,
      invalid: verdict.invalid === true,
      needs_human: verdict.needs_human === true,
      control_score: Number(verdict.control_score ?? 0),
      trial_score: Number(verdict.trial_score ?? 0),
      reasons: strList(verdict.reasons) ?? [],
    },
    snapshot_before: Number(o.snapshot_before ?? 0),
    applied: String(o.applied ?? ''),
    snapshot: Number(o.snapshot ?? 0),
  };
}

function nextExamID(s: Store): string {
  const entries = readDirSorted(path.join(s.dir, 'exams')) ?? [];
  let number = entries.length + 1;
  for (;;) {
    const id = `exam-${String(number).padStart(4, '0')}`;
    const dir = path.join(s.dir, 'exams', id);
    try {
      fs.statSync(dir);
    } catch (err) {
      if (isNotExist(err)) {
        fs.mkdirSync(dir, { recursive: true });
        return id;
      }
    }
    number++;
  }
}

/** 读出全部考试记录，按编号升序。 */
export function exams(s: Store): ExamResult[] {
  const out: ExamResult[] = [];
  for (const entry of readDirSorted(path.join(s.dir, 'exams')) ?? []) {
    let raw: unknown;
    try {
      raw = readJSON(path.join(s.dir, 'exams', entry.name, 'result.json'));
    } catch {
      continue;
    }
    out.push(parseExamResult(raw));
  }
  return out.sort((a, b) => compareBytes(a.id, b.id));
}

/** 失败时抛出的错误带 result 属性：Go 版返回的部分结果。 */
function withResult(err: unknown, result: ExamResult): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  return Object.assign(e, { result });
}

/**
 * 调度考试矩阵：考题 × 渲染工具 × {对照, 试用} × 重复次数，按门槛判定，
 * 通过则试用记忆转为生效并生成快照，不通过则记为被拒。
 */
export async function exam(s: Store, opts: ExamOptions): Promise<ExamResult> {
  if (opts.renderers.length === 0) throw new Error('至少要有一个渲染工具');
  const run = opts.run;
  if (!run) throw new Error('没有配置作答者');
  const repeat = opts.repeat && opts.repeat >= 1 ? opts.repeat : 1;
  const jobs = opts.jobs && opts.jobs >= 1 ? opts.jobs : 1;
  const maxQuestions = opts.maxQuestions && opts.maxQuestions >= 1 ? opts.maxQuestions : 4;
  const retest = opts.retest ?? [];
  const trialNames = opts.trial ?? [];
  const all = s.memories().memories;
  const trials: Memory[] = [];
  for (const name of retest) {
    const m = all.find((x) => x.name === name);
    if (!m || m.status !== StatusActive || m.kind !== KindLesson) throw new Error(`${name} 不是生效中的经验，不能重考`);
    if (!examinableLesson(m)) throw new Error(`${name} 只由相邻镜头的交接判定，考不了`);
    trials.push(m);
  }
  if (retest.length === 0) {
    for (const m of all) {
      if (m.status !== StatusTrial || m.kind !== KindLesson) continue;
      if (trialNames.length > 0 && !trialNames.includes(m.name)) continue;
      if (!examinableLesson(m)) {
        if (trialNames.length > 0) {
          if ((m.checked_by ?? []).includes(CheckerAudition)) throw new Error(`${m.name} 由你在试镜里判定，机器考不了；用人评考试决定它留不留`);
          throw new Error(`${m.name} 只由相邻镜头的交接（${(m.checked_by ?? []).join('、')}）判定，单镜头回放考不了；确认有效后用 memory_promote() 生效`);
        }
        continue;
      }
      trials.push(m);
    }
  }
  for (const name of trialNames) {
    if (!trials.some((m) => m.name === name)) throw new Error(`${name} 不是试用中的经验（偏好不参加考试，由人工确认）`);
  }
  if (trials.length === 0) {
    throw new Error('没有能考的试用经验；先运行 memory_consolidate()。只由相邻镜头的交接判定的经验考不了，用 memory_promote() 人工确认');
  }
  const questions = examQuestions(s, trials, opts.episodes ?? [], opts.holdout ?? [], maxQuestions);
  if (questions.length === 0) throw new Error('没有考题：试用记忆的来源经历都没有冻结输入，也没有给 --holdout');
  const requiredPost = postChecks(trials);
  if (requiredPost.length > 0 && !opts.postCheck) throw new Error(`考试缺少事后检查：${requiredPost.join('、')}；不能用产物校验代替这些检查`);
  const before = s.latestSnapshot();
  const beforeID = before?.id ?? 0;
  const driftBefore = s.drift();
  const id = nextExamID(s);
  const result: ExamResult = {
    id,
    created_at: rfc3339(s.clock()),
    trials: trials.map((m) => m.name),
    renderers: opts.renderers,
    questions,
    cells: null,
    verdict: { pass: false, invalid: false, needs_human: false, control_score: 0, trial_score: 0, reasons: [] },
    snapshot_before: beforeID,
    applied: 'none',
    snapshot: 0,
  };
  interface Job {
    q: Question;
    renderer: string;
    arm: Arm;
    repeat: number;
  }
  const list: Job[] = [];
  for (const q of questions) {
    for (const r of opts.renderers) {
      for (const arm of [ArmControl, ArmTrial]) {
        for (let rep = 1; rep <= repeat; rep++) list.push({ q, renderer: r, arm, repeat: rep });
      }
    }
  }
  const cells: Cell[] = new Array(list.length);
  const progress: ExamProgress = {
    id, pid: process.pid, created_at: result.created_at, updated_at: result.created_at,
    workspace: opts.workspace, status: 'running',
    trials: trials.map((m) => ({ name: m.name, description: m.description, checks: m.checked_by ?? [] })),
    questions: questions.map((q) => {
      let text = '';
      try { text = loadScene(q.input).text; } catch { /* 作答时报告输入错误。 */ }
      return { ...q, text };
    }),
    cells: list.map((j) => ({ question: j.q.id, renderer: j.renderer, arm: j.arm, repeat: j.repeat, status: 'queued' })),
  };
  const saveProgress = () => {
    progress.updated_at = rfc3339(s.clock());
    writeJSON(path.join(s.dir, 'exams', id, 'progress.json'), examProgressToJSON(progress));
  };
  saveProgress();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < list.length && !opts.signal?.aborted) {
      const i = next++;
      const j = list[i];
      const workdir = path.join(opts.workspace, id, j.q.id, `${j.renderer}-${j.arm}-${j.repeat}`);
      progress.cells[i].status = 'running';
      progress.cells[i].started_at = rfc3339(s.clock());
      saveProgress();
      try {
        cells[i] = await examCell(s, j.q, j.renderer, j.arm, j.repeat, workdir, trials, beforeID, opts, run, id);
      } catch (err) {
        // 作答者或补查抛错也是基础设施故障；等其他格子收尾后整场判无效。
        cells[i] = newCell({ question: j.q.id, holdout: j.q.holdout, renderer: j.renderer, arm: j.arm,
          repeat: j.repeat, workdir, invalid: true, outcome: OutcomeFailed, error: err instanceof Error ? err.message : String(err) });
      }
      progress.cells[i].status = 'completed';
      progress.cells[i].finished_at = rfc3339(s.clock());
      progress.cells[i].result = cells[i];
      saveProgress();
    }
  };
  try {
    const workers = await Promise.allSettled(Array.from({ length: Math.min(jobs, list.length) }, () => worker()));
    const failed = workers.find((w) => w.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    result.cells = cells.filter(Boolean);
    if (opts.signal?.aborted) throw new Error('考试已取消，未改变记忆状态');
    const after = s.latestSnapshot();
    const driftAfter = s.drift();
    const changed = (after?.id ?? 0) !== beforeID || (driftAfter ?? []).join(',') !== (driftBefore ?? []).join(',');
    result.verdict = judge(questions, opts.renderers, cells, changed, trials.map((m) => m.name));
    if (retest.length > 0 && !opts.dryRun && !result.verdict.invalid && !result.verdict.needs_human) {
      result.applied = 'retest-failed';
      if (result.verdict.pass) {
        result.applied = 'retest-passed';
        for (const m of trials) setStatus(s, m, StatusActive, '', id);
      }
    } else if (!opts.dryRun && !result.verdict.invalid && !result.verdict.needs_human) {
      if (result.verdict.pass) {
        const snapshot = promoteList(s, trials, id);
        result.applied = 'promoted';
        result.snapshot = snapshot.id;
      } else {
        const reason = `${id} 未通过：${result.verdict.reasons.join('；')}`;
        for (const m of trials) setStatus(s, m, StatusRejected, reason, '');
        result.applied = 'rejected';
      }
    }
    writeJSON(path.join(s.dir, 'exams', id, 'result.json'), examResultToJSON(result));
    let state = '通过';
    if (result.verdict.invalid) state = '无效';
    else if (result.verdict.needs_human) state = '待人工确认';
    else if (!result.verdict.pass) state = '未通过';
    s.log({
      time: '',
      type: EventExam,
      snapshot: result.snapshot,
      summary: `考试 ${id} ${state}：${questions.length} 道题 × ${opts.renderers.length} 个渲染工具，对照 ${formatFixed(result.verdict.control_score, 1)} 分，试用 ${formatFixed(result.verdict.trial_score, 1)} 分`,
      detail: { exam: id, trials: result.trials, verdict: verdictToJSON(result.verdict), applied: result.applied },
    });
    progress.status = 'completed';
    saveProgress();
  } catch (err) {
    progress.status = opts.signal?.aborted ? 'cancelled' : 'failed';
    progress.error = err instanceof Error ? err.message : String(err);
    for (const c of progress.cells) if (c.status === 'queued') c.status = 'cancelled';
    saveProgress();
    throw withResult(err, result);
  }
  return result;
}

function examQuestions(s: Store, trials: readonly Memory[], episodes: readonly string[], holdout: readonly string[], maxQuestions: number): Question[] {
  const ids = [...episodes];
  if (ids.length === 0) {
    for (const m of trials) {
      for (const id of m.from_episodes) if (!ids.includes(id)) ids.push(id);
    }
  }
  const questions: Question[] = [];
  for (const id of ids) {
    if (questions.length >= maxQuestions) break;
    const episode = episodeByID(s, id);
    if (episode.input === '') continue;
    questions.push({
      id: `q${questions.length + 1}`,
      episode: id,
      holdout: false,
      scene_id: episode.scene_id,
      input: path.join(episode.dir, episode.input),
    });
  }
  holdout.forEach((dir, i) => {
    let sc: Scene;
    try {
      sc = loadScene(dir);
    } catch (err) {
      throw new Error(`留出题 ${dir}：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    questions.push({ id: `h${i + 1}`, episode: '', holdout: true, scene_id: sc.id, input: sc.directory });
  });
  return questions;
}

async function examCell(
  s: Store,
  q: Question,
  renderer: string,
  arm: Arm,
  repeat: number,
  workdir: string,
  trials: readonly Memory[],
  snapshot: number,
  opts: ExamOptions,
  run: ExamRunner,
  examID: string,
): Promise<Cell> {
  const cell = newCell({ question: q.id, holdout: q.holdout, renderer, arm, repeat, workdir });
  const fail = (err: unknown): Cell => {
    cell.invalid = true;
    cell.outcome = OutcomeFailed;
    cell.error = err instanceof Error ? err.message : String(err);
    return cell;
  };
  let sc: Scene;
  let recalled: RecallResult;
  try {
    fs.rmSync(workdir, { recursive: true, force: true });
    if (q.holdout) freezeInput(loadScene(q.input), workdir);
    else copyTree(q.input, workdir);
    sc = loadScene(workdir);
    sc.renderer = renderer;
    const recallOpts: RecallOptions = { snapshot, budget: opts.budget, renderer };
    if (opts.modelOf) recallOpts.model = opts.modelOf(renderer);
    if (snapshot === 0) recallOpts.snapshot = -1;
    const retest = opts.retest ?? [];
    if (retest.length > 0 && arm === ArmControl) recallOpts.exclude = retest;
    else if (retest.length === 0 && arm === ArmTrial) recallOpts.extra = trials;
    recalled = recallForExam(s, sc, recallOpts);
  } catch (err) {
    return fail(err);
  }
  sc = attachRecall(recalled, sc);
  cell.recalled = recallNames(recalled);
  const post = postChecks(trials);
  // 要补查阅读时间时，两组都被要求交出本镜头的可读元素清单。
  if (opts.postCheck && readsChecks(post).length > 0) sc = { ...sc, examNote: ReadsExamNote };
  const attempt: Attempt = { ...(await run(sc, renderer, opts.signal)) };
  if (attempt.outcome === OutcomeSucceeded && post.length > 0 && opts.postCheck) {
    const findings = await opts.postCheck(sc, post, opts.signal);
    if (findings.length > 0) {
      attempt.outcome = OutcomeVerificationFailed;
      attempt.checks = [...(attempt.checks ?? []), ...findings.map((f) => f.check)];
      attempt.problems = [...(attempt.problems ?? []), ...findings.map((f) => f.problem)];
    }
  }
  cell.outcome = attempt.outcome;
  cell.seconds = attempt.seconds;
  cell.usage = attempt.usage;
  cell.error = attempt.error;
  cell.model = attempt.model;
  cell.problems = attempt.problems?.length ?? 0;
  cell.checks = attempt.checks;
  if (attempt.outcome === OutcomeSucceeded) cell.passed = true;
  else if (attempt.outcome !== OutcomeVerificationFailed) cell.invalid = true;
  try {
    cell.episode = s.recordAttempt(sc, attempt, { source: SourceExam, exam: examID }).id;
  } catch {
    // 记不下经历不影响这一格的结果。
  }
  return cell;
}

/**
 * 与 recallScene 相同，只是 snapshot 为 -1 时表示「没有快照」，
 * 不回落到最新快照：考试开始时还没有快照，考试期间生成的快照不能混进对照组。
 */
function recallForExam(s: Store, sc: Scene, opts: RecallOptions): RecallResult {
  if ((opts.snapshot ?? 0) >= 0) return s.recallScene(sc, opts);
  // 还没有快照：只有试用记忆参与召回，重考不会走到这里（生效记忆必然在快照里）。
  return recall({
    memories: opts.extra ?? [],
    stats: {},
    renderer: opts.renderer ?? '',
    model: opts.model ?? '',
    features: sceneFeatures(sc),
    text: sc.text + '\n' + promptText(sc),
    project: projectOf(sc.directory),
    budget: opts.budget,
    maxLessons: opts.maxLessons ?? 0,
  });
}

/**
 * 人评考试（audition 包）通过：把这几条试用经验转为生效，考试编号记进 verified_by，快照不标「未经考试」。
 */
export function promoteExamined(s: Store, names: readonly string[], examID: string): Snapshot {
  if (examID === '') throw new Error('人评考试要有编号');
  const list: Memory[] = [];
  for (const name of names) {
    const m = s.find(name);
    if (m === null || m.status !== StatusTrial) throw new Error(`${name} 不是试用中的记忆`);
    list.push(m);
  }
  return promoteList(s, list, examID);
}

/** 把试用记忆转为生效并生成快照；修订生效时被修订的旧记忆转为沉睡。 */
function promoteList(s: Store, list: readonly Memory[], examID: string): Snapshot {
  const names: string[] = [];
  for (const m of list) {
    setStatus(s, m, StatusActive, '', examID);
    names.push(m.name);
    if (m.revises !== '') {
      const old = s.find(m.revises);
      if (old !== null && old.status === StatusActive) {
        setStatus(s, old, StatusDormant, '', '');
        s.log({
          time: '',
          type: EventDormant,
          summary: `${old.name} 被修订 ${m.name} 取代，转为沉睡`,
          detail: { memory: old.name, replaced_by: m.name },
        });
      }
    }
  }
  const unverified = examID === '';
  let summary = '生效：' + names.join('、');
  summary += examID !== '' ? '（' + examID + ' 通过）' : '（人工确认，未经考试）';
  const snapshot = s.takeSnapshot(EventPromote, summary, unverified);
  s.log({ time: '', type: EventPromote, snapshot: snapshot.id, summary, detail: { memories: names.length > 0 ? names : null, exam: examID } });
  return snapshot;
}

/** 改一条记忆的状态并写回（不改调用方手里的那份）。 */
export function setStatus(s: Store, original: Memory, status: Status, reason: string, examID: string): void {
  const m = cloneMemory(original);
  m.status = status;
  if (status === StatusRejected) m.rejected_reason = reason;
  if (examID !== '' && !m.verified_by.includes(examID)) m.verified_by = [...m.verified_by, examID];
  s.write(m);
  if (status === StatusRejected) {
    s.log({ time: '', type: EventReject, summary: `${m.name} 被拒：${reason}`, detail: { memory: m.name } });
  }
}

/**
 * 人工确认一条试用记忆生效（偏好只能走这里；经验通常由考试转为生效，
 * 人工确认的快照会标为未经考试）。
 */
export function promote(s: Store, name: string): Snapshot {
  const m = s.find(name);
  if (m === null) throw new Error(`记忆 ${name} 不存在`);
  if (m.status !== StatusTrial) throw new Error(`${name} 的状态是 ${m.status}，只有试用中的记忆能确认生效`);
  return promoteList(s, [m], '');
}

/** 人工拒绝一条试用记忆。 */
export function reject(s: Store, name: string, reason: string): void {
  const m = s.find(name);
  if (m === null) throw new Error(`记忆 ${name} 不存在`);
  if (m.status !== StatusTrial) throw new Error(`${name} 的状态是 ${m.status}，只有试用中的记忆能拒绝`);
  setStatus(s, m, StatusRejected, reason === '' ? '人工拒绝' : reason, '');
}

/** 让一条生效记忆转为沉睡，并生成快照。 */
export function retire(s: Store, name: string, reason: string): Snapshot {
  const m = s.find(name);
  if (m === null) throw new Error(`记忆 ${name} 不存在`);
  if (m.status !== StatusActive) throw new Error(`${name} 的状态是 ${m.status}，只有生效记忆能转为沉睡`);
  setStatus(s, m, StatusDormant, '', '');
  s.log({ time: '', type: EventDormant, summary: `${name} 转为沉睡：${reason === '' ? '人工确认' : reason}`, detail: { memory: name } });
  return s.takeSnapshot(EventDormant, name + ' 转为沉睡', false);
}

/**
 * 试用经验引用的、要在作答后补跑的校验器：能在单镜头里判定，
 * 又不在渲染时的产物校验里。
 */
function postChecks(trials: readonly Memory[]): string[] {
  const out: string[] = [];
  for (const m of trials) {
    for (const id of m.checked_by ?? []) {
      if ((id === CheckFramesBlank || id.startsWith(ReadsCheckPrefix)) && !out.includes(id)) out.push(id);
    }
  }
  return out;
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

/**
 * 找出模型换过之后需要重考的生效经验。currentModel 为 null 或
 * 返回空串（模型未知）时不判定。考试里没记下模型的格子也不判定：说不清当时是谁。
 * 没有时返回 null。
 */
export function retestNeeded(s: Store, currentModel: ((renderer: string) => string) | null): Retest[] | null {
  if (currentModel === null) return null;
  const all = s.memories().memories;
  const byID = new Map<string, ExamResult>();
  for (const result of exams(s)) byID.set(result.id, result);
  const out: Retest[] = [];
  for (const m of all) {
    if (m.status !== StatusActive || m.kind !== KindLesson || m.verified_by.length === 0) continue;
    const examined = new Map<string, string[]>();
    for (const id of m.verified_by) {
      for (const cell of byID.get(id)?.cells ?? []) {
        if (cell.arm === ArmTrial && cell.model !== '' && !contains(examined.get(cell.renderer), cell.model)) {
          examined.set(cell.renderer, [...(examined.get(cell.renderer) ?? []), cell.model]);
        }
      }
    }
    for (const renderer of [...examined.keys()].sort(compareBytes)) {
      const current = currentModel(renderer);
      const models = examined.get(renderer)!;
      if (current !== '' && !models.includes(current) && appliesInScope(m.applies_when, renderer, current)) {
        out.push({ name: m.name, renderer, examined_models: models, current_model: current });
      }
    }
  }
  return out.length > 0 ? out : null;
}
