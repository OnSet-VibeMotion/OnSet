import path from 'node:path';
import { formatFixed } from '../gofmt';
import { compareBytes } from '../gojson';
import { load as loadScene, OutcomeFailed } from '../scene';
import { EventExam } from './events';
import { examProgress, exams, judge, nextExamID, retestNeeded } from './exam_grade';
import { promote, promoteExamined, promoteList, reject, retire, setStatus } from './exam_lifecycle';
import {
  type Arm,
  ArmControl,
  ArmTrial,
  type Cell,
  cellScore,
  cellToJSON,
  type ExamOptions,
  type ExamProgress,
  type ExamResult,
  type ExamRunner,
  examProgressToJSON,
  examResultToJSON,
  newCell,
  type PostCheck,
  type Question,
  questionToJSON,
  type Retest,
  type Verdict,
  verdictToJSON,
} from './exam_model';
import { examCell, examQuestions, postChecks } from './exam_runner';
import { CheckerAudition, examinableLesson } from './features';
import { rfc3339 } from './gostr';
import { writeJSON } from './io';
import {
  KindLesson,
  type Memory,
  ruleDigest,
  StatusActive,
  StatusDormant,
  StatusRejected,
  StatusTrial,
} from './memory';
import type { Store } from './store';

export type { Arm, Cell, ExamOptions, ExamProgress, ExamResult, ExamRunner, PostCheck, Question, Retest, Verdict };
export {
  ArmControl,
  ArmTrial,
  cellScore,
  cellToJSON,
  examProgress,
  examProgressToJSON,
  examResultToJSON,
  exams,
  judge,
  newCell,
  promote,
  promoteExamined,
  questionToJSON,
  reject,
  retestNeeded,
  retire,
  setStatus,
  verdictToJSON,
};

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
  if (retest.length > 0 && trialNames.length > 0) throw new Error('试用考试与经验重考不能同时指定');
  const all = s.memories().memories;
  const trials: Memory[] = [];
  for (const name of retest) {
    const m = all.find((x) => x.name === name);
    if (!m || ![StatusActive, StatusDormant, StatusRejected].includes(m.status) || m.kind !== KindLesson) {
      throw new Error(`${name} 不是生效、停用或被拒的经验，不能重考`);
    }
    if (!examinableLesson(m)) throw new Error(`${name} 只由相邻镜头的交接判定，考不了`);
    trials.push(m);
  }
  if (retest.length === 0) {
    for (const m of all) {
      if (m.status !== StatusTrial || m.kind !== KindLesson) continue;
      if (trialNames.length > 0 && !trialNames.includes(m.name)) continue;
      if (!examinableLesson(m)) {
        if (trialNames.length > 0) {
          if ((m.checked_by ?? []).includes(CheckerAudition))
            throw new Error(`${m.name} 由你在试镜里判定，机器考不了；用人评考试决定它留不留`);
          throw new Error(
            `${m.name} 只由相邻镜头的交接（${(m.checked_by ?? []).join('、')}）判定，单镜头回放考不了；确认有效后用 memory_promote() 生效`,
          );
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
    throw new Error(
      '没有能考的试用经验；先运行 memory_consolidate()。只由相邻镜头的交接判定的经验考不了，用 memory_promote() 人工确认',
    );
  }
  if (opts.holdoutOnly && (opts.holdout?.length ?? 0) === 0) throw new Error('仅验证新镜头时必须提供留出镜头');
  if (opts.holdoutOnly && (opts.episodes?.length ?? 0) > 0) throw new Error('仅验证新镜头不能同时指定来源旧题');
  const questions = examQuestions(
    s,
    trials,
    opts.episodes ?? [],
    opts.holdout ?? [],
    maxQuestions,
    opts.holdoutOnly ?? false,
  );
  if (questions.length === 0) throw new Error('没有考题：试用记忆的来源经历都没有冻结输入，也没有给 --holdout');
  const requiredPost = postChecks(trials);
  if (requiredPost.length > 0 && !opts.postCheck) {
    throw new Error(`考试缺少事后检查：${requiredPost.join('、')}；不能用产物校验代替这些检查`);
  }
  const before = s.latestSnapshot();
  const beforeID = before?.id ?? 0;
  // 比较实际规则摘要，而不是“哪些文件偏离快照”的名字列表：同一脏文件再次改正文
  // 仍须被发现；只追加来源或验证编号则不会改变渲染器收到的规则。
  const activeRules = () =>
    s
      .memories()
      .memories.filter((m) => m.status === StatusActive)
      .map((m) => m.name + '=' + ruleDigest(m))
      .sort(compareBytes)
      .join('\n');
  const rulesBefore = activeRules();
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
    id,
    pid: process.pid,
    created_at: result.created_at,
    updated_at: result.created_at,
    workspace: opts.workspace,
    status: 'running',
    trials: trials.map((m) => ({ name: m.name, description: m.description, checks: m.checked_by ?? [] })),
    questions: questions.map((q) => {
      let text = '';
      try {
        text = loadScene(q.input).text;
      } catch {
        /* 作答时报告输入错误。 */
      }
      return { ...q, text };
    }),
    cells: list.map((j) => ({
      question: j.q.id,
      renderer: j.renderer,
      arm: j.arm,
      repeat: j.repeat,
      status: 'queued',
    })),
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
        cells[i] = newCell({
          question: j.q.id,
          holdout: j.q.holdout,
          renderer: j.renderer,
          arm: j.arm,
          repeat: j.repeat,
          workdir,
          invalid: true,
          outcome: OutcomeFailed,
          error: err instanceof Error ? err.message : String(err),
        });
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
    const changed = (after?.id ?? 0) !== beforeID || activeRules() !== rulesBefore;
    result.verdict = judge(
      questions,
      opts.renderers,
      cells,
      changed,
      trials.map((m) => m.name),
    );
    if (retest.length > 0 && !opts.dryRun && !result.verdict.invalid && !result.verdict.needs_human) {
      result.applied = 'retest-failed';
      if (result.verdict.pass) {
        result.applied = 'retest-passed';
        const inactive = trials.filter((m) => m.status !== StatusActive);
        for (const m of trials.filter((m) => m.status === StatusActive)) setStatus(s, m, StatusActive, '', id);
        if (inactive.length > 0) {
          result.snapshot = promoteList(s, inactive, id).id;
          result.applied = 'promoted';
        } else {
          // 验证编号也属于快照内容；正式记录这次证据，避免合法重考留下永久文件漂移。
          result.snapshot = s.takeSnapshot(EventExam, `重考 ${id} 通过：更新验证出处`, before?.unverified ?? false).id;
        }
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
