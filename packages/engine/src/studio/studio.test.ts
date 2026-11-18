//
// 不移植：
// - TestListenAndServeStopsWithContext：TS 版后端不监听端口，Electron 主进程经 onset://app/ 协议直接调 handle。
// - TestStudioContentAndTaskEndpoints 里静态文件的两条（/missing-asset.js 404、/some/route 回落到 index.html）：
//   界面文件由 Electron 加载，这里不服务。
// - 「/api/scenes/scene-001/frames/../evil.jpg」那一条：Go 版绕过 ServeMux 直接调 sceneFeatureAPI，
//   这里同样直接调 sceneFeatureAPI（handle 会先把不规整的路径 301 掉）。
import './testsupport';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sceneFeatureAPI } from './features';
import * as flow from '../flow';
import { deliverySpec, ReviewWorkDirEnv, scenePlanDigest } from '../review';
import { canvasOf } from '../scene';
import * as studioview from '../studioview';
import { computeStations } from './progress';
import { projectMetadata, stageFor, stepOf } from './studio';
import { writeStepMark } from './view';
import { addTask, runTask, updateTask } from './tasks';
import * as tasks from './tasks';
import { rawGet, setEnv, sleep, startStudio, studioRequest, tempDir, waitStudioTask, writeStudioFile, writeStudioPNG } from './testsupport';

describe('studio', () => {
  it('identifies the reviewed video and prefers a report for the requested video', async () => {
    const root = fs.realpathSync(tempDir());
    const final = 'production/final.mp4';
    const candidate = 'production/audio/candidate.mp4';
    const older = path.join(root, 'production/review-old/review.json');
    writeStudioFile(older, JSON.stringify({ path: candidate, problems: ['candidate'] }));
    fs.utimesSync(older, 1, 1);
    writeStudioFile(path.join(root, 'production/review/review.json'), JSON.stringify({ path: path.join(root, final), problems: [] }));
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const query = (video: string) => '/api/review?video=' + encodeURIComponent(video);
    expect((await studioRequest(s, 'GET', '/api/review')).body).toMatchObject({ available: true, path: final });
    expect((await studioRequest(s, 'GET', query(candidate))).body).toMatchObject({
      available: true, path: candidate, report: { problems: ['candidate'] },
    });
    expect((await studioRequest(s, 'GET', query('final.mp4'))).body).toMatchObject({ available: true, path: final });
    expect((await studioRequest(s, 'POST', '/api/review/run', '{"video":"../outside.mp4"}')).status).toBe(400);
    expect((await studioRequest(s, 'POST', '/api/review/run', '{"video":"final.mp4"}')).status).toBe(404);
    const silent = 'production/silent-master.mp4';
    writeStudioFile(path.join(root, final), 'unselected final');
    writeStudioFile(path.join(root, candidate), 'unselected candidate');
    writeStudioFile(path.join(root, silent), 'selected silent master');
    writeStudioFile(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 240, height_px: 320, fps: 30}\n---\n');
    writeStudioFile(path.join(root, 'production/timing-report.json'), '{"total_frames":30}');
    const worker = vi.spyOn(tasks, 'runStudioOp').mockResolvedValue({ text: '' });
    try {
      const started = await studioRequest(s, 'POST', '/api/review/run', JSON.stringify({ video: silent }));
      expect(started.status).toBe(202);
      expect((await waitStudioTask(s, started.body.task_id)).status).toBe('succeeded');
      expect(worker).toHaveBeenCalledExactlyOnceWith(s, expect.any(AbortSignal), expect.objectContaining({ path: root }), 'review', {
        video: path.join(root, silent), out: path.join(root, 'production/review-silent'), silent: true,
        expect_frames: 30, validate_report: 'production/review-silent/validate.json',
      }, { env: { [ReviewWorkDirEnv]: expect.any(String) } });
      const scenes = path.join(root, 'scenes');
      writeStudioFile(path.join(scenes, 'scene-001/scene.json'), '{"id":"scene-001","duration_seconds":1.1,"output":"out.mp4","transcript":"voice.srt","text":"一句"}');
      writeStudioFile(path.join(scenes, 'scene-001/voice.srt'), '1\n00:00:00,000 --> 00:00:01,100\n一句\n');
      for (const timing of ['{"total_frames":30}', '{']) {
        writeStudioFile(path.join(root, 'production/timing-report.json'), timing);
        const latest = await studioRequest(s, 'POST', '/api/review/run', JSON.stringify({ video: silent }));
        const task = await waitStudioTask(s, latest.body.task_id);
        expect(task.status, String(task.error ?? '')).toBe('succeeded');
        expect(worker).toHaveBeenLastCalledWith(s, expect.any(AbortSignal), expect.objectContaining({ path: root }), 'review',
          expect.objectContaining({ expect_frames: 33, scenes }), { env: { [ReviewWorkDirEnv]: expect.any(String) } });
      }
    } finally {
      worker.mockRestore();
    }
  });

  it('removes the review work directory after a cancelled worker finishes', async () => {
    const root = fs.realpathSync(tempDir());
    writeStudioFile(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 240, height_px: 320, fps: 30}\n---\n');
    writeStudioFile(path.join(root, 'production/timing-report.json'), '{"total_frames":30}');
    writeStudioFile(path.join(root, 'final.mp4'), 'film');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    let work = '';
    let finish = () => {};
    const worker = vi.spyOn(tasks, 'runStudioOp').mockImplementation(async (_server, _signal, _project, _op, _params, opts) => {
      work = opts?.env?.[ReviewWorkDirEnv] ?? '';
      expect(work).not.toBe('');
      writeStudioFile(path.join(work, 'snapshot/film.mp4'), 'snapshot');
      await new Promise<void>((resolve) => { finish = resolve; });
      return { text: '' };
    });
    try {
      const response = await studioRequest(s, 'POST', '/api/review/run', '{"video":"final.mp4"}');
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(work).not.toBe(''));
      expect((await studioRequest(s, 'POST', `/api/tasks/${response.body.task_id}/cancel`)).status).toBe(200);
      expect(fs.existsSync(work)).toBe(true);
      finish();
      await vi.waitFor(() => expect(fs.existsSync(work)).toBe(false));
    } finally {
      finish();
      worker.mockRestore();
    }
  });

  it('displays legacy reviews but approves only the exact film with a passing delivery review', async () => {
    const root = fs.realpathSync(tempDir());
    const video = 'final.mp4';
    const file = path.join(root, video);
    const report = path.join(root, 'production/review/review.json');
    const sha = crypto.createHash('sha256').update('film').digest('hex');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const read = () => studioRequest(s, 'GET', '/api/review?video=final.mp4');
    const approve = () => studioRequest(s, 'POST', '/api/memory/actions/consolidate', JSON.stringify({ final: true, video, video_sha256: sha }));
    const frameFile = path.join(root, 'frame.md');
    const frame = '---\ncanvas: {width_px: 240, height_px: 320, fps: 30}\n---\n';
    writeStudioFile(frameFile, frame);
    writeStudioFile(path.join(root, 'production/timing-report.json'), '{"total_frames":30}');
    const spec = deliverySpec(canvasOf(root, 'frame.md'), 30, false);
    writeStudioFile(file, 'film');
    writeStudioFile(report, JSON.stringify({ path: video, ok: true, problems: [] }));
    expect((await read()).body).toMatchObject({ available: true, can_approve: false });
    expect((await approve()).status).toBe(409);
    writeStudioFile(report, JSON.stringify({ path: video, ok: true, problems: [], video_sha256: sha, delivery_spec: spec }));
    expect((await read()).body.can_approve).toBe(true);
    writeStudioFile(frameFile, frame.replace('fps: 30', 'fps: 24'));
    expect((await read()).body.can_approve).toBe(false);
    expect((await approve()).status).toBe(409);
    writeStudioFile(frameFile, frame);
    writeStudioFile(path.join(root, 'production/timing-report.json'), '{"total_frames":33}');
    expect((await read()).body.can_approve).toBe(false);
    expect((await approve()).status).toBe(409);
    writeStudioFile(path.join(root, 'production/timing-report.json'), '{"total_frames":30}');
    const writeScene = (id: string, duration: number) => {
      writeStudioFile(path.join(root, 'scenes', id, 'scene.json'), JSON.stringify({
        id, duration_seconds: duration, output: 'out.mp4', transcript: 'voice.srt', text: '一句',
      }));
      writeStudioFile(path.join(root, 'scenes', id, 'voice.srt'), '1\n00:00:00,000 --> 00:00:00,300\n一句\n');
    };
    writeScene('scene-001', 0.5);
    writeScene('scene-002', 0.5);
    expect((await approve()).status).toBe(409);
    const plan = scenePlanDigest([{ id: 'scene-001', frames: 15 }, { id: 'scene-002', frames: 15 }]);
    const passing = JSON.stringify({ path: video, ok: true, problems: [], video_sha256: sha, delivery_spec: spec, scene_plan_sha256: plan });
    writeStudioFile(report, passing);
    expect((await read()).body.can_approve).toBe(true);
    const readFile = fs.readFileSync;
    let frameReads = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      const value = readFile(file, options);
      if (file === frameFile && ++frameReads === 2) {
        writeStudioFile(report, JSON.stringify({ path: video, ok: false, problems: ['新的检查未通过'] }));
      }
      return value;
    });
    try {
      expect((await approve()).status).toBe(409);
      expect(frameReads).toBe(2);
    } finally {
      readSpy.mockRestore();
    }
    writeStudioFile(report, passing);
    writeScene('scene-001', 0.6);
    writeScene('scene-002', 0.4);
    expect((await approve()).status).toBe(409);
    writeScene('scene-001', 0.5);
    writeScene('scene-002', 0.5);
    writeStudioFile(file + '.next', 'edit');
    fs.renameSync(file + '.next', file);
    expect((await read()).body.can_approve).toBe(false);
    expect((await approve()).status).toBe(409);
    const worker = vi.spyOn(tasks, 'runStudioOp').mockResolvedValue({ text: '' });
    try {
      writeStudioFile(file + '.next', 'film');
      fs.renameSync(file + '.next', file);
      expect((await read()).body.can_approve).toBe(true);
      const started = await approve();
      expect(started.status).toBe(202);
      expect((await waitStudioTask(s, started.body.task_id)).status).toBe('succeeded');
    } finally {
      worker.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('ignores a review report linked outside the project, including the default report', async () => {
    const root = tempDir();
    const external = path.join(tempDir(), 'review.json');
    writeStudioFile(external, '{"path":"final.mp4","problems":["outside the project"]}');
    for (const dir of ['production/review', 'production/review-external']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.symlinkSync(external, path.join(root, dir, 'review.json'));
    }
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    expect((await studioRequest(s, 'GET', '/api/review?video=final.mp4')).body.available).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects review inputs linked outside the project', async () => {
    const root = fs.realpathSync(tempDir());
    const outside = tempDir();
    writeStudioFile(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 240, height_px: 320, fps: 30}\n---\n');
    writeStudioFile(path.join(root, 'final.mp4'), 'film');
    writeStudioFile(path.join(outside, 'scene.json'), '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"voice.srt"}');
    writeStudioFile(path.join(outside, 'timing-report.json'), '{"total_frames":30}');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const runReview = async () => {
      const res = await studioRequest(s, 'POST', '/api/review/run', '{"video":"final.mp4"}');
      expect(res.status).toBe(202);
      return waitStudioTask(s, res.body.task_id);
    };
    fs.mkdirSync(path.join(root, 'production'));
    fs.symlinkSync(path.join(outside, 'timing-report.json'), path.join(root, 'production/timing-report.json'));
    expect(await runReview()).toMatchObject({ status: 'failed', error: expect.stringMatching(/timing-report.json.*不得逃出/) });
    fs.mkdirSync(path.join(root, 'scenes/scene-001'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'scene.json'), path.join(root, 'scenes/scene-001/scene.json'));
    expect(await runReview()).toMatchObject({ status: 'failed', error: expect.stringMatching(/scene.json.*不得逃出/) });
  });

  it('project and state API', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1920, fps: 30, orientation: vertical}\n---\n');
    writeStudioFile(path.join(root, 'scenes', 'scene-001', 'scene.json'), '{"id":"scene-001","duration_seconds":2,"output":"out.mp4"}');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    let { status, body } = await studioRequest(s, 'GET', '/api/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    ({ body } = await studioRequest(s, 'GET', '/api/state'));
    expect(body.stage).toBeUndefined();
    expect(body.metadata.canvas_id).toBe('vertical-9x16');
  });

  it('tasks persist in project', () => {
    const root = tempDir();
    const configPath = path.join(tempDir(), 'projects.json');
    const s = startStudio({ projectPath: root, configPath });
    const task = addTask(s, 'test', 'persist me');
    updateTask(s, task.task_id, 'succeeded', 'done', 1, null);
    const s2 = startStudio({ projectPath: root, configPath });
    expect(s2.tasks.tasks.get(task.task_id)?.status).toBe('succeeded');
  });

  it('task cancellation cancels context', async () => {
    const root = tempDir();
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const task = addTask(s, 'test', 'waiting');
    let done = false;
    runTask(s, task, (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => ((done = true), reject(new Error('context canceled'))))));
    await studioRequest(s, 'POST', `/api/tasks/${task.task_id}/cancel`, '{}');
    const deadline = Date.now() + 1000;
    while (!done && Date.now() < deadline) await sleep(5);
    expect(done, 'task context was not cancelled').toBe(true);
    await sleep(10);
    expect(s.tasks.tasks.get(task.task_id)?.status).toBe('cancelled');
  });

  it('stage is the step of the top bar, from the production route', () => {
    // 没有流程记录：排不出路线，也就没有阶段。
    expect(stageFor(tempDir(), [])).toEqual({ stage: '', label: '' });
    const speech = tempDir();
    flow.recordFlow(speech, { id: 'speech', canvas: 'vertical-3x4' });
    expect(stageFor(speech, [])).toEqual({ stage: 'script', label: '口播稿' });
    // 卡点项目确认了网格、还没写分镜计划与处理方案：顶栏在哪一步，首页就写哪一步，不再落成「准备中」。
    const beat = tempDir();
    flow.recordFlow(beat, { id: 'beat', canvas: 'vertical-9x16' });
    const grid = JSON.stringify({ schema: 1, audio_sha256: 'x', duration_seconds: 4, source: 'test', reviewed: true, beats: [0, 0.5, 1, 1.5], downbeats: [0] });
    for (const [rel, body] of Object.entries({
      'beat.yaml': 'schema: 1\n',
      'production/beat/story.md': '# 故事\n',
      'production/beat/track.json': '{}',
      'production/beat/grid-draft.json': grid,
      'production/beat/grid.json': grid,
    })) writeStudioFile(path.join(beat, rel), body);
    const { stations, current } = computeStations(beat, []);
    expect(current).toBe('plan');
    const step = stations.find((x) => x.id === current)!.step;
    expect(stageFor(beat, [])).toEqual({ stage: step, label: studioview.steps().find((x) => x.id === step)!.label });
    expect(stageFor(beat, []).stage).toBe(stepOf(beat, []).step);
    // 编排标了步骤（比最新的产物新）：跟着标记走，与顶栏一致。
    writeStepMark(beat, 'storyboard', new Date(Date.now() + 60_000));
    expect(stageFor(beat, [])).toEqual({ stage: 'storyboard', label: '分镜' });
  });

  it('project metadata reads top-level front matter only', () => {
    const root = tempDir();
    const frame = path.join(root, 'frame.md');
    // 节选自真实项目：colors.canvas 是颜色值，按行扫描会把它当成画幅。
    writeStudioFile(
      frame,
      '---\nschema_version: 1\ncanvas:\n  width_px: 1920\n  height_px: 1080\n  fps: 30\n  orientation: landscape\ncolors:\n  canvas: "#05060A"\n---\n正文 canvas: nope\n',
    );
    expect(projectMetadata(root)).toEqual({
      canvas: '1920×1080',
      fps: '30',
      orientation: 'landscape',
      canvas_id: 'landscape-16x9',
    });
    // 不在预设表里的画幅照样显示尺寸，只是没有 canvas_id。
    writeStudioFile(frame, '---\ncanvas: {width_px: 1000, height_px: 1000, fps: 24, orientation: square}\n---\n');
    const custom = projectMetadata(root);
    expect(custom.canvas).toBe('1000×1000');
    expect(custom.canvas_id).toBeUndefined();
    for (const broken of ['no front matter', '---\ncanvas: {width_px: 1}\n', '---\n: [bad\n---\n']) {
      writeStudioFile(frame, broken);
      expect(projectMetadata(root), broken).toEqual({});
    }
    writeStudioFile(frame, '---\r\ncanvas: {width_px: 1000, height_px: 1000, fps: 24}\r\n---\r\n');
    expect(projectMetadata(root).canvas).toBe('1000×1000');
  });

  it('directory and project lifecycle', async () => {
    const home = tempDir();
    setEnv('HOME', home);
    const other = tempDir();
    const s = startStudio({ configPath: path.join(tempDir(), 'projects.json') });

    let { status, body } = await studioRequest(s, 'GET', '/api/directories');
    expect(status).toBe(200);
    expect(body.path).toBe(home);
    expect(body.parent).toBe(process.platform === 'win32' ? path.dirname(home) : '');
    expect(body.entries).toEqual([]);

    const alpha = path.join(home, 'alpha');
    const beta = path.join(home, 'beta');
    writeStudioFile(path.join(alpha, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
    fs.mkdirSync(path.join(beta, 'data'), { recursive: true });
    fs.mkdirSync(path.join(home, '.hidden'), { recursive: true });
    writeStudioFile(path.join(home, 'note.txt'), 'not a directory');

    ({ status, body } = await studioRequest(s, 'GET', '/api/directories'));
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({ name: 'alpha', is_project: true });
    expect(body.entries[1]).toMatchObject({ name: 'beta', is_project: false });

    ({ status, body } = await studioRequest(s, 'GET', '/api/directories?path=' + encodeURIComponent(alpha)));
    expect(status).toBe(200);
    expect(body.path).toBe(alpha);
    expect(body.parent).toBe(home);
    expect(body.root).toBe(process.platform === 'win32' ? path.parse(home).root : home);

    ({ status, body } = await studioRequest(s, 'GET', '/api/directories?path=' + encodeURIComponent(other)));
    expect(status).toBe(process.platform === 'win32' ? 200 : 403);
    if (process.platform !== 'win32') expect(body.code).toBe('directory_outside_root');

    expect((await studioRequest(s, 'GET', '/api/directories?path=' + encodeURIComponent(path.join(home, 'missing')))).status).toBe(400);
    expect((await studioRequest(s, 'GET', '/api/directories?path=' + encodeURIComponent(path.join(home, 'note.txt')))).status).toBe(400);
    expect((await studioRequest(s, 'POST', '/api/directories')).status).toBe(405);

    ({ status, body } = await studioRequest(s, 'GET', '/api/projects'));
    expect(status).toBe(200);
    expect(body.current_project_id).toBe('');
    expect(body.projects, '没有项目时 projects 要是空数组，不能是 null').toEqual([]);
    ({ status, body } = await studioRequest(s, 'GET', '/api/workspaces/current'));
    expect(status).toBe(200);
    expect(body.project).toBeNull();

    for (const p of ['/api/state', '/api/scenes', '/api/script', '/api/assets', '/api/publish', '/api/review', '/api/scenes/scene-001']) {
      expect((await studioRequest(s, 'GET', p)).status, p).toBe(404);
    }
    expect((await studioRequest(s, 'POST', '/api/render/all')).status).toBe(404);
    expect((await studioRequest(s, 'POST', '/api/review/run')).status).toBe(404);
    for (const p of ['/api/sessions', '/api/files?path=a', '/api/skills']) expect((await studioRequest(s, 'GET', p)).status, p).toBe(404);
    for (const p of ['/api/production/start', '/api/commands/project.concat', '/api/sessions/s-1/turns']) {
      expect((await studioRequest(s, 'POST', p, '{}')).status, p).toBe(404);
    }
    expect((await studioRequest(s, 'GET', '/api/tasks')).status).toBe(200);

    expect((await studioRequest(s, 'POST', '/api/projects/open', '{')).status).toBe(400);
    expect((await studioRequest(s, 'POST', '/api/projects/open', '{"path":""}')).status).toBe(400);
    expect((await studioRequest(s, 'GET', '/api/projects/open')).status).toBe(405);

    expect((await studioRequest(s, 'POST', '/api/projects/recent/remove', '{')).status).toBe(400);
    expect((await studioRequest(s, 'POST', '/api/projects/recent/remove', '{}')).status).toBe(400);
    expect((await studioRequest(s, 'GET', '/api/projects/recent/remove')).status).toBe(405);

    expect((await studioRequest(s, 'POST', '/api/workspaces/switch', '{')).status).toBe(400);
    expect((await studioRequest(s, 'POST', '/api/workspaces/switch', '{"project_id":"missing"}')).status).toBe(404);
    expect((await studioRequest(s, 'GET', '/api/workspaces/switch')).status).toBe(405);

    expect((await studioRequest(s, 'GET', '/api/projects/create')).status).toBe(405);
    for (const payload of [
      {},
      { parent: home },
      { parent: home, name: 'a/b' },
      ...(process.platform === 'win32' ? [{ parent: '\\\\onset-invalid-host\\share', name: 'x' }] : [{ parent: other, name: 'x' }]),
      { parent: path.join(home, 'missing'), name: 'x' },
      { parent: home, name: 'bad-canvas', canvas: 'missing' },
      { parent: home, name: 'bad-mode', delivery: 'opera' },
      { parent: home, name: 'beat-cast', delivery: 'beat', narration: 'cast' },
    ]) {
      const res = await studioRequest(s, 'POST', '/api/projects/create', JSON.stringify(payload));
      expect([400, 403], `create ${JSON.stringify(payload)}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
    }

    ({ status, body } = await studioRequest(s, 'POST', '/api/projects/create', JSON.stringify({ parent: home, name: 'my-project' })));
    expect(status, JSON.stringify(body)).toBe(201);
    const projectID = body.project.id as string;
    const target = body.project.path as string;
    expect(body.project.name).toBe('my-project');
    expect(fs.existsSync(path.join(target, 'frame.md')), 'created project missing frame.md').toBe(true);
    expect(fs.existsSync(path.join(target, 'docs', 'style-brief.md')), '不再写旧版风格描述').toBe(false);

    ({ status, body } = await studioRequest(s, 'GET', '/api/workspaces/current'));
    expect(status).toBe(200);
    expect(body.project.id).toBe(projectID);
    ({ status, body } = await studioRequest(s, 'GET', '/api/projects'));
    expect(status).toBe(200);
    expect(body.current_project_id).toBe(projectID);
    expect(body.projects).toHaveLength(1);
    // 新建的口播项目停在顶栏第一步。
    expect(body.summaries[projectID]).toMatchObject({ stage: 'script', stage_label: '口播稿' });
    expect(body.default_parent, '上次新建时选的父目录').toBe(home);
    ({ status, body } = await studioRequest(s, 'GET', '/api/state'));
    expect(status).toBe(200);
    expect(body.step).toBe('script');
    expect(body.metadata.canvas).not.toBe('');
    ({ status, body } = await studioRequest(s, 'GET', '/api/script'));
    expect(status).toBe(200);
    expect(body.path).toBe('');
    expect(body.content).toBe('');
    expect((await studioRequest(s, 'GET', '/api/assets')).status).toBe(200);
    ({ status, body } = await studioRequest(s, 'GET', '/api/publish'));
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    ({ status, body } = await studioRequest(s, 'GET', '/api/review'));
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    ({ status, body } = await studioRequest(s, 'GET', '/api/scenes'));
    expect(status).toBe(200);
    expect(body.scenes ?? []).toHaveLength(0);
    expect((await studioRequest(s, 'GET', '/api/scenes/missing')).status).toBe(404);

    expect((await studioRequest(s, 'POST', '/api/projects/create', JSON.stringify({ parent: home, name: 'my-project' }))).status).toBe(409);
    expect((await studioRequest(s, 'POST', '/api/projects/open', JSON.stringify({ path: target }))).status).toBe(200);
    expect((await studioRequest(s, 'POST', '/api/workspaces/switch', JSON.stringify({ project_id: projectID }))).status).toBe(200);

    expect((await studioRequest(s, 'POST', '/api/projects/recent/remove', JSON.stringify({ project_id: projectID }))).status).toBe(200);
    ({ body } = await studioRequest(s, 'GET', '/api/workspaces/current'));
    expect(body.project, 'current project after removal').toBeNull();
    ({ body } = await studioRequest(s, 'GET', '/api/projects'));
    expect(body.projects).toHaveLength(0);
  });

  it('content and task endpoints', async () => {
    const root = tempDir();
    writeStudioFile(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
    const sceneOne = path.join(root, 'scenes', 'scene-001');
    writeStudioFile(path.join(sceneOne, 'scene.json'), '{"id":"scene-001","duration_seconds":2,"output":"out.mp4","text":"before"}');
    writeStudioFile(path.join(sceneOne, 'out.mp4'), 'video-bytes');
    writeStudioFile(path.join(sceneOne, '.studio-frames', 'frame-01.jpg'), 'jpg-bytes');
    writeStudioFile(path.join(root, 'scenes', 'scene-002', 'scene.json'), '{"id":"scene-002","duration_seconds":1,"output":"missing.mp4"}');
    writeStudioFile(path.join(root, 'SCRIPT.md'), 'script body');
    // macOS 的默认文件系统大小写不敏感，不能再写一份小写 script.md：
    // 两者会落到同一个文件并互相覆盖。render 阶段改由 transcription.srt 触发。
    writeStudioFile(path.join(root, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nline\n');
    writeStudioFile(path.join(root, 'assets', 'logo.txt'), 'logo');
    writeStudioFile(path.join(root, 'cast', 'char.txt'), 'cast');
    writeStudioFile(path.join(root, 'publish.md'), '---\nplatform: douyin\ncopy:\n  primary_title: 复利到底是什么\n---\n\n# publish\n');
    writeStudioPNG(path.join(root, 'covers', 'cover.png'));
    writeStudioFile(path.join(root, 'covers', 'broken.png'), 'not an image');
    writeStudioFile(path.join(root, 'production', 'review', 'review.json'), '{"issues":[{"id":"i1"}]}');

    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });

    let { status, body } = await studioRequest(s, 'GET', '/api/scenes');
    expect(status).toBe(200);
    expect(body.scenes).toHaveLength(2);
    expect(body.scenes[0]).toMatchObject({ id: 'scene-001', exists: true, stale: false });
    expect(body.scenes[1]).toMatchObject({ id: 'scene-002', exists: false });

    ({ status, body } = await studioRequest(s, 'GET', '/api/scenes/scene-001'));
    expect(status).toBe(200);
    expect(body.data.id).toBe('scene-001');
    expect(body.exists).toBe(true);
    expect((await studioRequest(s, 'GET', '/api/scenes/missing')).status).toBe(404);

    let raw = await rawGet(s, '/api/scenes/scene-001/asset');
    expect(raw.status).toBe(200);
    expect(raw.text).toBe('video-bytes');
    raw = await rawGet(s, '/api/scenes/scene-001/frames/frame-01.jpg');
    expect(raw.status).toBe(200);
    expect(raw.text).toBe('jpg-bytes');
    ({ status, body } = await studioRequest(s, 'GET', '/api/scenes/scene-001/frames'));
    expect(status).toBe(200);
    expect(body.frames).toEqual(['.studio-frames/frame-01.jpg']);

    const evil = await sceneFeatureAPI(s, new Request('http://studio.test/api/scenes/scene-001/frames/../evil.jpg'), 'scene-001/frames/../evil.jpg');
    expect(evil.status).toBe(400);

    expect((await studioRequest(s, 'GET', '/api/scenes/scene-001/bogus')).status).toBe(404);
    expect((await studioRequest(s, 'GET', '/api/scenes/missing/asset')).status).toBe(404);

    ({ status, body } = await studioRequest(s, 'POST', '/api/scenes/scene-002/frames'));
    expect(status).toBe(202);
    const frameTask = await waitStudioTask(s, body.task_id);
    expect(frameTask.status).toBe('failed');
    expect(frameTask.error).toContain('镜头产物不存在');
    const taskID = frameTask.task_id as string;

    ({ status, body } = await studioRequest(s, 'GET', '/api/script'));
    expect(status).toBe(200);
    expect(body.path).toBe('SCRIPT.md');
    expect(body.content).toBe('script body');
    ({ status, body } = await studioRequest(s, 'GET', '/api/assets'));
    expect(status).toBe(200);
    const assetPaths = new Set((body.assets as { path: string }[]).map((a) => a.path));
    expect(assetPaths.has('assets/logo.txt') && assetPaths.has('cast/char.txt')).toBe(true);

    ({ status, body } = await studioRequest(s, 'GET', '/api/publish'));
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.covers).toHaveLength(2);
    // 发布页应只拿到解析后的字段，不拿 Markdown 原文。
    expect(body.content).toBeUndefined();
    expect(body.platform_name).toBe('抖音');
    expect(body.data.copy.primary_title).toBe('复利到底是什么');
    for (const cover of body.covers as Record<string, unknown>[]) {
      if (cover.path === 'covers/cover.png') {
        expect(cover.width).toBe(2);
        expect(cover.height).toBe(3);
        expect(cover.sha256).not.toBe('');
      } else if (cover.path === 'covers/broken.png') {
        expect(cover.error).toBe('无法读取图片尺寸');
      } else {
        throw new Error('unexpected cover ' + JSON.stringify(cover));
      }
    }

    ({ status, body } = await studioRequest(s, 'GET', '/api/review'));
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.report.issues).toHaveLength(1);
    writeStudioFile(path.join(root, 'production', 'review', 'review.json'), 'not json');
    ({ body } = await studioRequest(s, 'GET', '/api/review'));
    expect(body.report.raw).toBe('not json');

    ({ status, body } = await studioRequest(s, 'GET', '/api/state'));
    expect(status).toBe(200);
    expect(body.metadata.style_id).toBeUndefined();
    expect(body.scenes.total).toBe(2);
    expect(body.scenes.completed).toBe(1);
    expect(body.media).toBeUndefined();


    const future = new Date(Date.now() + 3600_000);
    fs.utimesSync(path.join(sceneOne, 'scene.json'), future, future);
    writeStudioFile(path.join(root, 'scenes', 'scene-004', 'scene.json'), '{"id":"scene-004","duration_seconds":1,"output":"/etc/passwd"}');
    writeStudioFile(path.join(root, 'scenes', 'scene-003', 'scene.json'), 'not json');
    ({ status, body } = await studioRequest(s, 'GET', '/api/scenes'));
    expect(status).toBe(200);
    expect(body.scenes, 'scenes with invalid/absolute outputs').toHaveLength(3);
    ({ body } = await studioRequest(s, 'GET', '/api/state'));
    expect(body.scenes.stale).toBe(1);

    ({ status, body } = await studioRequest(s, 'GET', '/api/tasks'));
    expect(status).toBe(200);
    expect(body.tasks.length).toBeGreaterThan(0);
    ({ status, body } = await studioRequest(s, 'GET', '/api/tasks/' + taskID));
    expect(status).toBe(200);
    expect(body.status).toBe('failed');
    raw = await rawGet(s, `/api/tasks/${taskID}/events`);
    expect(raw.status).toBe(200);
    expect(raw.text).toContain('event: task.queued');
    expect(raw.text).toContain('task.failed');
    raw = await rawGet(s, `/api/tasks/${taskID}/events?follow=1`);
    expect(raw.status).toBe(200);
    expect(raw.text).toContain('task.failed');
    expect((await studioRequest(s, 'POST', `/api/tasks/${taskID}/cancel`)).status).toBe(409);
    expect((await studioRequest(s, 'GET', '/api/tasks/')).status).toBe(404);
    expect((await studioRequest(s, 'GET', '/api/tasks/missing')).status).toBe(404);
    expect((await studioRequest(s, 'POST', '/api/tasks')).status).toBe(405);

    ({ status, body } = await studioRequest(s, 'POST', '/api/review/run'));
    expect(status).toBe(202);
    const reviewTask = await waitStudioTask(s, body.task_id);
    expect(reviewTask.status).toBe('failed');
    expect(reviewTask.error).toContain('找不到可审查的成片');
    expect((await studioRequest(s, 'GET', '/api/review/run')).status).toBe(405);
    expect((await studioRequest(s, 'GET', '/api/render/all')).status).toBe(405);

    const empty = startStudio({ projectPath: tempDir(), configPath: path.join(tempDir(), 'projects.json') });
    ({ status, body } = await studioRequest(empty, 'POST', '/api/render/all'));
    expect(status).toBe(400);
    expect(body.code).toBe('no_scenes');

    ({ status, body } = await studioRequest(s, 'GET', '/api/missing-endpoint'));
    expect(status).toBe(404);
    expect(body.code).toBe('not_found');
  });
});
