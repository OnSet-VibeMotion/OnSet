import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as memory from '../memory';
import { load as loadScene, newAttempt, type Scene } from '../scene';
import * as audition from './index';
import type { VerdictRecord } from './audition';

let root = '';
let mem = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-learning-')));
  mem = path.join(root, '.memory');
  fs.writeFileSync(path.join(root, 'onset.conf'), '');
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const c = (slot: string, key: string, extra: Partial<VerdictRecord['contestants'][number]> = {}) => {
  const [renderer, ...rest] = key.split('/');
  return { slot, key, renderer, model: rest.join('/'), designer: '', outcome: 'succeeded', problems: 0, role: '', ...extra };
};

function row(i: number, winner: string, features: string[], keys = ['claude/opus', 'codex/gpt'], kind: VerdictRecord['kind'] = 'winner'): VerdictRecord {
  const contestants = keys.map((k, j) => c(String.fromCharCode(65 + j), k));
  return {
    at: `2026-11-1${i}T00:00:00Z`,
    project: 'p',
    project_dir: '',
    purpose: '',
    audition: `audition-2026111${i}-000000`,
    scene_id: 'scene-001',
    features,
    with_memory: true,
    kind,
    winner,
    winner_slot: contestants.find((x) => x.key === winner)?.slot ?? '',
    note: '',
    contestants,
  };
}

describe('learning relations', () => {
  it('proposes the side that wins most as teacher, flags small samples', () => {
    const rows = [row(1, 'claude/opus', ['three_d']), row(2, 'claude/opus', ['three_d']), row(3, 'codex/gpt', ['chart']), row(4, 'claude/opus', ['three_d']), row(5, '', [], undefined, 'tie')];
    const l = audition.loadLearning(mem);
    const [overall] = audition.proposals(rows, l);
    expect(overall).toMatchObject({ student: 'codex/gpt', teacher: 'claude/opus', features: [], matches: 5, teacher_wins: 3, student_wins: 1, ties: 1 });
    expect(overall.rate).toBeCloseTo(0.7);
    expect(overall.enough).toBe(true);
    // 一场说明不了什么：照样列出，但标样本少。
    const few = audition.proposals([row(1, 'codex/gpt', [])], l);
    expect(few).toHaveLength(1);
    expect(few[0]).toMatchObject({ teacher: 'codex/gpt', enough: false });
  });

  it('proposes a per-feature relation only when the overall one is unclear', () => {
    const rows = [
      row(1, 'claude/opus', ['three_d']),
      row(2, 'claude/opus', ['three_d']),
      row(3, 'claude/opus', ['three_d']),
      row(4, 'codex/gpt', ['chart']),
      row(5, 'codex/gpt', ['chart']),
    ];
    const list = audition.proposals(rows, audition.loadLearning(mem));
    expect(list.find((p) => p.features.length === 0)?.enough).toBe(false);
    expect(list.find((p) => p.features[0] === 'three_d')).toMatchObject({ teacher: 'claude/opus', enough: true });
  });

  it('skips design-assisted contestants, confirmed and dismissed pairs', () => {
    const rows = [row(1, 'codex/gpt<claude/opus', [], ['codex/gpt<claude/opus', 'codex/gpt']), row(2, 'claude/opus', [])];
    expect(audition.proposals(rows, audition.loadLearning(mem)).map((p) => p.teacher)).toEqual(['claude/opus']);
    audition.confirmRelation(mem, { student: 'codex/gpt', teacher: 'claude/opus' });
    expect(audition.proposals(rows, audition.loadLearning(mem))).toEqual([]);
    expect(() => audition.confirmRelation(mem, { student: 'a', teacher: 'a' })).toThrow('同一个');
    audition.dismissProposal(mem, { student: 'x/y', teacher: 'z', features: [] });
    expect(audition.proposals([row(1, 'z', [], ['x/y', 'z'])], audition.loadLearning(mem))).toEqual([]);
  });

  it('tracks the student closing in on the teacher, and exam results', () => {
    const r = audition.confirmRelation(mem, { student: 'codex/gpt', teacher: 'claude/opus' });
    const exam: VerdictRecord = {
      ...row(6, 'codex/gpt', []),
      purpose: 'exam',
      winner_slot: 'B',
      contestants: [c('A', 'codex/gpt', { role: 'control' }), c('B', 'codex/gpt', { role: 'trial' }), c('R', 'claude/opus', { role: 'reference' })],
    };
    const p = audition.progress([row(1, 'claude/opus', []), row(2, 'claude/opus', []), row(3, 'codex/gpt', []), row(4, '', [], undefined, 'tie'), exam], r);
    expect(p.points.map((x) => x.result)).toEqual(['loss', 'loss', 'win', 'tie']);
    expect(p.points.map((x) => x.rate)).toEqual([0, 0, 1 / 3, 1.5 / 4]);
    expect(p.exams).toEqual([{ at: exam.at, audition: exam.audition, result: 'trial' }]);
    // 学生的模型按前缀匹配。
    expect(audition.studentMatches('codex/gpt', 'codex', 'gpt-6-astra')).toBe(true);
    expect(audition.studentMatches('codex/gpt', 'claude', 'gpt')).toBe(false);
  });

  it('recommends who wins most on this kind of scene', () => {
    const rows = [row(1, 'claude/opus', ['three_d']), row(2, 'claude/opus', ['three_d']), row(3, 'codex/gpt', ['chart']), row(4, 'codex/gpt', ['chart'])];
    expect(audition.recommend(rows, ['three_d'])[0]).toMatchObject({ key: 'claude/opus', appearances: 2, wins: 2 });
    expect(audition.recommend(rows, ['chart'])[0].key).toBe('codex/gpt');
    expect(audition.recommend(rows, ['three_d', 'chart']).map((x) => x.rate)).toEqual([0.5, 0.5]);
  });
});

function writeScene(id = 'scene-001', prompt = '画一个立体的柱状图'): Scene {
  const dir = path.join(root, 'scenes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 't.srt'), '1\n00:00:00,000 --> 00:00:03,000\n字幕\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), `{"id":"${id}","duration_seconds":3,"output":"${id}.mp4","transcript":"t.srt","text":"这一段讲的是增长的来源"}`);
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
  return loadScene(dir);
}

/** 一场两位都拍完、teacher 胜出的试镜，记进评判记录。 */
function judged(sc: Scene, teacher: audition.Entry, student: audition.Entry, now: Date): audition.Audition {
  const a = audition.create(root, sc, [teacher, student], { withMemory: true, now, shuffle: (l) => [...l] });
  for (const x of a.contestants) {
    const dir = path.join(root, x.workdir);
    fs.writeFileSync(path.join(dir, `${sc.id}.mp4`), 'v');
    fs.writeFileSync(path.join(dir, 'index.html'), `<html>${x.renderer}</html>`);
    fs.writeFileSync(path.join(dir, `render-${sc.id}.stream.jsonl`), '{}');
    audition.applyAttempt(root, x, newAttempt({ outcome: 'succeeded', model: x.model }), '');
  }
  audition.save(root, a);
  const voted = audition.vote(root, a.id, { kind: 'winner', winner: 'A', note: '层次清楚' }, now);
  audition.recordVerdict(mem, 'demo', voted, root);
  audition.syncExemplar(mem, root, 'demo', voted, sc.text);
  return voted;
}

describe('exemplars', () => {
  it('keeps the winner’s code and gives it to students of that teacher on similar scenes', () => {
    const sc = writeScene();
    const a = judged(sc, { renderer: 'claude', model: 'opus' }, { renderer: 'codex', model: 'gpt' }, new Date(2026, 10, 14, 10));
    const [e] = audition.listExemplars(mem);
    expect(e).toMatchObject({ key: 'claude/opus', audition: a.id, scene_id: 'scene-001', note: '层次清楚' });
    expect(e.files).toContain('index.html');
    expect(e.files.some((f) => f.startsWith('render-'))).toBe(false);
    const q = { renderer: 'codex', model: 'gpt-6', features: sc ? memory.features(sc) : [], project: 'demo', sceneID: 'scene-009' };
    // 没有学习关系：不给。
    expect(audition.pickExemplars(mem, q)).toBeNull();
    audition.confirmRelation(mem, { student: 'codex/gpt', teacher: 'claude/opus' });
    const got = audition.pickExemplars(mem, q)!;
    expect(got.names).toEqual([e.id]);
    expect(got.section).toContain(path.join(e.dir!, 'code'));
    expect(got.section).toContain('层次清楚');
    // 同一个镜头不给自己的答案，别的学生也不给。
    expect(audition.pickExemplars(mem, { ...q, sceneID: 'scene-001' })).toBeNull();
    expect(audition.pickExemplars(mem, { ...q, renderer: 'qoder' })).toBeNull();
    // 改判成差不多：范例删掉。
    audition.syncExemplar(mem, root, 'demo', audition.vote(root, a.id, { kind: 'tie' }), '');
    expect(audition.listExemplars(mem)).toEqual([]);
  });
});

describe('learn from the teacher', () => {
  it('drafts lessons scoped to the student, with provenance, from the pairs the teacher won', async () => {
    const sc = writeScene();
    const a = judged(sc, { renderer: 'claude', model: 'opus' }, { renderer: 'codex', model: 'gpt' }, new Date(2026, 10, 14, 10));
    const store = memory.open(mem);
    const r = audition.confirmRelation(mem, { student: 'codex/gpt', teacher: 'claude/opus' });
    let brief = '';
    const result = await audition.learn(store, {
      relation: r,
      rows: audition.readVerdicts(mem),
      drafter: async (workdir, prompt) => {
        brief = prompt;
        expect(fs.readFileSync(path.join(workdir, 'pairs', '01', 'teacher', 'index.html'), 'utf8')).toBe('<html>claude</html>');
        expect(fs.readFileSync(path.join(workdir, 'pairs', '01', 'student', 'index.html'), 'utf8')).toBe('<html>codex</html>');
        expect(fs.readFileSync(path.join(workdir, 'pairs', '01', 'note.md'), 'utf8')).toContain('层次清楚');
        fs.writeFileSync(
          path.join(workdir, 'drafts', 'lessons', 'layer-depth-first.md'),
          '---\nname: layer-depth-first\ndescription: 先立住前后层次再加动效\nstatus: trial\napplies_when:\n  renderers: [qoder]\nchecked_by: [output.duration]\n---\n\n先把前景、中景、背景分开摆好，再给前景加动效。\n\n反例：\n    所有元素放在同一层\n\n正例：\n    三层分开、只动前景\n',
        );
      },
    });
    expect(brief).toContain('audition.judged');
    expect(result.accepted).toEqual(['layer-depth-first']);
    const m = store.find('layer-depth-first')!;
    // 范围、判定与出处由 onset 写定，草稿里写的不算。
    expect(m.status).toBe(memory.StatusTrial);
    expect(m.applies_when.renderers).toEqual(['codex']);
    expect(m.applies_when.models).toEqual(['gpt']);
    expect(m.checked_by).toEqual([memory.CheckerAudition]);
    expect(m.learned_from).toEqual(['claude/opus']);
    expect(m.from_auditions).toEqual([a.id]);
    expect(memory.parse(memory.KindLesson, memory.format(m)).learned_from).toEqual(['claude/opus']);
    // 学过的试镜不再拿来学。
    await expect(audition.learn(store, { relation: r, rows: audition.readVerdicts(mem), drafter: async () => {} })).rejects.toThrow('没有可学的对照');
  });

  it('settles a human-judged exam on the lessons', () => {
    const sc = writeScene();
    const store = memory.open(mem);
    store.write(
      memory.newMemory({
        name: 'layer-depth-first',
        description: '先立住层次',
        status: memory.StatusTrial,
        kind: memory.KindLesson,
        checked_by: [memory.CheckerAudition],
        learned_from: ['claude/opus'],
        body: '反例：x\n正例：y',
      }),
    );
    const exam = { relation: 'rel-1', student: 'codex/gpt', teacher: 'claude/opus', lessons: ['layer-depth-first'] };
    const entries: audition.Entry[] = [
      { renderer: 'codex', model: 'gpt', role: 'control' },
      { renderer: 'codex', model: 'gpt', role: 'trial' },
      { renderer: 'claude', model: 'opus', role: 'reference' },
    ];
    expect(() => audition.create(root, sc, entries.slice(0, 2).concat({ renderer: 'qoder', model: '' }), { withMemory: true, exam })).toThrow('人评考试');
    const a = audition.create(root, sc, entries, { withMemory: true, exam, shuffle: (l) => [...l].reverse() });
    expect(a.contestants.map((x) => [x.slot, x.role])).toEqual([
      ['A', 'trial'],
      ['B', 'control'],
      ['R', 'reference'],
    ]);
    for (const x of a.contestants) {
      fs.writeFileSync(path.join(root, x.workdir, 'scene-001.mp4'), 'v');
      audition.applyAttempt(root, x, newAttempt({ outcome: 'succeeded' }), '');
    }
    audition.save(root, a);
    // 评判之前：老师公开，两份学生作品看不出哪份带了经验。
    const blind = audition.blindJSON(a) as { contestants: Record<string, unknown>[] };
    expect(blind.contestants[2].renderer).toBe('claude');
    expect(JSON.stringify(blind.contestants.slice(0, 2))).not.toContain('trial');
    expect(() => audition.vote(root, a.id, { kind: 'winner', winner: 'R' })).toThrow('参照');
    const voted = audition.vote(root, a.id, { kind: 'winner', winner: 'A' });
    const out = audition.applyExam(store, root, voted)!;
    expect(out.applied).toBe('promoted');
    expect(store.find('layer-depth-first')).toMatchObject({ status: memory.StatusActive, verified_by: [a.id] });
    expect(() => audition.vote(root, a.id, { kind: 'tie' })).toThrow('已经生效');
    expect(() => audition.adoptFiles(root, audition.load(root, a.id), 'A', loadScene(sc.directory))).toThrow('人评考试的作品不换进镜头');
  });
});
