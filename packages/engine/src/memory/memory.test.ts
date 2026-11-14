import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HandoffCarry, load, newAttempt, newTiming, OutcomeFailed, OutcomeSucceeded, OutcomeVerificationFailed, type Attempt, type Scene } from '../scene';
import { ClusterKeyHuman, clusterFailures, consolidationBrief, type Cluster } from './consolidate';
import { similar, preferenceSignals } from './conversation';
import { computeStats, smoothedRate, weakMemories } from './stats';
import { EventExam, EventManualEdit, EventPromote, EventReject, EventSnapshot } from './events';
import { newEpisode, SourceExam, SourceRender, type Episode } from './episode';
import { judge, ArmControl, ArmTrial, newCell, type Arm, type Cell, type ExamOptions, type Question } from './exam';
import { features, knownFeature } from './features';
import { lint, MaxBodyChars } from './lint';
import { format, KindLesson, KindPreference, newApplies, newMemory, parse, ruleDigest, StatusActive, StatusDormant, StatusRejected, StatusTrial, cloneMemory, type Memory } from './memory';
import { recall, recallDigest, recallNames, recallReason, recallSection, type RecallInput } from './recall';
import { runReport } from './report';
import { failingAttempt, lesson, newStore, tempDir, writeSceneDir } from './testsupport';

function joined(problems: string[]): string {
  return problems.join('\n');
}

describe('memory', () => {
  it('TestParseFormatRoundTrip', () => {
    const m = lesson('font-local-block', StatusActive, ['cjk_text'], 'determinism.font-display');
    m.applies_when.keywords = ['字体'];
    const parsed = parse(KindLesson, format(m));
    expect(parsed.name).toBe(m.name);
    expect(parsed.body).toBe(m.body);
    expect(parsed.checked_by![0]).toBe('determinism.font-display');
    expect(parsed.applies_when.keywords[0]).toBe('字体');
    // frontmatter 的未知字段应当报错：写错的字段名不能静默丢掉。
    expect(() => parse(KindLesson, '---\nname: x\nstats: {}\n---\n正文')).toThrow();
  });

  describe('TestLintRejectsModelSpecificAndMemorizedLessons', () => {
    const ok = lesson('font-local-block', StatusTrial, ['cjk_text'], 'determinism.font-display');
    it('合格的经验不被拒', () => {
      expect(lint(ok, {})).toEqual([]);
    });
    const cases: Array<[string, (m: Memory) => void, string]> = [
      ['工具名', (m) => (m.body += '\nClaude 渲染时要这样写'), '渲染工具名'],
      ['模型名', (m) => (m.description = '适用于 GPT-5 的写法'), '渲染工具名'],
      ['未知校验器', (m) => (m.checked_by = ['determinism.nope']), '不存在的校验器'],
      ['没有校验器', (m) => (m.checked_by = null), 'checked_by 为空'],
      ['经验用 human', (m) => (m.checked_by = ['human']), '写成偏好'],
      ['缺反例', (m) => (m.body = '只有规则，正例：好写法'), '反例'],
      ['未知特征', (m) => (m.applies_when.features = ['neon']), '未知特征'],
      ['镜头编号', (m) => (m.body += '\n像 scene-003 那样'), '镜头编号'],
      ['素材名', (m) => (m.body += '\n用 hero-shot.png 当背景'), '素材文件名'],
      ['抄文案', (m) => (m.body += '\n标题写成：人工智能正在改变世界'), '照抄了镜头文案'],
      ['超长', (m) => (m.body += '长'.repeat(MaxBodyChars)), '上限'],
      ['坏名字', (m) => (m.name = 'Font_Block'), 'name 不合法'],
    ];
    for (const [name, mutate, want] of cases) {
      it(name, () => {
        const m = cloneMemory(ok);
        mutate(m);
        const problems = lint(m, { sceneTexts: ['人工智能正在改变世界的每一个角落'] });
        expect(joined(problems)).toContain(want);
      });
    }
  });

  it('TestLintRequiresRevisionInsteadOfParallelLesson', () => {
    const existing = lesson('font-local-block', StatusActive, ['cjk_text'], 'determinism.font-display');
    const parallel = lesson('font-block-again', StatusTrial, ['cjk_text'], 'determinism.font-display');
    // 同一件事并列新增应当被拒。
    expect(lint(parallel, { existing: [existing] }).join('')).toContain('revises: font-local-block');
    parallel.revises = 'font-local-block';
    expect(lint(parallel, { existing: [existing] })).toEqual([]);
    parallel.revises = 'missing';
    expect(lint(parallel, { existing: [existing] }).join('')).toContain('不存在的记忆');
    const pref = newMemory({ kind: KindPreference, name: 'no-neon', description: '不要满屏霓虹', status: StatusTrial, checked_by: ['determinism.raf'], body: '克制使用霓虹色' });
    // 偏好必须由人判定。
    expect(lint(pref, {}).join('')).toContain('[human]');
  });

  it('TestFeaturesAreExtractedFromSceneInputs', () => {
    const s = writeSceneDir(tempDir(), 'scene-001', '人工智能在2026年改变了一切这是很长的一句话再长一些吧凑够密度', '用 Lottie 做一个柱状图表');
    let list = features(s);
    for (const want of ['cjk_text', 'numbers', 'dense_text', 'portrait', 'lottie', 'chart']) expect(list).toContain(want);
    // 抽出了词表外的特征，整理者写不出能匹配它的经验。
    for (const feature of list) expect(knownFeature(feature)).toBe(true);
    s.timing = newTiming({ exit: { peer: 'scene-002', device: HandoffCarry, bridge: 'x', cross_chapter: true, style_shift: '', peer_film_style: '' } });
    list = features(s);
    for (const want of ['timing', 'handoff', 'handoff:carry', 'cross_chapter']) {
      expect(list).toContain(want);
      expect(knownFeature(want)).toBe(true);
    }
  });

  it('TestRecallMatchesRanksAndRespectsBudget', () => {
    const global = lesson('global-rule', StatusActive, null, 'output.frames');
    const cjk = lesson('cjk-rule', StatusActive, ['cjk_text'], 'determinism.font-display');
    const cast = lesson('cast-rule', StatusActive, ['cast'], 'determinism.raf');
    const keyword = lesson('keyword-rule', StatusActive, null, 'determinism.clock');
    keyword.applies_when = newApplies({ keywords: ['倒计时'] });
    const other = newMemory({ kind: KindPreference, name: 'other-project', description: '别的项目', status: StatusActive, checked_by: ['human'], scope: 'elsewhere', body: 'x' });
    const input: RecallInput = {
      memories: [global, cjk, cast, keyword, other],
      renderer: 'claude',
      features: ['cjk_text', 'portrait'],
      text: '一个倒计时',
      project: 'mine',
      budget: 10000,
    };
    const result = recall(input);
    const names = recallNames(result);
    expect(names).toEqual(['cjk-rule', 'global-rule', 'keyword-rule']);
    // 同样的输入应当得到同样的召回。
    const again = recall(input);
    expect(recallNames(again)).toEqual(names);
    expect(recallDigest(again)).toBe(recallDigest(result));
    expect(recallSection(again)).toBe(recallSection(result));
    expect(recallReason(result.items[0])).toContain('cjk_text');
    expect(recallReason(result.items[1])).toBe('全局适用');
    // 效果统计改变排序：全局规则在 claude 上屡试屡成，cjk 规则屡试屡败。
    input.stats = {
      'global-rule': { claude: { recalled: 10, passed_first_try: 10 } },
      'cjk-rule': { claude: { recalled: 10, passed_first_try: 0 } },
    };
    expect(recallNames(recall(input))[0]).toBe('global-rule');
    input.stats = null;
    input.budget = result.items[0].chars;
    const limited = recall(input);
    expect(limited.items.length).toBe(1);
    expect(limited.omitted.length).toBe(2);
    expect(limited.used).toBeLessThanOrEqual(input.budget);
    input.budget = 0;
    // 预算为 0 时什么也不召回。
    expect(recall(input).items.length).toBe(0);
  });

  it('TestRecallReadsSnapshotNotFilesAndRollbackRestores', () => {
    const store = newStore();
    const s = writeSceneDir(tempDir(), 'scene-001', '中文标题', '');
    // 没有快照时不召回。
    expect(store.recallScene(s, { budget: 1500 }).items.length).toBe(0);
    store.write(lesson('cjk-rule', StatusActive, ['cjk_text'], 'determinism.font-display'));
    // 手写的记忆未记快照前不该被召回。
    expect(store.recallScene(s, { budget: 1500 }).items.length).toBe(0);
    const report = store.status(true, null);
    // status 应当把人工编辑记成快照 #1。
    expect(report.recorded_snapshot).toBe(1);
    expect(report.drift).toEqual(['cjk-rule']);
    // 人工编辑的快照应当标为未经考试。
    expect(store.loadSnapshot(1).unverified).toBe(true);
    const r1 = store.recallScene(s, { budget: 1500 });
    expect(recallNames(r1)).toEqual(['cjk-rule']);
    expect(r1.snapshot).toBe(1);
    const harmful = lesson('loop-forever', StatusActive, null, 'determinism.infinite-repeat');
    store.write(harmful);
    store.takeSnapshot(EventPromote, '塞入有害记忆', true);
    const r2 = store.recallScene(s, { budget: 1500 });
    expect(r2.items.length).toBe(2);
    expect(recallDigest(r2)).not.toBe(recallDigest(r1));
    // 钉住快照 #1 时召回应当与当时一致。
    expect(recallDigest(store.recallScene(s, { snapshot: 1, budget: 1500 }))).toBe(recallDigest(r1));
    const rolled = store.rollback(0);
    // 回退应当生成新快照 #3、来源 #1。
    expect(rolled.id).toBe(3);
    expect(rolled.restored_from).toBe(1);
    const r3 = store.recallScene(s, { budget: 1500 });
    // 回退后召回段应当与快照 #1 逐字相同（镜头不会因此 Stale）。
    expect(recallDigest(r3)).toBe(recallDigest(r1));
    expect(recallSection(r3)).toBe(recallSection(r1));
    // 不在目标快照里的生效记忆应当转为沉睡。
    expect(store.find('loop-forever')!.status).toBe(StatusDormant);
    // 回退不删除历史。
    expect(store.snapshotIDs()).toEqual([1, 2, 3]);
    const index = fs.readFileSync(path.join(store.dir, 'MEMORY.md'), 'utf8');
    // 索引只列生效记忆。
    expect(index).toContain('cjk-rule');
    expect(index).not.toContain('loop-forever');
  });

  it('TestEpisodesFreezeInputsAndFeedStatsAndClusters', () => {
    const store = newStore();
    const s = writeSceneDir(tempDir(), 'scene-001', '中文标题', '创意方向');
    s.memory = { snapshot: 1, names: ['cjk-rule'], section: '', digest: '' };
    const ep = store.recordAttempt(s, failingAttempt('claude', 'determinism.raf', 'output.frames'), { source: SourceRender });
    // 冻结输入。
    for (const rel of ['scene.json', 'transcript.srt', 'prompt.md']) expect(fs.existsSync(path.join(ep.dir, 'input', rel))).toBe(true);
    // 冻结输入应当能原样加载。
    expect(() => load(path.join(ep.dir, 'input'))).not.toThrow();
    store.recordAttempt(s, failingAttempt('codex', 'determinism.raf'), { source: SourceRender });
    store.recordAttempt(s, newAttempt({ renderer: 'codex', outcome: OutcomeSucceeded }), { source: SourceRender });
    store.recordAttempt(s, newAttempt({ renderer: 'codex', outcome: OutcomeSucceeded, retry: true }), { source: SourceRender });
    store.recordAttempt(s, failingAttempt('codex', 'determinism.raf'), { source: SourceExam, exam: 'exam-0001' });
    store.recordAttempt(s, newAttempt({ renderer: 'codex', outcome: OutcomeFailed, error: '退出码 1' }), { source: SourceRender });
    store.recordFeedback(s, { verdict: 'down', note: '霓虹太多', seconds: -1, region: null, element: '' });
    const episodes = store.episodes();
    expect(episodes.length).toBe(7);
    const stats = computeStats(episodes);
    // 统计只计正式渲染的首次尝试。
    expect(stats['cjk-rule'].codex).toEqual({ recalled: 3, passed_first_try: 1 });
    const clusters = clusterFailures(episodes);
    // 聚类不对（考试与渲染器崩溃都不算）。
    expect(clusters.length).toBe(3);
    expect(clusters[0].key).toBe('determinism.raf');
    expect(clusters[0].count).toBe(2);
    // 聚类应当记下渲染工具分布与失败时已召回的记忆。
    expect(clusters[0].renderers.claude).toBe(1);
    expect(clusters[0].renderers.codex).toBe(1);
    expect(clusters[0].recalled).toContain('cjk-rule');
    // 人工 👎 应当单独成组。
    expect(clusters.some((c) => c.key === ClusterKeyHuman && c.notes![0] === '（👎）霓虹太多')).toBe(true);
  });

  it('TestConsolidateIngestsOnlyValidDrafts', async () => {
    const store = newStore();
    const s = writeSceneDir(tempDir(), 'scene-001', '人工智能正在改变世界', '');
    const a = store.recordAttempt(s, failingAttempt('claude', 'determinism.raf'), { source: SourceRender });
    const b = store.recordAttempt(s, failingAttempt('codex', 'determinism.raf'), { source: SourceRender });
    store.recordAttempt(s, failingAttempt('codex', 'output.audio'), { source: SourceRender });
    let brief = '';
    const drafter = async (workdir: string, prompt: string): Promise<void> => {
      // 被拒的草稿会带着原因再交回来改一稿；这里只看第一轮的说明。
      if (brief === '') brief = prompt;
      const good = lesson('timeline-not-raf', StatusActive, null, 'determinism.raf');
      good.from_episodes = [a.id, b.id];
      fs.writeFileSync(path.join(workdir, 'drafts', 'lessons', 'timeline-not-raf.md'), format(good));
      const bad = lesson('claude-tip', StatusTrial, null, 'determinism.raf');
      bad.body += '\nClaude 特别容易犯';
      bad.from_episodes = [a.id];
      fs.writeFileSync(path.join(workdir, 'drafts', 'lessons', 'claude-tip.md'), format(bad));
      const stray = lesson('stray-source', StatusTrial, ['cast'], 'output.frames');
      stray.from_episodes = ['ep-made-up'];
      fs.writeFileSync(path.join(workdir, 'drafts', 'lessons', 'stray-source.md'), format(stray));
    };
    const result = await store.consolidate({ minCount: 2, drafter });
    // 只有出现 2 次的组交给整理者。
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].key).toBe('determinism.raf');
    // 说明里应当有高频组与经历编号。
    expect(brief).toContain(a.id);
    expect(brief).not.toContain('output.audio ×');
    expect(brief).toContain('determinism.raf');
    // 应当收 1 拒 2。
    expect(result.accepted).toEqual(['timeline-not-raf']);
    expect(Object.keys(result.rejected).length).toBe(2);
    // 草稿一律进入试用，不论它自己写了什么状态。
    expect(store.find('timeline-not-raf')!.status).toBe(StatusTrial);
    const again = await store.consolidate({
      minCount: 1,
      drafter: async () => {
        throw new Error('上次整理之后没有新失败，不该再调用整理者');
      },
    });
    // 整理只看上次之后的经历。
    expect(again.clusters.length).toBe(0);
  });

  it('TestJudgeGates', () => {
    const questions: Question[] = [
      { id: 'q1', episode: '', holdout: false, scene_id: '', input: '' },
      { id: 'h1', episode: '', holdout: true, scene_id: '', input: '' },
    ];
    const renderers = ['claude', 'codex'];
    const cell = (q: string, r: string, arm: Arm, passed: boolean): Cell => {
      const c = newCell({ question: q, renderer: r, arm, passed, outcome: OutcomeSucceeded });
      if (!passed) {
        c.outcome = OutcomeVerificationFailed;
        c.problems = 2;
      }
      return c;
    };
    const matrix = (override: ((c: Cell) => void) | null): Cell[] => {
      const cells: Cell[] = [];
      for (const q of ['q1', 'h1']) {
        for (const r of renderers) cells.push(cell(q, r, ArmControl, q === 'h1'), cell(q, r, ArmTrial, true));
      }
      if (override) cells.forEach(override);
      return cells;
    };
    let v = judge(questions, renderers, matrix(null), false);
    // 试用组严格更好时应当通过。
    expect(v.pass).toBe(true);
    expect(v.trial_score).toBeGreaterThan(v.control_score);
    const regress = matrix((c) => {
      if (c.question === 'h1' && c.renderer === 'codex' && c.arm === ArmTrial) {
        c.passed = false;
        c.outcome = OutcomeVerificationFailed;
        c.problems = 1;
      }
    });
    v = judge(questions, renderers, regress, false);
    // 任意一个渲染工具上退步都不能通过。
    expect(v.pass).toBe(false);
    expect(v.reasons.join('')).toContain('codex');
    const same = matrix((c) => {
      if (c.question === 'q1' && c.arm === ArmTrial) {
        c.passed = false;
        c.outcome = OutcomeVerificationFailed;
        c.problems = 2;
      }
    });
    v = judge(questions, renderers, same, false);
    // 总分持平不能通过。
    expect(v.pass).toBe(false);
    expect(v.reasons.join('')).toContain('总分没有提高');
    const broken = matrix((c) => {
      if (c.renderer === 'claude' && c.arm === ArmControl && c.question === 'q1') {
        c.invalid = true;
        c.outcome = OutcomeFailed;
        c.error = 'Not logged in';
      }
    });
    v = judge(questions, renderers, broken, false);
    // 渲染工具自身故障使考试无效，而不是按 0 分处理。
    expect(v.pass).toBe(false);
    expect(v.invalid).toBe(true);
    // 缺格的考试无效。
    expect(judge(questions, renderers, matrix(null).slice(1), false).invalid).toBe(true);
    v = judge(questions, renderers, matrix(null), true);
    // 考试期间生效记忆变过要转人工确认。
    expect(v.pass).toBe(false);
    expect(v.needs_human).toBe(true);
    const repeated = [...matrix(null), cell('h1', 'claude', ArmTrial, false), cell('h1', 'claude', ArmTrial, false)];
    v = judge(questions, renderers, repeated, false);
    // 重复格按多数结果判定。
    expect(v.pass).toBe(false);
    expect(v.reasons.join('')).toContain('退步');
  });

  // 用假作答者跑完整条链：作答者只在召回了「有用」记忆时通过、召回了「有害」记忆时失败，
  // 有用的转为生效并生成快照，有害的被拒且不会被召回。
  it('TestExamPromotesHelpfulAndRejectsHarmfulLessons', async () => {
    const store = newStore();
    const project = tempDir();
    const s = writeSceneDir(path.join(project, 'scenes', 'scene-001'), 'scene-001', '中文标题', '');
    const failed = store.recordAttempt(s, failingAttempt('claude', 'determinism.raf'), { source: SourceRender });
    const holdout = writeSceneDir(path.join(project, 'scenes', 'scene-009'), 'scene-009', '另一个镜头', '');

    const helpful = lesson('timeline-not-raf', StatusTrial, null, 'determinism.raf');
    helpful.from_episodes = [failed.id];
    const harmful = lesson('loop-forever', StatusTrial, null, 'determinism.infinite-repeat');
    harmful.from_episodes = [failed.id];
    store.write(helpful);
    store.write(harmful);

    const run = async (sc: Scene, renderer: string): Promise<Attempt> => {
      const names = sc.memory?.names ?? [];
      if (names.includes('loop-forever')) return failingAttempt(renderer, 'determinism.infinite-repeat');
      if (names.includes('timeline-not-raf') || sc.id === 'scene-009') return newAttempt({ renderer, outcome: OutcomeSucceeded });
      return failingAttempt(renderer, 'determinism.raf');
    };
    const opts: ExamOptions = {
      renderers: ['claude', 'codex'],
      holdout: [holdout.directory],
      budget: 1500,
      workspace: path.join(project, 'production', 'memory-exams'),
      run,
      jobs: 3,
    };

    opts.trial = ['loop-forever'];
    const bad = await store.exam(opts);
    // 有害记忆应当被拒。
    expect(bad.verdict.pass).toBe(false);
    expect(bad.applied).toBe('rejected');
    const rejected = store.find('loop-forever')!;
    // 被拒记忆要保留原因。
    expect(rejected.status).toBe(StatusRejected);
    expect(rejected.rejected_reason).toContain(bad.id);

    opts.trial = ['timeline-not-raf'];
    const good = await store.exam(opts);
    // 有用的记忆应当生效并生成快照 #1。
    expect(good.verdict.pass).toBe(true);
    expect(good.applied).toBe('promoted');
    expect(good.snapshot).toBe(1);
    // 矩阵应当是 2 题 × 2 工具 × 2 组。
    expect(good.cells!.length).toBe(2 * 2 * 2);
    expect(good.questions!.length).toBe(2);
    const m = store.find('timeline-not-raf')!;
    // 生效记忆要记下考试编号。
    expect(m.status).toBe(StatusActive);
    expect(m.verified_by).toContain(good.id);
    // 正式召回只有生效记忆。
    expect(recallNames(store.recallScene(s, { budget: 1500 }))).toEqual(['timeline-not-raf']);
    // 考场应当建在项目里。
    for (const c of good.cells!) expect(c.workdir.startsWith(opts.workspace)).toBe(true);
    // 考试不计入效果统计。
    expect(Object.keys(store.stats()).length).toBe(0);
    // 两场考试都要留下记录。
    expect(store.exams().length).toBe(2);
    const kinds = store.timeline().map((e) => e.type);
    for (const want of [EventReject, EventExam, EventSnapshot, EventPromote]) expect(kinds).toContain(want);
  });

  it('TestPromoteRevisionRetiresPredecessor', () => {
    const store = newStore();
    store.write(lesson('font-old', StatusActive, ['cjk_text'], 'determinism.font-display'));
    store.takeSnapshot(EventManualEdit, '初始', true);
    const revision = lesson('font-new', StatusTrial, ['cjk_text'], 'determinism.font-display');
    revision.revises = 'font-old';
    store.write(revision);
    const s = writeSceneDir(tempDir(), 'scene-001', '中文', '');
    const trial = store.recallScene(s, { budget: 1500, extra: [revision] });
    // 试用组里修订取代旧版本，不能两版同时注入。
    expect(recallNames(trial)).toEqual(['font-new']);
    store.promote('font-new');
    // 修订生效后旧版本转为沉睡。
    expect(store.find('font-old')!.status).toBe(StatusDormant);
  });

  it('TestWeakMemoriesComparesAgainstBaseline', () => {
    const episodes: Episode[] = [];
    for (let i = 0; i < 6; i++) {
      episodes.push(newEpisode({ source: SourceRender, renderer: 'codex', recalled: ['useless'], outcome: OutcomeVerificationFailed }));
      episodes.push(newEpisode({ source: SourceRender, renderer: 'codex', outcome: OutcomeSucceeded }));
      episodes.push(newEpisode({ source: SourceRender, renderer: 'claude', recalled: ['useful'], outcome: OutcomeSucceeded }));
      episodes.push(newEpisode({ source: SourceRender, renderer: 'claude', outcome: OutcomeVerificationFailed }));
    }
    const weak = weakMemories(episodes, ['useless', 'useful']);
    // 只有不如基线的记忆是待沉睡候选。
    expect(weak).not.toBeNull();
    expect(weak!.length).toBe(1);
    expect(weak![0].name).toBe('useless');
    expect(weak![0].renderer).toBe('codex');
  });

  it('TestManualStatusChangesGuardTheirPreconditions', () => {
    const store = newStore();
    store.write(lesson('trial-one', StatusTrial, null, 'output.frames'));
    store.write(lesson('active-one', StatusActive, ['cast'], 'determinism.raf'));
    // 只有生效记忆能转为沉睡。
    expect(() => store.retire('trial-one', '')).toThrow();
    // 只有试用记忆能被拒。
    expect(() => store.reject('active-one', '')).toThrow();
    // 不存在的记忆不能确认生效。
    expect(() => store.promote('missing')).toThrow();
    store.reject('trial-one', '');
    const m = store.find('trial-one')!;
    // 人工拒绝要留下原因。
    expect(m.status).toBe(StatusRejected);
    expect(m.rejected_reason).toBe('人工拒绝');
    const snapshot = store.retire('active-one', '没帮上忙');
    // 沉睡后快照里不该再有它。
    expect(snapshot.entries).toEqual([]);
  });

  // 不同模型犯的错不一样，限定了渲染工具或模型的经验只召回给它们；模型未知时不召回限定了模型的经验。
  it('TestRecallRespectsRendererAndModelScope', () => {
    const general = lesson('general-rule', StatusActive, null, 'output.frames');
    const codexOnly = lesson('codex-rule', StatusActive, null, 'determinism.raf');
    codexOnly.applies_when = newApplies({ renderers: ['codex'] });
    const gpt6 = lesson('gpt6-rule', StatusActive, null, 'determinism.clock');
    gpt6.applies_when = newApplies({ models: ['GPT-6'] });
    const input: RecallInput = { memories: [general, codexOnly, gpt6], renderer: '', features: null, budget: 10000 };
    const cases: Array<[string, string, string[]]> = [
      ['codex', 'gpt-6-astra', ['gpt6-rule', 'codex-rule', 'general-rule']],
      ['codex', '', ['codex-rule', 'general-rule']],
      ['claude', 'claude-opus-5-5', ['general-rule']],
      ['opencode', 'gpt-6-mini', ['gpt6-rule', 'general-rule']],
    ];
    for (const [renderer, model, want] of cases) {
      input.renderer = renderer;
      input.model = model;
      // 专属经验排在通用经验前。
      expect(recallNames(recall(input))).toEqual(want);
    }
    input.renderer = 'codex';
    input.model = 'gpt-6-astra';
    // 召回理由要说明是专为哪个模型。
    expect(recallReason(recall(input).items[0])).toContain('专为 GPT-6');
    const scoped = cloneMemory(codexOnly);
    scoped.applies_when.renderers = ['vim'];
    // 范围里的渲染工具要校验。
    expect(lint(scoped, {}).join('')).toContain('未知渲染工具');
    const named = cloneMemory(general);
    named.body += '\ncodex 常犯这个错';
    // 正文写模型名时要提示改用范围字段。
    expect(lint(named, {}).join('')).toContain('applies_when.renderers');
    // 范围是规则内容的一部分。
    expect(ruleDigest(general)).not.toBe('');
    expect(ruleDigest(codexOnly)).not.toBe(ruleDigest(general));
  });

  it('TestModelIsObservedPerRendererAndClustered', () => {
    const store = newStore();
    const s = writeSceneDir(tempDir(), 'scene-001', '中文', '');
    // 没观测过时模型未知。
    expect(store.currentModel('claude', {})).toBe('');
    const a = failingAttempt('claude', 'determinism.raf');
    a.model = 'claude-opus-5-5';
    store.recordAttempt(s, a, { source: SourceRender });
    const b = failingAttempt('codex', 'determinism.raf');
    b.model = 'gpt-6-astra';
    store.recordAttempt(s, b, { source: SourceRender });
    store.recordAttempt(s, b, { source: SourceRender });
    // 应当记住最近实测到的模型。
    expect(store.currentModel('claude', {})).toBe('claude-opus-5-5');
    const clusters = clusterFailures(store.episodes());
    // 聚类要按渲染工具/模型计数。
    expect(clusters[0].models['codex/gpt-6-astra']).toBe(2);
    expect(clusters[0].models['claude/claude-opus-5-5']).toBe(1);
    const brief = consolidationBrief(clusters, null);
    // 整理说明里要有模型分布与范围写法。
    expect(brief).toContain('codex/gpt-6-astra × 2');
    expect(brief).toContain('applies_when.models');
  });

  // 用户亲口说的偏好当场生效，进入编排工具的偏好段；只对本项目成立的偏好不出现在别的项目里。
  it('TestRememberFeedsPreferenceBrief', () => {
    const store = newStore();
    const empty = store.preferenceBrief('demo', 0);
    // 空库也要告诉编排工具怎样记偏好。
    expect(empty.text).toContain('还没有记下任何偏好');
    expect(empty.text).toContain('memory_remember(');
    // 不在项目里又没加 --global 时应当报错。
    expect(() => store.remember({ body: '字幕用黄色' })).toThrow();
    const { memory: m, snapshot: snap } = store.remember({ name: 'yellow-captions', body: '字幕一律用黄色。底色深一些。', project: 'demo' });
    // 偏好应当当场生效、限本项目、描述取第一句。
    expect(m.status).toBe(StatusActive);
    expect(m.scope).toBe('demo');
    expect(m.description).toBe('字幕一律用黄色');
    expect(snap!.id).toBe(1);
    store.remember({ name: 'no-emoji', body: '画面里不要 emoji', global: true });
    const brief = store.preferenceBrief('demo', 0);
    expect(brief.text).toContain('【yellow-captions】（本项目）');
    expect(brief.text).toContain('【no-emoji】（全局）');
    expect(brief.digest).not.toBe(empty.digest);
    const other = store.preferenceBrief('other', 0).text;
    // 本项目的偏好不该出现在别的项目。
    expect(other).not.toContain('yellow-captions');
    expect(other).toContain('no-emoji');
    // 重名应当报错。
    expect(() => store.remember({ name: 'yellow-captions', body: 'x', project: 'demo' })).toThrow();
    store.remember({ name: 'white-captions', body: '字幕改用白色', project: 'demo', revises: 'yellow-captions' });
    // 被替换的偏好转为沉睡。
    expect(store.find('yellow-captions')!.status).toBe(StatusDormant);
    const s = writeSceneDir(path.join(tempDir(), 'demo', 'scenes', 'scene-001'), 'scene-001', '标题', '');
    fs.writeFileSync(path.join(path.dirname(path.dirname(s.directory)), 'onset.conf'), '');
    const names = recallNames(store.recallScene(s, { budget: 1500, renderer: 'claude' }));
    // 偏好也召回给渲染工具。
    expect(names).toContain('white-captions');
    expect(names).toContain('no-emoji');
  });

  // 事后检查查出的问题记到最近一次渲染上，同一份产物重复检查不重复计数，
  // 渲染时「通过」的产物在统计里不再算通过。
  it('TestCheckEpisodesInheritRenderAndDemoteStats', () => {
    const store = newStore();
    const s = writeSceneDir(tempDir(), 'scene-001', '中文', '');
    s.memory = { snapshot: 1, names: ['cjk-rule'], section: '', digest: '' };
    const render = newAttempt({ renderer: 'codex', model: 'gpt-6-astra', outcome: OutcomeSucceeded, fingerprint: 'fp1' });
    store.recordAttempt(s, render, { source: SourceRender, run: 'run-1' });
    // 检查前算通过。
    expect(store.stats()['cjk-rule']['codex/gpt-6-astra'].passed_first_try).toBe(1);
    s.memory = null;
    const finding = [{ check: 'reads.duration', problem: 'e1 可读 5 帧，还差 20 帧' }];
    const { episode: ep, recorded } = store.recordCheck(s, finding);
    expect(recorded).toBe(true);
    // 检查经历要继承最近一次渲染。
    expect(ep.renderer).toBe('codex');
    expect(ep.model).toBe('gpt-6-astra');
    expect(ep.fingerprint).toBe('fp1');
    expect(ep.run).toBe('run-1');
    expect(ep.recalled).toEqual(['cjk-rule']);
    // 同一份产物同一组问题不重复记录。
    expect(store.recordCheck(s, finding).recorded).toBe(false);
    // 事后查出问题的产物不算一次通过。
    expect(store.stats()['cjk-rule']['codex/gpt-6-astra']).toEqual({ recalled: 1, passed_first_try: 0 });
    const clusters = clusterFailures(store.episodes());
    // 检查问题进入聚类。
    expect(clusters.length).toBe(1);
    expect(clusters[0].key).toBe('reads.duration');
  });

  // 只由相邻镜头交接判定的经验考不了，转人工确认；引用空白帧的经验在考试里补查首帧。
  it('TestExamSkipsHandoffLessonsAndPostChecksBlankFrames', async () => {
    const store = newStore();
    const project = tempDir();
    const s = writeSceneDir(path.join(project, 'scenes', 'scene-001'), 'scene-001', '中文标题', '');
    const { episode: failed } = store.recordCheck(s, [{ check: 'frames.blank', problem: '第 0 帧是空白帧' }]);
    const handoff = lesson('handoff-carry', StatusTrial, null, 'review.handoff');
    handoff.from_episodes = [failed.id];
    store.write(handoff);
    const run = async (_sc: Scene, renderer: string): Promise<Attempt> => newAttempt({ renderer, outcome: OutcomeSucceeded });
    const opts: ExamOptions = { renderers: ['codex'], budget: 1500, workspace: path.join(project, 'production', 'memory-exams'), run };
    // 只有交接检查的经验考不了，要提示人工确认。
    await expect(store.exam(opts)).rejects.toThrow(/promote/);
    opts.trial = ['handoff-carry'];
    // 点名考交接经验时要说明原因。
    await expect(store.exam(opts)).rejects.toThrow(/单镜头回放考不了/);
    const cover = lesson('paint-first-frame', StatusTrial, null, 'frames.blank');
    cover.from_episodes = [failed.id];
    store.write(cover);
    opts.trial = null;
    const seen: string[][] = [];
    opts.postCheck = (sc, checks) => {
      seen.push(checks);
      if (sc.memory?.names?.includes('paint-first-frame')) return [];
      return [{ check: 'frames.blank', problem: '第 0 帧是空白帧' }];
    };
    const result = await store.exam(opts);
    // 只补查试用经验引用的校验器。
    for (const checks of seen) expect(checks).toEqual(['frames.blank']);
    // 补查首帧后试用组应当胜出。
    expect(result.verdict.pass).toBe(true);
    expect(result.trials).toEqual(['paint-first-frame']);
    for (const c of result.cells!) {
      // 对照组的空白首帧要被补查出来。
      if (c.arm === ArmControl) {
        expect(c.passed).toBe(false);
        expect(c.checks).toContain('frames.blank');
      }
    }
    // 考不了的经验保持试用，等人确认。
    expect(store.find('handoff-carry')!.status).toBe(StatusTrial);
  });

  // 单独一句话不算信号；在不同轮次反复提的要求、被回退的一轮才交给整理者。
  it('TestConversationSignalsBecomePreferenceCluster', async () => {
    const store = newStore();
    const project = path.join(tempDir(), 'demo');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'onset.conf'), '');
    const say = (turn: string, message: string, reverted: boolean) =>
      store.recordUtterance({ projectDir: project, session: 's1', turn, message, reverted });
    say('t1', '节奏再慢一点', false);
    say('t2', '把标题换成蓝色', false);
    say('t3', '再慢一点吧', false);
    say('t3', '再慢一点吧', false); // 同一轮重复记录不算
    say('t4', '开头加个爆炸特效', false);
    say('t4', '开头加个爆炸特效', true);
    say('t5', '慢一点，节奏慢一点', false);
    const episodes = store.episodes();
    // 同一轮只记一次说话、一次回退。
    expect(episodes.length).toBe(6);
    const signals = preferenceSignals(episodes);
    // 应当认出反复 3 次的要求与 1 次回退。
    expect(signals.length).toBe(2);
    expect(signals[0].kind).toBe('repeated');
    expect(signals[0].count).toBe(3);
    expect(signals[1].kind).toBe('reverted');
    expect(signals[0].project).toBe('demo');
    let brief = '';
    const result = await store.consolidate({
      minCount: 2,
      drafter: async (_workdir, b) => {
        brief = b;
      },
    });
    // 说明里要列出偏好信号。
    expect(brief).toContain('在 3 轮对话里反复提到');
    expect(brief).toContain('回退了这一轮');
    expect(brief).toContain('〔项目 demo〕');
    // 人的反应汇成一组。
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].key).toBe(ClusterKeyHuman);
    expect(result.clusters[0].count).toBe(4);
    const again = await store.consolidate({
      minCount: 1,
      drafter: async () => {
        throw new Error('已经整理过的信号不再交给整理者');
      },
    });
    // 没有新信号。
    expect(again.clusters.length).toBe(0);
    say('t6', '还是太快了，再慢一点', false);
    const fresh = await store.consolidate({ minCount: 1, draftsDir: tempDir() });
    // 新的一次提起让整组重新成为信号，次数按全部历史算。
    expect(fresh.clusters.length).toBe(1);
    expect((fresh.clusters[0] as Cluster).signals![0].count).toBe(4);
  });

  it('TestSimilarRequests', () => {
    for (const [a, b] of [
      ['节奏再慢一点', '慢一点，节奏慢一点'],
      ['再慢一点吧', '节奏再慢一点'],
      ['字幕大一点', '字幕再大一点'],
    ]) {
      // 应当算同一个要求。
      expect(similar(a, b), `${a} / ${b}`).toBe(true);
    }
    for (const [a, b] of [
      ['慢一点', '把背景亮一点'],
      ['把标题换成蓝色', '开头加个爆炸特效'],
      ['字幕大一点', '字幕小一点'],
    ]) {
      // 不是同一个要求。
      expect(similar(a, b), `${a} / ${b}`).toBe(false);
    }
  });

  it('TestPreferenceBriefAsksToConfirmDraftedPreferences', () => {
    const store = newStore();
    store.write(newMemory({ kind: KindPreference, name: 'slow-pacing', description: '节奏偏慢，每个画面多停一会', status: StatusTrial, checked_by: ['human'], body: '节奏偏慢' }));
    let brief = store.preferenceBrief('demo', 0).text;
    // 待确认的偏好要交给编排工具去问。
    expect(brief).toContain('待确认的偏好');
    expect(brief).toContain('【slow-pacing】');
    expect(brief).toContain('memory_promote(');
    store.promote('slow-pacing');
    brief = store.preferenceBrief('demo', 0).text;
    // 确认后转入生效偏好。
    expect(brief).not.toContain('待确认');
    expect(brief).toContain('【slow-pacing】（全局）');
  });

  // 按批次汇总一次通过率、重试、问题数（含事后检查）、耗时与 token，并按渲染工具/模型分开。
  it('TestRunReportComparesBatchesPerModel', () => {
    const ep = (run: string, renderer: string, model: string, outcome: string, retry: boolean, problems: number, ...recalled: string[]): Episode =>
      newEpisode({
        source: SourceRender,
        run,
        renderer,
        model,
        outcome,
        retry,
        seconds: 60,
        usage: { input_tokens: 100, output_tokens: 10 },
        recalled: recalled.length > 0 ? recalled : null,
        project: 'demo',
        scene_dir: '/p/' + run + renderer + String(problems),
        fingerprint: 'fp',
        created_at: run,
        problems: problems > 0 ? Array.from({ length: problems }, () => 'x') : null,
      });
    const episodes: Episode[] = [
      ep('run-1', 'codex', 'gpt-6', OutcomeVerificationFailed, false, 2),
      ep('run-1', 'codex', 'gpt-6', OutcomeSucceeded, true, 0),
      ep('run-1', 'claude', 'opus', OutcomeSucceeded, false, 0),
      ep('run-2', 'codex', 'gpt-6', OutcomeSucceeded, false, 0, 'a', 'b'),
      ep('run-2', 'claude', 'opus', OutcomeSucceeded, false, 1, 'a'),
      newEpisode({ source: SourceExam, run: '', renderer: 'codex', outcome: OutcomeSucceeded }),
    ];
    episodes.push({ ...episodes[4], source: 'check', problems: ['读不完', '剧透'], created_at: 'run-2z' });
    const runs = runReport(episodes);
    // 应当有两批。
    expect(runs.length).toBe(2);
    const [first, second] = runs;
    expect([first.scenes, first.passed_first_try, first.retries, first.problems, first.seconds, first.input_tokens]).toEqual([2, 1, 1, 2, 180, 300]);
    // 事后检查查出问题的镜头不算通过、问题计入。
    expect([second.scenes, second.passed_first_try, second.check_problems, second.problems, second.recalled]).toEqual([2, 1, 2, 3, 1.5]);
    // 按渲染工具/模型分开。
    expect(second.by_model['codex/gpt-6'].scenes).toBe(1);
    expect(second.by_model['codex/gpt-6'].pass_rate).toBe(1);
    expect(first.by_model['codex/gpt-6'].pass_rate).toBe(0);
    expect(first.by_model['codex/gpt-6'].retries).toBe(1);
  });

  // 统计按模型分开，换了模型以后旧模型的效果只当弱证据；考试时用的模型与现在不同时提示重考，
  // 重考对照组去掉它。
  it('TestModelChangeDownweightsStatsAndAsksForRetest', async () => {
    const stats = { 'codex/gpt-6': { recalled: 10, passed_first_try: 10 } };
    const same = smoothedRate(stats, 'codex', 'gpt-6');
    const other = smoothedRate(stats, 'codex', 'gpt-7');
    // 同模型应当高于换了模型的，后者仍略高于 0.5。
    expect(same).toBeGreaterThan(other);
    expect(other).toBeGreaterThan(0.5);

    const store = newStore();
    const project = tempDir();
    const s = writeSceneDir(path.join(project, 'scenes', 'scene-001'), 'scene-001', '中文标题', '');
    const failed = store.recordAttempt(s, failingAttempt('codex', 'determinism.raf'), { source: SourceRender });
    const rule = lesson('timeline-not-raf', StatusTrial, null, 'determinism.raf');
    rule.from_episodes = [failed.id];
    store.write(rule);
    let model = 'gpt-6';
    const run = async (sc: Scene, renderer: string): Promise<Attempt> => {
      if (sc.memory?.names?.includes('timeline-not-raf')) return newAttempt({ renderer, model, outcome: OutcomeSucceeded });
      const a = failingAttempt(renderer, 'determinism.raf');
      a.model = model;
      return a;
    };
    const opts: ExamOptions = { renderers: ['codex'], budget: 1500, workspace: path.join(project, 'production', 'memory-exams'), run };
    // 先在 gpt-6 上考过。
    expect((await store.exam(opts)).applied).toBe('promoted');
    let current = (_: string) => 'gpt-6';
    // 模型没变不用重考。
    expect(store.status(false, current).retest).toEqual([]);
    model = 'gpt-7';
    current = () => 'gpt-7';
    const report = store.status(false, current);
    // 换了模型要提示重考。
    expect(report.retest.length).toBe(1);
    expect(report.retest[0].current_model).toBe('gpt-7');
    expect(report.retest[0].examined_models[0]).toBe('gpt-6');
    opts.retest = ['timeline-not-raf'];
    opts.modelOf = current;
    const result = await store.exam(opts);
    // 对照组去掉它后应当显出提升。
    expect(result.applied).toBe('retest-passed');
    // 重考的对照组不该召回它。
    for (const c of result.cells!) if (c.arm === ArmControl) expect(c.recalled ?? []).not.toContain('timeline-not-raf');
    // 在新模型上考过就不用再重考。
    expect(store.status(false, current).retest).toEqual([]);
    opts.retest = ['missing'];
    // 只能重考生效经验。
    await expect(store.exam(opts)).rejects.toThrow();
  });
});
