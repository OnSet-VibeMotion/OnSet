import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as memory from '../memory';
import * as scene from '../scene';
import { writeSceneDir } from '../memory/testsupport';
import { renderRecord } from './turns';
import * as tasks from './tasks';
import { args, newSessionFixture, setEnv, startStudio, studioRequest, tempDir, waitIdle, waitStudioTask, writeStudioFile, type SessionFixture } from './testsupport';

describe('studio memory', () => {
  it('audits legacy empty-inventory gains without rewriting history or changing memory status', async () => {
    const root=tempDir();
    setEnv('ONSET_MEMORY_DIR', tempDir());
    writeStudioFile(path.join(root,'onset.conf'),'RENDERER=claude\n');
    const sc=writeSceneDir(path.join(root,'scenes','scene-001'),'scene-001','验证','');
    const store=memory.open(process.env.ONSET_MEMORY_DIR!);
    const source=store.recordAttempt(sc,scene.newAttempt({renderer:'claude',outcome:scene.OutcomeVerificationFailed,checks:['reads.duration'],problems:['太短']}),{source:memory.SourceRender});
    const m=memory.newMemory({name:'reading-rule',kind:memory.KindLesson,status:memory.StatusTrial,description:'阅读停留',body:'反例：太短。正例：停够。',
      from_episodes:[source.id],checked_by:['reads.duration']});
    store.write(m);
    const exam=await store.exam({renderers:['claude'],trial:[m.name],budget:1500,workspace:path.join(root,'production','memory-exams'),
      run:async()=>scene.newAttempt({outcome:scene.OutcomeSucceeded}),
      // 模拟旧版补查没有完整性标记的历史结果。
      postCheck:s=>s.memory?.names?.includes(m.name)?[]:[{check:'reads.duration',problem:path.join(s.directory,'visible-events.json')+' 的 events 为空'}]});
    expect(exam.verdict.pass).toBe(true);
    const s=startStudio({projectPath:root,configPath:path.join(tempDir(),'projects.json')});
    const response=await studioRequest(s,'GET','/api/memory');
    const view=response.body.exams.find((e:{id:string})=>e.id===exam.id);
    expect(view.verdict).toMatchObject({pass:false,needs_human:true});
    expect(view.evaluation_note).toContain('原始考试记录保留');
    expect(view.cells[0].incomplete).toBe(true);
    expect(store.exams()[0].verdict.pass).toBe(true);
    expect(store.find(m.name)?.status).toBe(memory.StatusActive);
  });

  it('prioritizes compound subtitle candidates without claiming they are broken', async () => {
    const root = tempDir();
    setEnv('ONSET_MEMORY_DIR', tempDir());
    writeStudioFile(path.join(root, 'onset.conf'), 'RENDERER=claude\n');
    for (const id of ['scene-001', 'scene-002']) {
      const dir = path.join(root, 'scenes', id);
      const sc = writeSceneDir(dir, id, '分层阅读', '');
      writeStudioFile(path.join(dir, 'scene.json'), JSON.stringify({
        id, duration_seconds: 3, output: 'out.mp4', transcript: sc.transcript, text: sc.text,
        timing: { fps: 30, start_frame: 0, end_frame_exclusive: 90, plan: 'a'.repeat(64), phrases: 'phrases.json' },
      }));
      writeStudioFile(path.join(dir, sc.transcript), `1\n00:00:00,000 --> 00:00:03,000\n${id === 'scene-002' ? '先整理，再比较。' : '先整理。'}\n`);
      writeStudioFile(path.join(dir, 'phrases.json'), JSON.stringify({ schema: 1, fps: 30, phrases: [
        { phrase_id: 'sort', source_text: '整理', semantic_order: 1, start_frame: 10, end_frame_exclusive: 40 },
        { phrase_id: 'compare', source_text: '比较', semantic_order: 2, start_frame: 45, end_frame_exclusive: 75 },
      ] }));
    }
    const store = memory.open(process.env.ONSET_MEMORY_DIR!);
    const source = store.recordAttempt(scene.load(path.join(root, 'scenes', 'scene-001')),
      scene.newAttempt({ renderer: 'claude', outcome: scene.OutcomeVerificationFailed, checks: ['reads.order'], problems: ['顺序倒退'] }), { source: memory.SourceRender });
    store.write(memory.newMemory({ name: 'read-order', kind: memory.KindLesson, status: memory.StatusTrial,
      description: '核对跨层阅读顺序', body: '反例：文字倒序。正例：核对各层。',
      applies_when: memory.newApplies({ features: ['timing'] }), checked_by: ['reads.order'], from_episodes: [source.id] }));
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const result = await studioRequest(s, 'GET', '/api/memory/applications?name=read-order');
    expect(result.status).toBe(200);
    expect(result.body.matches).toMatchObject([
      { scene_id: 'scene-002', selected: true, source_scene: false, reading_context: { compound_cues: [1], hint: expect.stringContaining('不代表已经出错') } },
      { scene_id: 'scene-001', selected: true, source_scene: true, reading_context: { compound_cues: [], hint: expect.stringContaining('仅匹配召回条件') } },
    ]);
    expect(store.find('read-order')?.status).toBe(memory.StatusTrial);
    expect(store.episodes()).toHaveLength(1);
  });

  it.each([false, true])('matches source scene aliases without rewriting history (removed: %s)', async (removed) => {
    const root = tempDir();
    setEnv('ONSET_MEMORY_DIR', tempDir());
    writeStudioFile(path.join(root, 'onset.conf'), 'RENDERER=claude\n');
    writeSceneDir(path.join(root, 'scenes', 'scene-001'), 'scene-001', '中文标题', '');
    const alias = path.join(tempDir(), 'project-alias');
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const store = memory.open(process.env.ONSET_MEMORY_DIR!);
    const source = store.recordAttempt(scene.load(path.join(alias, 'scenes', 'scene-001')),
      scene.newAttempt({ renderer: 'claude', outcome: scene.OutcomeVerificationFailed, checks: ['determinism.remote-font'], problems: ['远程字体'] }), { source: memory.SourceRender });
    store.write(memory.newMemory({ name: 'local-font', kind: memory.KindLesson, status: memory.StatusTrial,
      description: '中文字体用本地文件', body: '反例：远程字体。正例：本地字体。',
      applies_when: memory.newApplies({ features: ['cjk_text'] }), checked_by: ['determinism.remote-font'], from_episodes: [source.id] }));
    if (removed) fs.unlinkSync(alias);
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const result = await studioRequest(s, 'GET', '/api/memory/applications?name=local-font');
    expect(result.status).toBe(200);
    expect(result.body.unreadable).toBe(0);
    expect(result.body.matches).toMatchObject([{ scene_id: 'scene-001', selected: true, source_scene: !removed }]);
    expect(store.episodes()[0].scene_dir).toBe(source.scene_dir);
  });

  it('finds applicable scenes without reactivating a stopped lesson and respects scope and budget', async () => {
    const root = tempDir();
    const dir = tempDir();
    setEnv('ONSET_MEMORY_DIR', dir);
    writeStudioFile(path.join(root, 'onset.conf'), 'RENDERER=claude\nMEMORY=on\n');
    writeSceneDir(path.join(root, 'scenes', 'scene-001'), 'scene-001', '中文标题', '');
    writeSceneDir(path.join(root, 'scenes', 'scene-002'), 'scene-002', 'English', '');
    const store = memory.open(dir);
    store.write(memory.newMemory({ name: 'local-font', kind: memory.KindLesson, status: memory.StatusDormant,
      description: '中文字体用本地文件', body: '反例：远程字体。正例：本地字体。', applies_when: memory.newApplies({ features: ['cjk_text'] }), checked_by: ['determinism.remote-font'] }));
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const get = () => studioRequest(s, 'GET', '/api/memory/applications?name=local-font');
    let result = await get();
    expect(result.status).toBe(200);
    expect(result.body.scanned).toBe(2);
    expect(result.body.matches).toMatchObject([{ scene_id: 'scene-001', selected: true, features: ['cjk_text'] }]);
    expect(store.find('local-font')?.status).toBe(memory.StatusDormant);
    expect(store.latestSnapshot()).toBeNull();
    const m = store.find('local-font')!;
    m.applies_when.models = ['unavailable-model'];
    store.write(m);
    expect((await get()).body.matches).toEqual([]);
    m.applies_when.models = [];
    m.applies_when.renderers = ['codex'];
    store.write(m);
    expect((await get()).body.matches).toEqual([]);
    m.applies_when.renderers = [];
    store.write(m);
    setEnv('MEMORY_RECALL_BUDGET', '1');
    result = await get();
    expect(result.body.matches).toMatchObject([{ scene_id: 'scene-001', selected: false, omit_reason: 'budget' }]);
    expect(store.episodes()).toEqual([]);
  });

  it('resolves selected exam scene IDs to project directories and rejects outside paths', async () => {
    const root = tempDir();
    const projectRoot = fs.realpathSync(root);
    writeStudioFile(path.join(root, 'onset.conf'), 'RENDERER=claude\n');
    writeSceneDir(path.join(root, 'scenes', 'scene-001'), 'scene-001', '考题', '');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const operation = vi.spyOn(tasks, 'runStudioOp').mockResolvedValue({ text: '' });
    try {
      expect((await studioRequest(s, 'POST', '/api/memory/actions/exam', '{"renderers":["claude"],"name":"local-font","scenes":["../outside"]}')).status).toBe(400);
      const { status, body } = await studioRequest(s, 'POST', '/api/memory/actions/exam', '{"renderers":["claude"],"name":"local-font","scenes":["scene-001","scene-001"]}');
      expect(status).toBe(202);
      await waitStudioTask(s, body.task_id);
      expect(operation.mock.calls[0].slice(3, 5)).toEqual(['memory_exam', { renderers: 'claude', retest: 'local-font', holdout: [path.join(projectRoot, 'scenes', 'scene-001')] }]);
      expect((await studioRequest(s, 'POST', '/api/memory/actions/exam', '{"renderers":["claude"],"name":"local-font","holdout_only":true}')).status).toBe(400);
      const migration = await studioRequest(s, 'POST', '/api/memory/actions/exam', '{"renderers":["claude"],"name":"local-font","scenes":["scene-001"],"holdout_only":true}');
      expect(migration.status).toBe(202);
      await waitStudioTask(s, migration.body.task_id);
      expect(operation.mock.calls[1].slice(3, 5)).toEqual(['memory_exam', { renderers: 'claude', retest: 'local-font', holdout: [path.join(projectRoot, 'scenes', 'scene-001')], holdout_only: true }]);
    } finally { operation.mockRestore(); }
  });

  it('dispatches a selected trial without turning it into an active-lesson retest', async () => {
    const root = tempDir();
    writeStudioFile(path.join(root, 'onset.conf'), 'RENDERER=claude\n');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const operation = vi.spyOn(tasks, 'runStudioOp').mockResolvedValue({ text: '' });
    try {
      const { status, body } = await studioRequest(s, 'POST', '/api/memory/actions/exam', '{"renderers":["claude"],"trial":"rule-a"}');
      expect(status).toBe(202);
      expect((await waitStudioTask(s, body.task_id)).status).toBe('succeeded');
      expect(operation).toHaveBeenCalledOnce();
      expect(operation.mock.calls[0].slice(3, 5)).toEqual(['memory_exam', { renderers: 'claude', trial: 'rule-a' }]);
    } finally {
      operation.mockRestore();
    }
  });

  // 面板的读接口只读记忆库，「本镜头想起了什么」给出召回条目与理由；考场里的镜头副本不出现在镜头列表里。
  it('memory panel reads store and recalls for scene', async () => {
    const root = tempDir();
    const memoryDir = tempDir();
    setEnv('ONSET_MEMORY_DIR', memoryDir);
    writeStudioFile(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\nMEMORY=on\n');
    writeStudioFile(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
    const sceneDir = path.join(root, 'scenes', 'scene-001');
    writeStudioFile(path.join(sceneDir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
    writeStudioFile(
      path.join(sceneDir, 'scene.json'),
      '{"id":"scene-001","duration_seconds":2,"output":"out.mp4","transcript":"transcript.srt","text":"中文标题"}',
    );
    const exam = path.join(root, 'production', 'memory-exams', 'exam-0001', 'q1', 'claude-trial-1');
    writeStudioFile(path.join(exam, 'scene.json'), '{"id":"scene-001","duration_seconds":2,"output":"out.mp4"}');

    const store = memory.open(memoryDir);
    store.write(
      memory.newMemory({
        kind: memory.KindLesson,
        name: 'cjk-font-local',
        description: '中文字体用本地文件',
        status: memory.StatusActive,
        applies_when: memory.newApplies({ features: ['cjk_text'] }),
        checked_by: ['determinism.remote-font'],
        body: '反例：x\n正例：y',
      }),
    );
    store.takeSnapshot(memory.EventManualEdit, '初始', true);

    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    let { status, body } = await studioRequest(s, 'GET', '/api/scenes');
    expect(status).toBe(200);
    expect(body.scenes, '考场里的镜头副本不该算作项目镜头').toHaveLength(1);
    ({ status, body } = await studioRequest(s, 'GET', '/api/memory'));
    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.memories).toHaveLength(1);
    expect(body.snapshots).toHaveLength(1);
    // 记忆库所有项目共用：经历事件带项目名，面板据此只显示本项目的。
    store.recordAttempt(scene.load(sceneDir), scene.newAttempt({ scene_id: 'scene-001', renderer: 'claude', outcome: scene.OutcomeSucceeded }), {
      source: memory.SourceRender,
    });
    ({ status, body } = await studioRequest(s, 'GET', '/api/memory'));
    expect(status).toBe(200);
    expect(body.project).toBe(path.basename(root));
    expect(body.timeline[0].project).toBe(body.project);

    ({ status, body } = await studioRequest(s, 'GET', '/api/memory/recall?scene=scene-001'));
    expect(status).toBe(200);
    expect(body.reasons).toHaveLength(1);
    expect(body.reasons[0]).toContain('cjk_text');
    expect(body.section).toContain('cjk-font-local');

    expect((await studioRequest(s, 'POST', '/api/memory/actions/promote', '{"name":"../x"}')).status).toBe(400);
    expect((await studioRequest(s, 'POST', '/api/memory/actions/exam', '{"renderers":["rm -rf"]}')).status).toBe(400);
    expect((await studioRequest(s, 'POST', '/api/memory/actions/exam', '{"renderers":["claude"],"trial":"../x"}')).status).toBe(400);
    expect((await studioRequest(s, 'POST', '/api/memory/actions/exam', '{"renderers":["claude"],"trial":"rule-a","name":"rule-b"}')).status).toBe(400);
    expect((await studioRequest(s, 'POST', '/api/memory/actions/shell', '{}')).status).toBe(404);
  });

  // 进化页要的三样：考试每一格的画面（产物名取自考场里的 scene.json，不是写死的 out.mp4）、
  // 查出的问题原文与镜头口播、所有项目的渲染批次。
  it('exam cells carry their output, problem texts and narration', async () => {
    const root = tempDir();
    const memoryDir = tempDir();
    setEnv('ONSET_MEMORY_DIR', memoryDir);
    writeStudioFile(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\nMEMORY=on\n');
    writeStudioFile(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
    const sceneDir = path.join(root, 'scenes', 'scene-001');
    writeStudioFile(path.join(sceneDir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
    writeStudioFile(
      path.join(sceneDir, 'scene.json'),
      '{"id":"scene-001","duration_seconds":2,"output":"scene-001.mp4","transcript":"transcript.srt","text":"中文标题"}',
    );
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const project = (await studioRequest(s, 'GET', '/api/state')).body.project.path as string;
    const store = memory.open(memoryDir);
    const sc = scene.load(path.join(project, 'scenes', 'scene-001'));
    store.recordAttempt(sc, scene.newAttempt({ scene_id: 'scene-001', renderer: 'claude', outcome: scene.OutcomeSucceeded }), {
      source: memory.SourceRender,
      run: 'run-20261112-000000',
    });
    const { episode: failed } = store.recordCheck(sc, [{ check: 'frames.blank', problem: '第 0 帧是空白帧' }]);
    store.write(
      memory.newMemory({
        kind: memory.KindLesson,
        name: 'paint-first-frame',
        description: '第 0 帧就要有画面',
        status: memory.StatusTrial,
        checked_by: ['frames.blank'],
        from_episodes: [failed.id],
        body: '反例：x\n正例：y',
      }),
    );
    await store.exam({
      renderers: ['claude'],
      budget: 1500,
      workspace: path.join(project, 'production', 'memory-exams'),
      run: async (cell, renderer) => {
        const live = (await studioRequest(s, 'GET', '/api/memory')).body.exam_progress;
        expect(live).toHaveLength(1);
        expect(live[0].questions[0].text).toBe('中文标题');
        expect(live[0].cells.some((c: { status: string }) => c.status === 'running')).toBe(true);
        writeStudioFile(path.join(cell.directory, 'scene-001.mp4'), 'video');
        return scene.newAttempt({ scene_id: cell.id, renderer, outcome: scene.OutcomeSucceeded });
      },
      postCheck: (cell) => (cell.memory?.names?.includes('paint-first-frame') ? [] : [{ check: 'frames.blank', problem: '第 0 帧是空白帧' }]),
    });

    const { status, body } = await studioRequest(s, 'GET', '/api/memory');
    expect(status).toBe(200);
    expect(body.exams).toHaveLength(1);
    const exam = body.exams[0];
    expect(exam.questions[0].text).toBe('中文标题');
    const control = exam.cells.find((c: { arm: string }) => c.arm === 'control');
    const trial = exam.cells.find((c: { arm: string }) => c.arm === 'trial');
    expect(control.output).toMatch(/^production\/memory-exams\/exam-0001\/q1\/claude-control-1\/scene-001\.mp4$/);
    expect(trial.output).toMatch(/claude-trial-1\/scene-001\.mp4$/);
    expect(control.problem_texts).toEqual(['第 0 帧是空白帧']);
    expect(trial.problem_texts).toBeUndefined();
    expect(body.runs_all.map((r: { run: string }) => r.run)).toContain('run-20261112-000000');
  });

  // 用户偏好交给编排工具，让它能按偏好理解简短的要求；偏好没变时续接的会话不重复发送，
  // 偏好变了下一轮就带上新版本。
  it('chat turns carry user preferences', async () => {
    const f = newSessionFixture();
    const memoryDir = tempDir();
    setEnv('ONSET_MEMORY_DIR', memoryDir);
    const store = memory.open(memoryDir);
    store.remember({ name: 'calm-palette', body: '配色克制，不要满屏霓虹', global: true });
    const { status, body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"title":"偏好"}');
    expect(status).toBe(201);
    const id = body.session_id as string;
    const turn = async (fixture: SessionFixture, message: string): Promise<string> => {
      const res = await studioRequest(fixture.s, 'POST', `/api/sessions/${id}/turns`, JSON.stringify({ message }));
      expect(res.status).toBe(202);
      await waitIdle(fixture, id);
      const lines = args(fixture);
      return lines[lines.length - 1];
    };
    const first = await turn(f, '来个科普的');
    expect(first, '第一轮应当带上用户偏好').toContain('【calm-palette】');
    expect(first).toContain('memory_remember(');
    expect(await turn(f, '再快一点'), '偏好没变时续接的会话不重复发送').not.toContain('用户偏好');
    store.remember({ name: 'no-emoji', body: '画面里不要 emoji', global: true });
    expect(await turn(f, '换个开头'), '偏好变了下一轮要带上新版本').toContain('【no-emoji】');
  });

  // 每轮说的话和回退都留下信号，整理时据此归纳偏好。
  it('chat turns and reverts become conversation episodes', async () => {
    const f = newSessionFixture();
    const clock = vi.spyOn(memory.Store.prototype, 'clock').mockReturnValue(new Date('2026-11-14T10:00:00.100Z'));
    onTestFinished(() => clock.mockRestore());
    const memoryDir = tempDir();
    setEnv('ONSET_MEMORY_DIR', memoryDir);
    let { status, body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"title":"信号"}');
    expect(status).toBe(201);
    const id = body.session_id as string;
    ({ status, body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"节奏再慢一点"}'));
    expect(status).toBe(202);
    const turnID = body.turn_id as string;
    await waitIdle(f, id);
    clock.mockReturnValue(new Date('2026-11-14T10:00:00.101Z'));
    ({ status, body } = await studioRequest(f.s, 'POST', `/api/turns/${turnID}/revert`, '{}'));
    expect(status).toBe(200);
    const episodes = memory.open(memoryDir).episodes();
    expect(episodes, '应当记下说的话与回退').toHaveLength(2);
    expect(episodes[0].feedback?.verdict).toBe('said');
    expect(episodes[1].feedback?.verdict).toBe('down');
    expect(episodes[1].text).toBe('节奏再慢一点');
    expect(episodes[0].turn).toBe(turnID);
  });

  // 镜头列表带全部尝试的用量合计；尝试记录只记 stat，回退一轮不会把已经花掉的 token 从账上抹掉。
  it('scenes report render usage and keep attempt records on revert', async () => {
    const root = tempDir();
    const dir = path.join(root, 'scenes', 'scene-001');
    writeStudioFile(path.join(dir, 'scene.json'), '{"id":"scene-001","duration_seconds":1,"output":"out.mp4"}');
    writeStudioFile(
      path.join(dir, 'attempts', 'attempt-01', 'render-scene-001.attempt.json'),
      '{"renderer":"claude","outcome":"failed","started_at":"1","usage":{"input_tokens":44,"cached_input_tokens":40,"output_tokens":1,"source":"claude result","basis":"total-input"}}',
    );
    writeStudioFile(
      path.join(dir, 'render-scene-001.attempt.json'),
      '{"renderer":"codex","outcome":"succeeded","started_at":"2","usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":5,"source":"codex turn.completed","basis":"total-input"}}',
    );
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const { status, body } = await studioRequest(s, 'GET', '/api/scenes');
    expect(status).toBe(200);
    const first = body.scenes[0];
    // 两次尝试的用量相加：44 + 100。
    expect(first.attempts).toBe(2);
    expect(first.usage.input_tokens).toBe(144);
    expect(first.usage.output_tokens).toBe(6);
    expect(renderRecord(path.join(dir, 'render-scene-001.attempt.json')), '只有尝试记录按 stat 处理').toBe(true);
    expect(renderRecord(path.join(dir, 'scene.json'))).toBe(false);
  });
});
