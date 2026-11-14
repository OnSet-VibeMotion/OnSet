import './testsupport';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as memory from '../memory';
import * as scene from '../scene';
import { renderRecord } from './turns';
import { args, newSessionFixture, setEnv, startStudio, studioRequest, tempDir, waitIdle, writeStudioFile, type SessionFixture } from './testsupport';

describe('studio memory', () => {
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
    const memoryDir = tempDir();
    setEnv('ONSET_MEMORY_DIR', memoryDir);
    let { status, body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"title":"信号"}');
    expect(status).toBe(201);
    const id = body.session_id as string;
    ({ status, body } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, '{"message":"节奏再慢一点"}'));
    expect(status).toBe(202);
    const turnID = body.turn_id as string;
    await waitIdle(f, id);
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
