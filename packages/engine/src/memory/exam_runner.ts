import fs from 'node:fs';
import path from 'node:path';
import {
  type Attempt,
  CheckFramesBlank,
  load as loadScene,
  OutcomeFailed,
  OutcomeSucceeded,
  OutcomeVerificationFailed,
  ReadsCheckPrefix,
  type Scene,
} from '../scene';
import { episodeByID, freezeInput, projectOf, SourceExam } from './episode';
import {
  type Arm,
  ArmControl,
  ArmTrial,
  type Cell,
  type ExamOptions,
  type ExamRunner,
  newCell,
  type Question,
} from './exam_model';
import { readsChecks, readsExamNote } from './examreads';
import { promptText, features as sceneFeatures } from './features';
import { copyTree } from './io';
import { type Memory, StatusActive } from './memory';
import { attachRecall, type RecallOptions, type RecallResult, recall, recallNames } from './recall';
import type { Store } from './store';

export function examQuestions(
  s: Store,
  trials: readonly Memory[],
  episodes: readonly string[],
  holdout: readonly string[],
  maxQuestions: number,
  holdoutOnly: boolean,
): Question[] {
  const ids = [...episodes];
  if (!holdoutOnly && ids.length === 0) {
    for (const m of trials) {
      for (const id of m.from_episodes) if (!ids.includes(id)) ids.push(id);
    }
  }
  const questions: Question[] = [];
  const seen = new Set<string>();
  for (const id of holdoutOnly ? [] : ids) {
    if (questions.length >= maxQuestions) break;
    const episode = episodeByID(s, id);
    if (episode.input === '') continue;
    // 同一输入的多次失败不是多道题；不同输入指纹的版本仍各自保留。
    if (episode.fingerprint !== '') {
      const key = JSON.stringify([episode.scene_dir, episode.scene_id, episode.fingerprint]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
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
    if (holdoutOnly) {
      for (const m of trials) {
        for (const id of m.from_episodes) {
          const source = episodeByID(s, id);
          if (source.scene_dir !== '' && path.relative(path.resolve(source.scene_dir), sc.directory) === '') {
            throw new Error(`镜头 ${sc.id} 参与过经验 ${m.name} 的总结，不能作为仅验证新镜头的留出题`);
          }
        }
      }
    }
    questions.push({ id: `h${i + 1}`, episode: '', holdout: true, scene_id: sc.id, input: sc.directory });
  });
  return questions;
}

export async function examCell(
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
    else if (arm === ArmTrial)
      recallOpts.extra = retest.length === 0 ? trials : trials.filter((m) => m.status !== StatusActive);
    recalled = recallForExam(s, sc, recallOpts);
  } catch (err) {
    return fail(err);
  }
  sc = attachRecall(recalled, sc);
  cell.recalled = recallNames(recalled);
  const post = postChecks(trials);
  // 要补查阅读时间时，两组都被要求交出本镜头的可读元素清单。
  if (opts.postCheck && readsChecks(post).length > 0) sc = { ...sc, examNote: readsExamNote(post) };
  const attempt: Attempt = { ...(await run(sc, renderer, opts.signal)) };
  if (attempt.outcome === OutcomeSucceeded && post.length > 0 && opts.postCheck) {
    const findings = await opts.postCheck(sc, post, opts.signal);
    if (findings.some((f) => f.incomplete)) cell.incomplete = true;
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
 * 试用经验引用的、要在作答后补跑的校验器：能在单镜头里判定，
 * 又不在渲染时的产物校验里。
 */
export function postChecks(trials: readonly Memory[]): string[] {
  const out: string[] = [];
  for (const m of trials) {
    for (const id of m.checked_by ?? []) {
      if ((id === CheckFramesBlank || id.startsWith(ReadsCheckPrefix)) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}
