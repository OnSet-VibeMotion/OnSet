import fs from 'node:fs';
import path from 'node:path';
import { formatFixed } from '../gofmt';
import { compareBytes } from '../gojson';
import { processAlive } from '../scene';
import type { Usage } from '../tools';
import {
  type Arm,
  ArmControl,
  ArmTrial,
  type Cell,
  cellScore,
  type ExamProgress,
  type ExamResult,
  newCell,
  type Question,
  type Retest,
  type Verdict,
} from './exam_model';
import { isNotExist, readDirSorted, readJSON } from './io';
import { appliesInScope, KindLesson, StatusActive } from './memory';
import type { Store } from './store';
import { contains } from './util';

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
export function judge(
  questions: readonly Question[],
  renderers: readonly string[],
  cells: readonly Cell[],
  activeChanged: boolean,
  trials: readonly string[] = [],
): Verdict {
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
  const incomplete = cells.filter((c) => c.incomplete);
  if (incomplete.length > 0) {
    v.needs_human = true;
    v.reasons.push(
      ...incomplete.map(
        (c) => `${c.question} × ${c.renderer} × ${c.arm} 检查依据不完整，不能把清单缺失算成视频质量差异`,
      ),
    );
    return v;
  }
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
    const exposed = cells.some(
      (c) =>
        c.arm === ArmTrial &&
        contains(c.recalled, name) &&
        cells.some(
          (a) =>
            a.question === c.question &&
            a.renderer === c.renderer &&
            a.repeat === c.repeat &&
            a.arm === ArmControl &&
            !contains(a.recalled, name),
        ),
    );
    if (!exposed) {
      v.needs_human = true;
      v.reasons.push(`${name} 没有在配对试用组中实际召回，证据不足；请单独考试或检查适用条件与召回预算`);
    }
  }
  v.pass = v.reasons.length === 0;
  return v;
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
    } catch {
      /* 未安装此功能的历史考试或未写完的进度不影响成绩读取。 */
    }
  }
  return rows;
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
            incomplete: c?.incomplete === true || undefined,
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

export function nextExamID(s: Store): string {
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
