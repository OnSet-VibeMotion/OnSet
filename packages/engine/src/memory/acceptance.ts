import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Store } from './store';
import type { ExamResult } from './exam';
import { digestBytes, KindLesson, ruleDigest, StatusActive } from './memory';
import { rfc3339Nano } from './gostr';
import { readDirSorted, readJSON, writeJSON } from './io';

/** 人工验收与机器判卷分开追加保存；只认可明确看过的题目及当时的经验版本。 */
export interface HumanAcceptance {
  schema: 1;
  id: string;
  exam: string;
  name: string;
  description: string;
  question_ids: string[];
  accepted_at: string;
  note: string;
  user_statement: string;
  exam_digest: string;
  rule_digest: string;
  snapshot: number;
}

function resultFile(s: Store, id: string): string {
  if (!/^exam-[0-9]+$/.test(id)) throw new Error('考试编号不合法');
  return path.join(s.dir, 'exams', id, 'result.json');
}

/** 仅返回仍对应当前生效经验及原始考试的验收；旧记录不删除。 */
export function examAcceptance(s: Store, exam: ExamResult): HumanAcceptance | null {
  const file = resultFile(s, exam.id);
  let digest: string;
  try { digest = digestBytes(fs.readFileSync(file)); } catch { return null; }
  const dir = path.join(path.dirname(file), 'human-acceptances');
  const entries = readDirSorted(dir) ?? [];
  for (const entry of entries.reverse()) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const a = readJSON(path.join(dir, entry.name)) as HumanAcceptance;
      const m = typeof a.name === 'string' ? s.find(a.name) : null;
      if (a.schema === 1 && a.exam === exam.id && a.exam_digest === digest && m?.kind === KindLesson &&
        m.status === StatusActive && a.rule_digest === ruleDigest(m) && Array.isArray(a.question_ids) &&
        a.question_ids.length > 0 && a.question_ids.every((id) => exam.questions?.some((q) => q.id === id))) return a;
    } catch { /* 半写入或损坏的验收不改变机器记录，也不冒报完成。 */ }
  }
  return null;
}

export function acceptExam(s: Store, input: { exam: string; name: string; questions: string[]; note: string; userStatement: string }): HumanAcceptance {
  const file = resultFile(s, input.exam);
  const exam = s.exams().find((e) => e.id === input.exam);
  if (!exam || exam.verdict.invalid) throw new Error('只能验收已有完整作答的有效考试');
  const m = s.find(input.name);
  if (!m || m.kind !== KindLesson || m.status !== StatusActive || !exam.trials?.includes(input.name)) throw new Error('人工验收必须指定本场的一条生效经验');
  const questions = [...new Set(input.questions)];
  if (questions.length === 0 || questions.some((id) => !exam.questions?.some((q) => q.id === id))) throw new Error('必须指定已观看的考试镜头');
  for (const id of questions) for (const arm of ['control', 'trial']) {
    if (!exam.cells?.some((c) => c.question === id && c.arm === arm && !c.invalid)) throw new Error('已验收镜头必须有两组有效作答');
  }
  if (!input.note.trim() || !input.userStatement.trim()) throw new Error('人工验收必须保留用户确认原话与结论');
  const before = examAcceptance(s, exam);
  if (before?.name === input.name && before.note === input.note && before.user_statement === input.userStatement &&
    before.question_ids.join('\n') === questions.join('\n')) return before;
  const acceptedAt = rfc3339Nano(s.clock());
  const a: HumanAcceptance = {schema: 1, id: 'human-' + acceptedAt.replace(/[^0-9]/g, '') + '-' + crypto.randomBytes(4).toString('hex'),
    exam: exam.id, name: m.name, description: m.description, question_ids: questions, accepted_at: acceptedAt,
    note: input.note, user_statement: input.userStatement, exam_digest: digestBytes(fs.readFileSync(file)), rule_digest: ruleDigest(m), snapshot: s.latestSnapshot()?.id ?? 0};
  writeJSON(path.join(path.dirname(file), 'human-acceptances', a.id + '.json'), a);
  s.log({time: '', type: 'human_acceptance', summary: '进化完成：' + m.description + '（人工验收通过）',
    detail: {exam: exam.id, memory: m.name, questions, acceptance: a.id, note: a.note}});
  return a;
}
