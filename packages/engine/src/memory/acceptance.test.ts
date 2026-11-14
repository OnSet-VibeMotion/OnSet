import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { acceptExam, examAcceptance } from './acceptance';
import { newCell, type ExamResult } from './exam';
import { writeJSON } from './io';
import { lesson, newStore } from './testsupport';
import { Store } from './store';

function fixture() {
  const s = newStore();
  s.write(lesson('read-order', 'active', null, 'reads.order'));
  const exam: ExamResult = {
    id: 'exam-0001', created_at: '2026-11-14T12:00:00Z', trials: ['read-order'], renderers: ['codex'],
    questions: ['h1', 'h2'].map((id) => ({id, episode: '', holdout: true, scene_id: 'scene-' + id, input: ''})),
    cells: ['h1', 'h2'].flatMap((question) => ['control', 'trial'].map((arm) => newCell({question, arm, renderer: 'codex', repeat: 1, incomplete: true}))),
    verdict: {pass: false, invalid: false, needs_human: true, control_score: 0, trial_score: 0, reasons: ['检查依据不完整']},
    snapshot_before: 0, applied: 'none', snapshot: 0,
  };
  const file = path.join(s.dir, 'exams', exam.id, 'result.json');
  writeJSON(file, exam);
  const input = {exam: exam.id, name: 'read-order', questions: ['h1'], note: '观看对照后确认效果可用', userStatement: '我认为这个已经属于进化完成了'};
  return {s, exam, file, input};
}

it('persists scoped human acceptance across reopening without changing machine evidence or the active lesson', () => {
  const {s, exam, file, input} = fixture();
  const machine = fs.readFileSync(file);
  const memory = fs.readFileSync(s.path('lesson', input.name));
  const snapshot = s.latestSnapshot();
  const accepted = acceptExam(s, input);
  const reopened = new Store(s.dir);
  expect(examAcceptance(reopened, reopened.exams()[0])).toEqual(accepted);
  expect(accepted.question_ids).toEqual(['h1']);
  expect(accepted.user_statement).toBe(input.userStatement);
  expect(fs.readFileSync(file)).toEqual(machine);
  expect(fs.readFileSync(s.path('lesson', input.name))).toEqual(memory);
  expect(s.latestSnapshot()).toEqual(snapshot);
  expect(s.find(input.name)?.status).toBe('active');
  expect(s.exams()[0].verdict).toEqual(exam.verdict);
  expect(s.timeline()).toHaveLength(1);
  expect(acceptExam(s, input)).toEqual(accepted);
  expect(s.timeline()).toHaveLength(1);
});

it('does not carry acceptance over edited rules, a retired lesson, or replaced machine records', () => {
  const {s, exam, file, input} = fixture();
  acceptExam(s, input);
  const m = s.find(input.name)!;
  s.write({...m, body: m.body + '\n新规则'});
  expect(examAcceptance(s, exam)).toBeNull();
  s.write({...m, status: 'dormant'});
  expect(examAcceptance(s, exam)).toBeNull();
  s.write(m);
  expect(examAcceptance(s, exam)).not.toBeNull();
  writeJSON(file, {...exam, applied: 'changed'});
  expect(examAcceptance(s, exam)).toBeNull();
});

it('rejects an unrelated or inactive lesson, unknown question, empty confirmation, and invalid/missing answers', () => {
  const {s, exam, file, input} = fixture();
  expect(() => acceptExam(s, {...input, name: 'unrelated'})).toThrow('生效经验');
  expect(() => acceptExam(s, {...input, questions: ['h3']})).toThrow('已观看');
  expect(() => acceptExam(s, {...input, userStatement: ''})).toThrow('原话');
  writeJSON(file, {...exam, verdict: {...exam.verdict, invalid: true}});
  expect(() => acceptExam(s, input)).toThrow('有效考试');
  writeJSON(file, {...exam, cells: exam.cells!.filter((c) => c.arm !== 'trial')});
  expect(() => acceptExam(s, input)).toThrow('两组有效作答');
  writeJSON(file, exam);
  s.write({...s.find(input.name)!, status: 'dormant'});
  expect(() => acceptExam(s, input)).toThrow('生效经验');
  expect(s.timeline()).toEqual([]);
});
