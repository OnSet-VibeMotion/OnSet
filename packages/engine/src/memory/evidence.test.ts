import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { newAttempt, OutcomeSucceeded, OutcomeVerificationFailed } from '../scene';
import { learnBrief } from '../audition/learn';
import { clusterFailures, consolidationBrief } from './consolidate';
import { newEpisode, SourceRender } from './episode';
import { ArmControl, ArmTrial, judge, newCell, type Question } from './exam';
import { StatusTrial } from './memory';
import { failingAttempt, lesson, newStore, tempDir, writeSceneDir } from './testsupport';

describe('memory evidence boundaries', () => {
  it('uses later same-scene success and excludes unrelated scenes and earlier success', () => {
    const failed = newEpisode({ id: 'failed', created_at: '2', source: SourceRender, scene_dir: '/p/a', renderer: 'codex', model: 'm1',
      outcome: OutcomeVerificationFailed, checks: ['output.frames'], features: ['chart'] });
    const success = (id: string, created_at: string, scene_dir: string, features: string[] = []) =>
      newEpisode({ id, created_at, scene_dir, features, source: SourceRender, renderer: 'codex', model: 'm1', outcome: OutcomeSucceeded });
    const earlier = success('earlier', '1', '/p/a', ['chart']);
    const unrelated = success('unrelated', '9', '/p/b');
    expect(clusterFailures([failed, earlier, unrelated])[0].contrasts).toBeNull();
    const related = success('related', '3', '/p/c', ['chart']);
    expect(clusterFailures([failed, earlier, unrelated, related])[0].contrasts?.[0].passed).toBe('related');
    const later = success('later', '4', '/p/a');
    expect(clusterFailures([failed, earlier, unrelated, related, later])[0].contrasts?.[0].passed).toBe('later');
  });

  it('keeps an entire group in trial when an unexposed lesson would get free credit', async () => {
    const store = newStore();
    const project = tempDir();
    const sc = writeSceneDir(path.join(project, 'scene'), 'scene-001', '图表', '');
    const ep = store.recordAttempt(sc, failingAttempt('codex', 'output.frames'), { source: SourceRender });
    for (const name of ['rule-a', 'rule-b', 'rule-c', 'rule-d']) {
      const m = lesson(name, StatusTrial, null, 'output.frames');
      m.from_episodes = [ep.id];
      store.write(m);
    }
    const result = await store.exam({ renderers: ['codex'], budget: 10000, workspace: path.join(project, 'exams'),
      run: async (scene) => scene.memory?.names?.includes('rule-a') ? newAttempt({ outcome: OutcomeSucceeded }) : failingAttempt('codex', 'output.frames') });
    expect(result.verdict.trial_score).toBeGreaterThan(result.verdict.control_score);
    expect(result.verdict.pass).toBe(false);
    expect(result.verdict.needs_human).toBe(true);
    expect(result.verdict.reasons.join('')).toContain('rule-d 没有在配对试用组中实际召回');
    expect(result.applied).toBe('none');
    expect(store.latestSnapshot()).toBeNull();
    for (const m of store.memories().memories) {
      expect(m.status).toBe(StatusTrial);
      expect(m.verified_by).toEqual([]);
    }
  });

  it('requires the actual post-check before dispatching a reading-time exam', async () => {
    const store = newStore();
    const project = tempDir();
    const sc = writeSceneDir(path.join(project, 'scene'), 'scene-001', '阅读', '');
    const ep = store.recordAttempt(sc, failingAttempt('codex', 'reads.duration'), { source: SourceRender });
    const m = lesson('hold-text', StatusTrial, null, 'reads.duration');
    m.from_episodes = [ep.id];
    store.write(m);
    const run = vi.fn(async () => newAttempt({ outcome: OutcomeSucceeded }));
    await expect(store.exam({ renderers: ['codex'], budget: 1500, workspace: path.join(project, 'exams'), run })).rejects.toThrow('考试缺少事后检查：reads.duration');
    expect(run).not.toHaveBeenCalled();
    expect(store.exams()).toEqual([]);
    expect(store.find(m.name)?.status).toBe(StatusTrial);
  });

  const questions: Question[] = [{ id: 'q1', episode: '', holdout: false, scene_id: '', input: '' }];
  const pair = () => [
    newCell({ question: 'q1', renderer: 'codex', repeat: 1, arm: ArmControl, model: 'm1', problems: 1 }),
    newCell({ question: 'q1', renderer: 'codex', repeat: 1, arm: ArmTrial, model: 'm1', passed: true, recalled: ['rule-a'] }),
  ];

  it('invalidates model changes, missing repeats and duplicated cells', () => {
    const changed = pair();
    changed[1].model = 'm2';
    expect(judge(questions, ['codex'], changed, false).invalid).toBe(true);
    const missing = pair();
    missing[1].repeat = 2;
    expect(judge(questions, ['codex'], missing, false).invalid).toBe(true);
    const duplicate = pair();
    duplicate.push({ ...duplicate[1] });
    expect(judge(questions, ['codex'], duplicate, false).invalid).toBe(true);
    expect(judge(questions, ['codex'], pair(), false, ['rule-a']).pass).toBe(true);
  });

  it('does not credit a lesson that was present in both arms or absent from both', () => {
    const same = pair();
    same[0].recalled = ['rule-a'];
    expect(judge(questions, ['codex'], same, false, ['rule-a']).needs_human).toBe(true);
    const absent = pair();
    absent[1].recalled = [];
    expect(judge(questions, ['codex'], absent, false, ['rule-a']).needs_human).toBe(true);
  });

  it('gives failure consolidation and visual learning the same actionable writing guide', () => {
    const briefs = [consolidationBrief([], []), learnBrief({ id: 'r', student: 'codex/m1', teacher: 'claude/m2', features: [], created_at: '', note: '' }, [], [])];
    for (const brief of briefs) {
      for (const text of ['适用条件', '具体做法', '原因', '边界', '验证方式', '没有失败源码', '不等于画面更好']) expect(brief).toContain(text);
    }
  });
});
