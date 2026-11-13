// 移植自 internal/studio/studio_test.go 与 api_test.go。
//
// 不移植：
// - TestListenAndServeStopsWithContext：TS 版后端不监听端口，Electron 主进程经 am://app/ 协议直接调 handle。
// - TestStudioContentAndTaskEndpoints 里静态文件的两条（/missing-asset.js 404、/some/route 回落到 index.html）：
//   界面文件由 Electron 加载，这里不服务。
// - 「/api/scenes/scene-001/frames/../evil.jpg」那一条：Go 版绕过 ServeMux 直接调 sceneFeatureAPI，
//   这里同样直接调 sceneFeatureAPI（handle 会先把不规整的路径 301 掉）。
import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sceneFeatureAPI } from './features';
import type { SceneSummary } from './scenes';
import { projectMetadata, stageFor } from './studio';
import { addTask, runTask, updateTask } from './tasks';
import { rawGet, setEnv, sleep, startStudio, studioRequest, tempDir, waitStudioTask, writeStudioFile, writeStudioPNG } from './testsupport';

function scene(id: string, exists = false): SceneSummary {
  return { id, directory: '', exists, stale: false, attempts: 0 };
}

describe('studio', () => {
  it('project and state API', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas: vertical-9x16\nstyle_id: editorial\n---\n');
    writeStudioFile(path.join(root, 'scenes', 'scene-001', 'scene.json'), '{"id":"scene-001","duration_seconds":2,"output":"out.mp4"}');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    let { status, body } = await studioRequest(s, 'GET', '/api/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    ({ body } = await studioRequest(s, 'GET', '/api/state'));
    expect(body.stage).toBe('render');
    expect(body.metadata.canvas_id).toBe('vertical-9x16');
    expect(body.metadata.style_id).toBe('editorial');
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

  it('stage follows production artifacts', () => {
    const pending = [scene('a', true), scene('b')];
    const rendered = [scene('a', true), scene('b', true)];
    const cases: [string, string[], SceneSummary[], string][] = [
      ['空项目', [], [], 'setup'],
      ['口播终稿', ['production/script-final.md'], [], 'plan'],
      ['配音时间轴', ['production/audio/voice.srt'], [], 'plan'],
      ['分镜计划', ['production/scene-plan.json'], [], 'plan'],
      ['卡点网格', ['production/beat/grid.json'], [], 'plan'],
      ['旧版脚本', ['script.md'], [], 'plan'],
      ['镜头未出齐', [], pending, 'render'],
      ['镜头出齐', [], rendered, 'assemble'],
      ['有成片', ['final.mp4'], rendered, 'review'],
      ['成片在 production 下', ['production/final.mp4'], rendered, 'review'],
      ['成片加发布信息', ['final.mp4', 'publish.md'], rendered, 'publish'],
      // 卡点项目没有脚本，但做完了就该显示发布阶段（choice-paralysis 实测）。
      ['卡点成片', ['beat.yaml', 'production/beat/grid.json', 'final.mp4', 'publish.md'], rendered.slice(0, 1), 'publish'],
    ];
    for (const [name, files, scenes, want] of cases) {
      const root = tempDir();
      for (const f of files) writeStudioFile(path.join(root, f), 'x');
      expect(stageFor(root, scenes), name).toBe(want);
    }
  });

  it('project metadata reads top-level front matter only', () => {
    const root = tempDir();
    const frame = path.join(root, 'frame.md');
    // 节选自真实项目：colors.canvas 是颜色值，按行扫描会把它当成画幅。
    writeStudioFile(
      frame,
      '---\nschema_version: 1\nstyle_id: custom-cine-layered\nstyle_name: 分层电影\ncanvas:\n  width_px: 1920\n  height_px: 1080\n  fps: 30\n  orientation: landscape\ncolors:\n  canvas: "#05060A"\n---\n正文 canvas: nope\n',
    );
    expect(projectMetadata(root)).toEqual({
      style_id: 'custom-cine-layered',
      style_name: '分层电影',
      canvas: '1920×1080',
      fps: '30',
      orientation: 'landscape',
      canvas_id: 'landscape-16x9',
    });
    // 不在预设表里的画幅照样显示尺寸，只是没有 canvas_id。
    writeStudioFile(frame, '---\nstyle_id: x\ncanvas: {width_px: 1000, height_px: 1000, fps: 24, orientation: square}\n---\n');
    const custom = projectMetadata(root);
    expect(custom.canvas).toBe('1000×1000');
    expect(custom.canvas_id).toBeUndefined();
    for (const broken of ['no front matter', '---\nstyle_id: x\n', '---\n: [bad\n---\n']) {
      writeStudioFile(frame, broken);
      expect(projectMetadata(root), broken).toEqual({});
    }
    writeStudioFile(frame, '---\r\nstyle_id: crlf\r\n---\r\n');
    expect(projectMetadata(root).style_id).toBe('crlf');
  });

  it('directory and project lifecycle', async () => {
    const home = tempDir();
    setEnv('HOME', home);
    const other = tempDir();
    const s = startStudio({ configPath: path.join(tempDir(), 'projects.json') });

    let { status, body } = await studioRequest(s, 'GET', '/api/directories');
    expect(status).toBe(200);
    expect(body.path).toBe(home);
    expect(body.parent).toBe('');
    expect(body.entries).toEqual([]);

    const alpha = path.join(home, 'alpha');
    const beta = path.join(home, 'beta');
    writeStudioFile(path.join(alpha, 'frame.md'), '---\nstyle_id: editorial\n---\n');
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
    expect(body.root).toBe(home);

    ({ status, body } = await studioRequest(s, 'GET', '/api/directories?path=' + encodeURIComponent(other)));
    expect(status).toBe(403);
    expect(body.code).toBe('directory_outside_root');

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
      { parent: other, name: 'x' },
      { parent: path.join(home, 'missing'), name: 'x' },
      { parent: home, name: 'bad-canvas', canvas: 'missing' },
      { parent: home, name: 'bad-style', style: 'missing' },
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
    for (const name of ['frame.md', 'docs/style-brief.md']) expect(fs.existsSync(path.join(target, name)), `created project missing ${name}`).toBe(true);

    ({ status, body } = await studioRequest(s, 'GET', '/api/workspaces/current'));
    expect(status).toBe(200);
    expect(body.project.id).toBe(projectID);
    ({ status, body } = await studioRequest(s, 'GET', '/api/projects'));
    expect(status).toBe(200);
    expect(body.current_project_id).toBe(projectID);
    expect(body.projects).toHaveLength(1);
    expect(body.summaries[projectID].stage).toBe('setup');
    expect(body.default_parent, '上次新建时选的父目录').toBe(home);
    ({ status, body } = await studioRequest(s, 'GET', '/api/state'));
    expect(status).toBe(200);
    expect(body.stage).toBe('setup');
    expect(body.metadata.style_id).toBe('custom-draft');
    expect(body.metadata.style_name).not.toBe('');
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
    writeStudioFile(path.join(root, 'frame.md'), '---\nstyle_id: editorial\nstyle_name: "编辑"\n---\n');
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
    expect(body.stage).toBe('render');
    expect(body.metadata.style_id).toBe('editorial');
    expect(body.metadata.style_name).toBe('编辑');
    expect(body.scenes.total).toBe(2);
    expect(body.scenes.completed).toBe(1);
    expect(body.media).toEqual({ audio: false, final: false, publish: true });
    expect(body.issues).toEqual([]);

    // 有了成片才进复查；只跑过 run-all、还有镜头没出片时仍在渲染阶段。
    writeStudioFile(path.join(root, 'production', 'run-report.json'), '{}');
    ({ body } = await studioRequest(s, 'GET', '/api/state'));
    expect(body.stage).toBe('render');

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
