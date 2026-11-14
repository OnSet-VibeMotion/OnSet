import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newAttempt, OutcomeSucceeded, OutcomeVerificationFailed, writeRecord } from '../scene';
import { clusterFailures, consolidationBrief, contrastLine, copyContrastCode, type Cluster } from './consolidate';
import { newEpisode, SourceCheck, SourceRender, type Episode } from './episode';
import { EventManualEdit } from './events';
import { CheckerHuman } from './features';
import { lint } from './lint';
import { cloneMemory, KindLesson, KindPreference, newMemory, StatusActive, StatusTrial, type Memory } from './memory';
import { DefaultMaxLessons, draw, recall, recallNames, recallSection, recallDigest, attachRecall } from './recall';
import { runReport } from './report';
import { suspectMemories } from './stats';
import { lesson, newStore, tempDir, writeSceneDir } from './testsupport';

describe('evolution', () => {
  // 每个镜头最多注入 DefaultMaxLessons 条经验，排在后面的记为 limit；偏好不占条数。
  it('TestRecallCapsLessonsButNotPreferences', () => {
    const memories: Memory[] = ['rule-a', 'rule-b', 'rule-c', 'rule-d', 'rule-e'].map((name) => lesson(name, StatusActive, ['cjk_text'], 'output.frames'));
    memories.push(newMemory({ kind: KindPreference, name: 'calm-palette', description: '配色克制', status: StatusActive, checked_by: [CheckerHuman], body: '配色克制' }));
    const result = recall({ memories, renderer: 'claude', features: ['cjk_text'], budget: 100000 });
    const lessons = result.items.filter((item) => item.kind === KindLesson).length;
    const preferences = result.items.length - lessons;
    expect(lessons).toBe(DefaultMaxLessons);
    expect(preferences).toBe(1);
    expect(result.max_lessons).toBe(DefaultMaxLessons);
    expect(result.omitted.length).toBe(2);
    expect(result.omitted[0].omit_reason).toBe('limit');
    // MaxLessons 可以放宽。
    expect(recall({ memories, renderer: 'claude', features: ['cjk_text'], budget: 100000, maxLessons: 5 }).items.length).toBe(6);
    const tight = recall({ memories, renderer: 'claude', features: ['cjk_text'], budget: 10 });
    // 预算用完记为 budget。
    expect(tight.items.length).toBe(0);
    expect(tight.omitted[0].omit_reason).toBe('budget');
  });

  // 修订不得丢掉旧版的校验器，也不得缩到一半以下。
  it('TestLintRejectsRevisionsThatCollapse', () => {
    const old = lesson('font-local', StatusActive, ['cjk_text'], 'determinism.remote-font', 'determinism.font-display');
    old.body =
      '中文字体必须用镜头目录里的本地文件，通过 @font-face 引入，font-display 写 block，否则首帧会用回退字体。' +
      "\n\n反例：\n    @import url('https://fonts.example/css');\n\n正例：\n    @font-face { src: url('./fonts/x.woff2'); font-display: block; }";
    const short = lesson('font-local-v2', StatusTrial, ['cjk_text'], 'determinism.remote-font');
    short.revises = 'font-local';
    const problems = lint(short, { existing: [old] }).join('\n');
    expect(problems).toContain('丢掉了旧版 font-local 的校验器 determinism.font-display');
    expect(problems).toContain('不到旧版的一半');
    const good = cloneMemory(old);
    good.name = 'font-local-v3';
    good.revises = 'font-local';
    good.status = StatusTrial;
    good.body += '\n另外 woff2 要随镜头目录提供。';
    // 完整的修订应当通过。
    expect(lint(good, { existing: [old] })).toEqual([]);
  });

  // 同一镜头后来改对的优先当对照，其次特征相近的通过渲染；事后检查出问题的、
  // 同样犯了这个错的不当对照。整理说明里写出对照。
  it('TestClustersCarrySuccessContrasts', () => {
    const episodes: Episode[] = [
      newEpisode({ id: 'ep-1', created_at: '1', source: SourceRender, scene_dir: '/p/scenes/a', renderer: 'claude', outcome: OutcomeVerificationFailed, checks: ['output.frames'], problems: ['多 1 帧'], features: ['cjk_text', 'numbers'] }),
      newEpisode({ id: 'ep-2', created_at: '2', source: SourceRender, scene_dir: '/p/scenes/a', renderer: 'claude', outcome: OutcomeSucceeded, retry: true, fingerprint: 'fp-a' }),
      newEpisode({ id: 'ep-3', created_at: '3', source: SourceRender, scene_dir: '/p/scenes/b', renderer: 'claude', outcome: OutcomeVerificationFailed, checks: ['output.frames'], problems: ['多 2 帧'], features: ['cjk_text', 'numbers'] }),
      newEpisode({ id: 'ep-4', created_at: '4', source: SourceRender, scene_dir: '/p/scenes/c', renderer: 'claude', outcome: OutcomeSucceeded, features: ['cjk_text', 'numbers'], fingerprint: 'fp-c' }),
      newEpisode({ id: 'ep-5', created_at: '5', source: SourceRender, scene_dir: '/p/scenes/d', renderer: 'claude', outcome: OutcomeSucceeded, features: ['cjk_text', 'numbers', 'chart'], fingerprint: 'fp-d' }),
      newEpisode({ id: 'ep-6', created_at: '6', source: SourceCheck, scene_dir: '/p/scenes/d', fingerprint: 'fp-d', checks: ['frames.blank'], problems: ['空白'] }),
    ];
    const clusters = clusterFailures(episodes);
    expect(clusters.length).toBe(1);
    expect(clusters[0].contrasts!.length).toBe(2);
    const [first, second] = clusters[0].contrasts!;
    // 同一镜头改对的优先。
    expect([first.failed, first.passed, first.same_scene]).toEqual(['ep-1', 'ep-2', true]);
    // 事后检查出问题的 ep-5 不当对照。
    expect([second.failed, second.passed, second.same_scene]).toEqual(['ep-3', 'ep-4', false]);
    expect(second.shared_features!.join(',')).toBe('cjk_text,numbers');
    const brief = consolidationBrief(clusters, null);
    for (const want of ['成败对照（同一个镜头后来通过了）', '已被后来的渲染覆盖', '修订必须保留旧版的全部 checked_by', '最多注入 3 条经验']) {
      expect(brief).toContain(want);
    }
  });

  // 召回后它要防的校验器照样失败，按渲染工具/模型分开计；别的校验器失败不算它的错。
  it('TestSuspectMemoriesFlagLessonsWhoseCheckerStillFails', () => {
    const rule = lesson('frame-count', StatusActive, null, 'output.frames');
    const episodes: Episode[] = [];
    const add = (model: string, outcome: string, ...checks: string[]) =>
      episodes.push(newEpisode({ id: 'ep', source: SourceRender, renderer: 'codex', model, outcome, checks: checks.length > 0 ? checks : null, recalled: ['frame-count'] }));
    add('gpt-a', OutcomeVerificationFailed, 'output.frames');
    add('gpt-a', OutcomeVerificationFailed, 'output.frames');
    add('gpt-a', OutcomeSucceeded);
    add('gpt-b', OutcomeVerificationFailed, 'output.resolution');
    add('gpt-b', OutcomeVerificationFailed, 'output.resolution');
    episodes.push(newEpisode({ id: 'ep-check', source: SourceCheck, renderer: 'codex', model: 'gpt-b', checks: ['output.frames'], recalled: ['frame-count'] }));
    const got = suspectMemories(episodes, [rule]);
    expect(got).not.toBeNull();
    expect(got!.length).toBe(1);
    expect([got![0].renderer, got![0].harmful, got![0].recalled, got![0].checks![0]]).toEqual(['codex/gpt-a', 2, 3, 'output.frames']);
  });

  // 编排工具推测的偏好进入试用、不进召回，出现在偏好段的待确认里；确认后才生效。
  it('TestInferredPreferenceWaitsForConfirmation', () => {
    const store = newStore();
    const { memory: m, snapshot } = store.remember({ name: 'slower-pacing', body: '用户几次把节奏改慢', project: 'demo', inferred: true });
    expect(m.status).toBe(StatusTrial);
    expect(snapshot).toBeNull();
    const brief = store.preferenceBrief('demo', 0).text;
    expect(brief).toContain('待确认的偏好');
    expect(brief).toContain('【slower-pacing】');
    expect(brief).toContain('"inferred": true');
    store.promote('slower-pacing');
    // 确认后生效。
    expect(store.find('slower-pacing')!.status).toBe(StatusActive);
  });

  // 通过那一版的源码拷进整理工作目录，只拷文本源码；镜头目录后来又渲染过（指纹不同）时不拷。
  it('TestContrastCodeIsCopiedOnlyWhenStillCurrent', () => {
    const dir = path.join(tempDir(), 'scene-001');
    const sc = writeSceneDir(dir, 'scene-001', '文本', '');
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>通过的写法</html>');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(dir, 'out.mp4'), 'video');
    writeRecord(sc, { fingerprint: 'fp-now', parts: null });
    const workdir = tempDir();
    const pair = (failed: string, passed: string, fingerprint: string) => ({
      failed,
      failed_dir: '',
      passed,
      passed_dir: dir,
      passed_fingerprint: fingerprint,
      same_scene: false,
      shared_features: null,
      passed_code: '',
    });
    const clusters: Cluster[] = [
      {
        key: 'output.frames',
        count: 0,
        episodes: null,
        renderers: {},
        models: {},
        features: null,
        examples: null,
        notes: null,
        recalled: null,
        signals: null,
        contrasts: [pair('ep-1', 'ep-2', 'fp-now'), pair('ep-3', 'ep-4', 'fp-old')],
      },
    ];
    copyContrastCode(workdir, clusters);
    const [current, stale] = clusters[0].contrasts!;
    expect(current.passed_code).not.toBe('');
    expect(stale.passed_code).toBe('');
    expect(fs.readFileSync(path.join(workdir, current.passed_code, 'index.html'), 'utf8')).toContain('通过的写法');
    // .env 与产物不该被拷贝。
    for (const name of ['.env', 'out.mp4']) expect(fs.existsSync(path.join(workdir, current.passed_code, name))).toBe(false);
    expect(contrastLine(current)).toContain(current.passed_code);
  });

  // 抽中时把排最后的经验换成上限外的第一条，记下倾向分数；输入指纹仍用不探索时的摘要，镜头不会因此 Stale。
  it('TestExplorationSwapsLastLessonButKeepsCanonicalDigest', () => {
    const store = newStore();
    for (const name of ['rule-a', 'rule-b', 'rule-c', 'rule-d']) store.write(lesson(name, StatusActive, ['cjk_text'], 'output.frames'));
    store.takeSnapshot(EventManualEdit, '初始', true);
    const sc = writeSceneDir(path.join(tempDir(), 'scene-001'), 'scene-001', '中文文本', '');
    const base = store.recallScene(sc, { budget: 100000, renderer: 'claude' });
    expect(base.explored).toBeNull();
    expect(base.items.length).toBe(DefaultMaxLessons);
    const always = store.recallScene(sc, { budget: 100000, renderer: 'claude', explore: 1, exploreSeed: 'run-1' });
    const x = always.explored!;
    expect(x).not.toBeNull();
    expect([x.dropped, x.added, x.propensity]).toEqual([base.items[2].name, 'rule-d', 1]);
    // 注入的应是探索后的。
    expect(recallNames(always)[2]).toBe('rule-d');
    expect(recallSection(always)).toContain('【rule-d】');
    expect(recallSection(always)).not.toContain('【' + x.dropped + '】');
    // 输入指纹要用不探索时的召回。
    expect(recallDigest(always)).toBe(recallDigest(base));
    expect(attachRecall(always, sc).memory!.digest).toBe(recallDigest(base));
    const last = always.omitted[always.omitted.length - 1];
    expect([last.name, last.omit_reason]).toEqual([x.dropped, 'explore']);
    // 同一个种子永远同一个决定；概率为 0 时从不探索。
    const again = store.recallScene(sc, { budget: 100000, renderer: 'claude', explore: 0.5, exploreSeed: 'run-7' });
    const twice = store.recallScene(sc, { budget: 100000, renderer: 'claude', explore: 0.5, exploreSeed: 'run-7' });
    expect(again.explored === null).toBe(twice.explored === null);
    let hits = 0;
    for (let i = 0; i < 400; i++) if (draw(String(i)) < 0.1) hits++;
    // 抽签比例偏离 0.1 太多。
    expect(hits).toBeGreaterThanOrEqual(20);
    expect(hits).toBeLessThanOrEqual(60);

    // 经历记下探索；批次报告单列探索的镜头。
    const attempt = newAttempt({ scene_id: 'scene-001', renderer: 'claude', outcome: OutcomeSucceeded });
    const episode = store.recordAttempt(attachRecall(always, sc), attempt, { source: SourceRender, run: 'run-1', explored: always.explored });
    expect(episode.explored).not.toBeNull();
    expect(episode.recalled![2]).toBe('rule-d');
    const runs = runReport(store.episodes());
    expect(runs.length).toBe(1);
    expect(runs[0].explored).toBe(1);
    expect(runs[0].explored_passed).toBe(1);
  });

  // 不在 Go 版里：draw 与 Go 逐位相同（期望值取自 Go 版 draw 的真实输出），同一批次同一镜头
  // 在两边抽到同一个结果。
  it('draw matches the Go implementation bit for bit', () => {
    expect(draw('run-1|/a')).toBe(GO_DRAW['run-1|/a']);
    expect(draw('run-7|/b')).toBe(GO_DRAW['run-7|/b']);
    expect(draw('0')).toBe(GO_DRAW['0']);
  });
});

/** Go 版 draw 的输出（经双跑对照取得）。 */
const GO_DRAW: Record<string, number> = {
  'run-1|/a': 0.6737886994587187,
  'run-7|/b': 0.3250005764346229,
  '0': 0.374708855291631,
};
