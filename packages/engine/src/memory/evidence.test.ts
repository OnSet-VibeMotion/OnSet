import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { newAttempt, OutcomeSucceeded, OutcomeVerificationFailed } from '../scene';
import { learnBrief } from '../audition/learn';
import { clusterFailures, consolidationBrief } from './consolidate';
import { newEpisode, SourceRender } from './episode';
import { ArmControl, ArmTrial, judge, newCell, type Question } from './exam';
import { StatusActive, StatusDormant, StatusRejected, StatusTrial } from './memory';
import { failingAttempt, lesson, newStore, tempDir, writeSceneDir } from './testsupport';

describe('memory evidence boundaries', () => {
  it('does not promote a lesson merely because one arm submitted missing evidence', async () => {
    const store = newStore(), root = tempDir();
    const sc = writeSceneDir(path.join(root, 'source'), 'scene-001', '验证', '');
    const source = store.recordAttempt(sc, failingAttempt('codex', 'reads.duration'), {source: SourceRender});
    const m = lesson('reading-rule', StatusTrial, null, 'reads.duration');
    m.from_episodes = [source.id]; store.write(m);
    const result = await store.exam({renderers:['codex'],trial:[m.name],budget:1500,workspace:path.join(root,'exams'),
      run:async()=>newAttempt({outcome:OutcomeSucceeded}),
      postCheck:(s)=>s.memory?.names?.includes(m.name)?[]:[{check:'reads.duration',problem:'visible-events.json 的 events 为空',incomplete:true}]});
    expect(result.verdict.pass).toBe(false);
    expect(result.verdict.needs_human).toBe(true);
    expect(result.verdict.reasons.join('')).toContain('不能把清单缺失算成视频质量差异');
    expect(store.find(m.name)?.status).toBe(StatusTrial);
    expect(store.latestSnapshot()).toBeNull();
    expect(store.exams()[0].cells?.[0].incomplete).toBe(true);
  });

  it('snapshots a successful active retest without leaving provenance drift', async () => {
    const store = newStore(), root = tempDir();
    const sc = writeSceneDir(path.join(root, 'source'), 'scene-001', '验证', '');
    const source = store.recordAttempt(sc, failingAttempt('codex', 'output.frames'), { source: SourceRender });
    const m = lesson('active-rule', StatusActive, null, 'output.frames');
    m.from_episodes = [source.id];
    store.write(m);
    store.takeSnapshot('manual_edit', '初始', false);
    const result = await store.exam({ renderers: ['codex'], retest: [m.name], budget: 1500, workspace: path.join(root, 'exams'),
      run: async (s) => s.memory?.names?.includes(m.name) ? newAttempt({outcome: OutcomeSucceeded}) : failingAttempt('codex', 'output.frames') });
    expect(result.applied).toBe('retest-passed');
    expect(result.snapshot).toBe(2);
    expect(store.drift()).toBeNull();
    expect(store.find(m.name)?.verified_by).toContain(result.id);
  });

  it.each([false, true])('distinguishes provenance updates from body edits during an exam (body edit %s)', async (editBody) => {
    const store = newStore(), root = tempDir();
    const sc = writeSceneDir(path.join(root, 'source'), 'scene-001', '验证', '');
    const source = store.recordAttempt(sc, failingAttempt('codex', 'output.frames'), { source: SourceRender });
    const active = lesson('active-rule', StatusActive, null, 'output.frames');
    store.write(active); store.takeSnapshot('manual_edit', '初始', false);
    active.verified_by = ['prior-proof']; store.write(active); // 已经偏离快照，但实际规则未变。
    const trial = lesson('new-rule', StatusTrial, null, 'output.frames');
    trial.from_episodes = [source.id]; store.write(trial);
    let changed = false;
    const result = await store.exam({ renderers: ['codex'], trial: [trial.name], budget: 5000, workspace: path.join(root, 'exams'),
      run: async (s) => {
        if (!changed) {
          changed = true;
          if (editBody) active.body += '\n实际做法已改变'; else active.verified_by.push('another-proof');
          store.write(active);
        }
        return s.memory?.names?.includes(trial.name) ? newAttempt({outcome: OutcomeSucceeded}) : failingAttempt('codex', 'output.frames');
      } });
    expect(result.verdict.needs_human).toBe(editBody);
    expect(result.verdict.pass).toBe(!editBody);
  });

  it('validates only genuinely new selected scenes without silently replaying source questions', async () => {
    const store = newStore();
    const root = tempDir();
    const old = writeSceneDir(path.join(root, 'old'), 'scene-001', '旧题', '');
    const fresh = writeSceneDir(path.join(root, 'fresh'), 'scene-002', '新题', '');
    const source = store.recordAttempt(old, failingAttempt('codex', 'output.frames'), { source: SourceRender });
    const m = lesson('frame-rule', StatusTrial, null, 'output.frames');
    m.from_episodes = [source.id];
    store.write(m);
    const opts = { renderers: ['codex'], trial: [m.name], holdoutOnly: true, budget: 1500, workspace: path.join(root, 'exams'),
      run: async (sc: Parameters<NonNullable<import('./exam').ExamOptions['run']>>[0]) =>
        sc.memory?.names?.includes(m.name) ? newAttempt({ outcome: OutcomeSucceeded }) : failingAttempt('codex', 'output.frames') };
    await expect(store.exam(opts)).rejects.toThrow('必须提供留出镜头');
    await expect(store.exam({ ...opts, holdout: [fresh.directory], episodes: [source.id] })).rejects.toThrow('不能同时指定来源旧题');
    await expect(store.exam({ ...opts, holdout: [old.directory] })).rejects.toThrow('参与过经验');
    const result = await store.exam({ ...opts, holdout: [fresh.directory] });
    expect(result.questions).toHaveLength(1);
    expect(result.questions?.[0]).toMatchObject({ id: 'h1', holdout: true, episode: '', scene_id: 'scene-002' });
    expect(result.verdict.pass).toBe(true);
    expect(result.cells).toHaveLength(2);
  });

  it.each([StatusDormant, StatusRejected])('reexamines %s lessons without enabling them before a valid pass', async (status) => {
    const store = newStore();
    const root = tempDir();
    const sc = writeSceneDir(path.join(root, 'scene'), 'scene-001', '重新验证', '');
    const first = store.recordAttempt(sc, { ...failingAttempt('codex', 'output.frames'), fingerprint: 'same-input' }, { source: SourceRender });
    const duplicate = store.recordAttempt(sc, { ...failingAttempt('codex', 'output.frames'), fingerprint: 'same-input' }, { source: SourceRender });
    const m = lesson('frame-rule', status, null, 'output.frames');
    m.from_episodes = [first.id, duplicate.id];
    m.rejected_reason = status === StatusRejected ? '上次没有通过' : '';
    store.write(m);
    const opts = { renderers: ['codex'], retest: [m.name], budget: 1500, workspace: path.join(root, 'exams') };
    const fail = await store.exam({ ...opts, run: async () => failingAttempt('codex', 'output.frames') });
    expect(fail.questions).toHaveLength(1);
    expect(fail.applied).toBe('retest-failed');
    expect(store.find(m.name)?.status).toBe(status);
    expect(store.find(m.name)?.rejected_reason).toBe(m.rejected_reason);
    expect(store.latestSnapshot()).toBeNull();
    const run = async (scene: Parameters<NonNullable<import('./exam').ExamOptions['run']>>[0]) => {
      expect(store.find(m.name)?.status).toBe(status);
      return scene.memory?.names?.includes(m.name) ? newAttempt({ outcome: OutcomeSucceeded }) : failingAttempt('codex', 'output.frames');
    };
    const dry = await store.exam({ ...opts, dryRun: true, run });
    expect(dry.verdict.pass).toBe(true);
    expect(store.find(m.name)?.status).toBe(status);
    const pass = await store.exam({ ...opts, run });
    expect(pass.applied).toBe('promoted');
    expect(pass.snapshot).toBe(1);
    expect(store.find(m.name)?.status).toBe(StatusActive);
    expect(store.find(m.name)?.rejected_reason).toBe('');
    expect(store.find(m.name)?.verified_by).toContain(pass.id);
    expect(store.recallScene(sc, { budget: 1500, renderer: 'codex' }).items.map((item) => item.name)).toContain(m.name);
  });

  it('keeps a retired lesson disabled after an invalid or unexposed retest', async () => {
    const store = newStore();
    const root = tempDir();
    const sc = writeSceneDir(path.join(root, 'scene'), 'scene-001', '重考', '');
    const source = store.recordAttempt(sc, failingAttempt('codex', 'output.frames'), { source: SourceRender });
    const m = lesson('frame-rule', StatusDormant, null, 'output.frames');
    m.from_episodes = [source.id];
    store.write(m);
    const opts = { renderers: ['codex'], retest: [m.name], budget: 1500, workspace: path.join(root, 'exams') };
    const invalid = await store.exam({ ...opts, run: async () => { throw new Error('认证失效'); } });
    expect(invalid.verdict.invalid).toBe(true);
    expect(store.find(m.name)?.status).toBe(StatusDormant);
    const absent = await store.exam({ ...opts, budget: 1, run: async () => newAttempt({ outcome: OutcomeSucceeded }) });
    expect(absent.verdict.needs_human).toBe(true);
    expect(store.find(m.name)?.status).toBe(StatusDormant);
    expect(store.latestSnapshot()).toBeNull();
  });

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
