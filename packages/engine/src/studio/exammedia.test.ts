import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import * as memory from '../memory';
import { freezeInput } from '../memory';
import { load, newAttempt, OutcomeSucceeded } from '../scene';
import { writeSceneDir } from '../memory/testsupport';
import { send, setEnv, startStudio, studioRequest, tempDir, writeStudioFile } from './testsupport';
import { examPreviewAudio, resolveExamAudio, resolveExamVideo } from './exammedia';

it('matches project narration by scene text, time range and phrase timing without rewriting exam video', () => {
  const root = tempDir(), directory = path.join(root, 'scenes', 'scene-001');
  writeStudioFile(path.join(root, 'onset.conf'), 'RENDERER=claude\n');
  const original = writeSceneDir(directory, 'scene-001', '预览口播', '');
  const timing = { fps: 30, start_frame: 60, end_frame_exclusive: 150, plan: 'a'.repeat(64), phrases: 'phrases.json' };
  writeStudioFile(path.join(directory, 'scene.json'), JSON.stringify({id: original.id, text: original.text, transcript: original.transcript, output: original.output, duration_seconds: 3, timing}));
  writeStudioFile(path.join(directory, 'phrases.json'), JSON.stringify({schema: 1, fps: 30, phrases: [
    {phrase_id: 'p', source_text: '预览口播', semantic_order: 1, start_frame: 65, end_frame_exclusive: 130},
  ]}));
  writeStudioFile(path.join(root, 'production/audio/voice.wav'), 'fixture');
  const workdir = path.join(root, 'production/memory-exams/exam-0001/q1/control');
  freezeInput(load(directory), workdir);
  const sources = [{id: 'scene-001', directory, exists: true, stale: false, attempts: 0}];
  expect(examPreviewAudio(root, workdir, sources)).toEqual({preview_audio: {path: 'production/audio/voice.wav', start_seconds: 2, duration_seconds: 3, label: '项目口播'}});
  const file = path.join(workdir, 'scene.json'), previous = fs.readFileSync(file, 'utf8');
  writeStudioFile(file, previous.replace('预览口播', '其他项目'));
  expect(examPreviewAudio(root, workdir, sources)).toHaveProperty('audio_unavailable');
  writeStudioFile(file, previous);
  writeStudioFile(path.join(directory, 'phrases.json'), JSON.stringify({schema: 1, fps: 30, phrases: [
    {phrase_id: 'p', source_text: '预览口播', semantic_order: 1, start_frame: 75, end_frame_exclusive: 130},
  ]}));
  expect(examPreviewAudio(root, workdir, sources)).toHaveProperty('audio_unavailable');
  expect(examPreviewAudio(tempDir(), workdir, sources)).toHaveProperty('audio_unavailable');
  // 早期镜头没有短语表，改用冻结字幕的文字和局部起止帧匹配。
  for (const dir of [directory, workdir]) writeStudioFile(path.join(dir, 'phrases.json'), JSON.stringify({schema: 1, fps: 30, phrases: [
    {phrase_id: 'later', source_text: '后一个镜头', semantic_order: 1, start_frame: 300, end_frame_exclusive: 400},
  ]}));
  expect(examPreviewAudio(root, workdir, sources)).toHaveProperty('preview_audio');
  writeStudioFile(path.join(directory, original.transcript), '1\n00:00:00,000 --> 00:00:03,000\n另一个口播\n');
  expect(examPreviewAudio(root, workdir, sources)).toHaveProperty('audio_unavailable');
});

it('serves old cross-project exam narration only through a recorded question and registered source', async () => {
  const root = tempDir(), sourceRoot = tempDir(), memoryDir = tempDir();
  setEnv('ONSET_MEMORY_DIR', memoryDir);
  for (const p of [root, sourceRoot]) writeStudioFile(path.join(p, 'onset.conf'), 'RENDERER=claude\n');
  const directory = path.join(sourceRoot, 'scenes/scene-001');
  const source = writeSceneDir(directory, 'scene-001', '旧题口播', '');
  writeStudioFile(path.join(directory, 'scene.json'), JSON.stringify({id: source.id, text: source.text, output: source.output, transcript: source.transcript,
    duration_seconds: 3, timing: {fps: 30, start_frame: 60, end_frame_exclusive: 150, plan: 'a'.repeat(64), phrases: 'phrases.json'}}));
  writeStudioFile(path.join(directory, 'phrases.json'), JSON.stringify({schema: 1, fps: 30, phrases: [
    {phrase_id: 'later', source_text: '后一个镜头', semantic_order: 1, start_frame: 300, end_frame_exclusive: 400},
  ]}));
  writeStudioFile(path.join(sourceRoot, 'production/audio/voice.wav'), 'SOURCE-AUDIO');
  fs.cpSync(directory, path.join(root, 'scenes/scene-001'), {recursive: true});
  writeStudioFile(path.join(root, 'production/audio/voice.wav'), 'WRONG-CURRENT-AUDIO');
  const store = memory.open(memoryDir);
  store.write(memory.newMemory({name: 'old-question', kind: memory.KindLesson, status: memory.StatusTrial, checked_by: ['determinism.raf']}));
  const exam = await store.exam({renderers: ['claude'], trial: ['old-question'], holdout: [directory], holdoutOnly: true, budget: 1500,
    workspace: path.join(root, 'production/memory-exams'), run: async sc => {
      writeStudioFile(path.join(sc.directory, sc.output), 'video');
      return newAttempt({outcome: OutcomeSucceeded});
    }});
  const server = startStudio({projectPath: root, configPath: path.join(tempDir(), 'projects.json')});
  server.openProject(sourceRoot); server.openProject(root);
  const response = await studioRequest(server, 'GET', '/api/memory');
  const cell = response.body.exams.find((e: {id: string}) => e.id === exam.id).cells[0];
  expect(cell.output).toBeDefined();
  expect(cell.preview_audio).toMatchObject({start_seconds: 2, source_project: path.basename(sourceRoot)});
  const served = await send(server, 'GET', cell.preview_audio.url, undefined, {Range: 'bytes=0-5'});
  expect(served.status).toBe(206);
  expect(await served.text()).toBe('SOURCE');
  expect((await send(server, 'GET', cell.preview_audio.url.replace('question=h1', 'question=unknown'))).status).toBe(404);
  expect(resolveExamAudio(root, exam.cells![0].workdir, directory, [])).toBeNull();
  expect(server.currentProject().path).toBe(fs.realpathSync(root));
  expect((await send(server, 'GET', '/api/raw?path=' + encodeURIComponent(path.join(sourceRoot, 'production/audio/voice.wav')))).status).toBe(404);
  const file = path.join(memoryDir, 'exams', exam.id, 'result.json');
  const lost = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(lost.questions[0], {holdout: false, episode: 'missing-source'});
  writeStudioFile(file, JSON.stringify(lost));
  expect((await send(server, 'GET', cell.preview_audio.url)).status).toBe(404);
  const missing = await studioRequest(server, 'GET', '/api/memory');
  expect(missing.body.exams[0].cells[0].preview_audio).toBeUndefined();
});

it('previews recorded exam videos and source narration from another registered project without changing the current project', async () => {
  const root = tempDir(), owner = tempDir(), memoryDir = tempDir();
  setEnv('ONSET_MEMORY_DIR', memoryDir);
  for (const p of [root, owner]) writeStudioFile(path.join(p, 'onset.conf'), 'RENDERER=claude\n');
  const source = writeSceneDir(path.join(owner, 'scenes/scene-001'), 'scene-001', '历史考题', '');
  writeStudioFile(path.join(source.directory, 'scene.json'), JSON.stringify({id: source.id, text: source.text, output: source.output, transcript: source.transcript,
    duration_seconds: 3, timing: {fps: 30, start_frame: 60, end_frame_exclusive: 150, plan: 'a'.repeat(64), phrases: 'phrases.json'}}));
  writeStudioFile(path.join(source.directory, 'phrases.json'), JSON.stringify({schema: 1, fps: 30, phrases: [
    {phrase_id: 'p', source_text: '历史考题', semantic_order: 1, start_frame: 65, end_frame_exclusive: 130},
  ]}));
  writeStudioFile(path.join(owner, 'production/audio/voice.wav'), 'OWNER-AUDIO');
  writeStudioFile(path.join(root, 'production/audio/voice.wav'), 'WRONG-CURRENT-AUDIO');
  const store = memory.open(memoryDir);
  store.write(memory.newMemory({name: 'cross-project-preview', kind: memory.KindLesson, status: memory.StatusTrial, checked_by: ['determinism.raf']}));
  const exam = await store.exam({renderers: ['claude'], trial: ['cross-project-preview'], holdout: [source.directory], holdoutOnly: true, budget: 1500,
    workspace: path.join(owner, 'production/memory-exams'), run: async sc => {
      writeStudioFile(path.join(sc.directory, sc.output), 'RECORDED-VIDEO');
      return newAttempt({outcome: OutcomeSucceeded});
    }});
  const server = startStudio({projectPath: root, configPath: path.join(tempDir(), 'projects.json')});
  const absent = await studioRequest(server, 'GET', '/api/memory');
  expect(absent.body.exams[0].cells[0].preview_video).toBeUndefined();
  server.openProject(owner); server.openProject(root);
  const state = await studioRequest(server, 'GET', '/api/memory');
  const cell = state.body.exams[0].cells[0];
  expect(cell.output).toBeUndefined();
  expect(cell.preview_video).toMatchObject({source_project: path.basename(owner)});
  const video = await send(server, 'GET', cell.preview_video.url, undefined, {Range: 'bytes=0-7'});
  expect(video.status).toBe(206);
  expect(await video.text()).toBe('RECORDED');
  const head = await send(server, 'HEAD', cell.preview_video.url);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  const audio = await send(server, 'GET', cell.preview_audio.url);
  expect(await audio.text()).toBe('OWNER-AUDIO');
  expect((await send(server, 'GET', cell.preview_video.url.replace('question=h1', 'question=unknown'))).status).toBe(404);
  expect((await send(server, 'GET', cell.preview_video.url.replace('repeat=1', 'repeat=99'))).status).toBe(404);
  expect((await send(server, 'GET', cell.preview_video.url.replace('/exam-0001/', '/unknown/'))).status).toBe(404);
  const raw = await send(server, 'GET', '/api/raw?path=' + encodeURIComponent(path.join(exam.cells![0].workdir, source.output)));
  expect(raw.status).toBe(404);
  expect(server.currentProject().path).toBe(fs.realpathSync(root));
  fs.unlinkSync(path.join(exam.cells![0].workdir, source.output));
  expect((await send(server, 'GET', cell.preview_video.url)).status).toBe(404);
});

it('rejects exam workspaces and output links outside registered project boundaries', () => {
  const root = tempDir(), owner = tempDir(), outside = tempDir();
  const workdir = path.join(owner, 'production/memory-exams/exam-0001/q1/control');
  const sc = writeSceneDir(workdir, 'scene-001', '题目', '');
  const output = path.join(workdir, sc.output);
  writeStudioFile(output, 'video');
  expect(resolveExamVideo(root, workdir, [])).toBeNull();
  expect(resolveExamVideo(root, workdir, [{path: owner, name: 'owner'}])).toEqual({file: fs.realpathSync(output), source_project: 'owner'});
  expect(resolveExamVideo(root, '../relative', [{path: owner, name: 'owner'}])).toBeNull();
  const link = path.join(owner, 'production/memory-exams/outside');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(resolveExamVideo(root, link, [{path: owner, name: 'owner'}])).toBeNull();
  fs.unlinkSync(output);
  const external = path.join(outside, 'private.mp4');
  writeStudioFile(external, 'not an exam video');
  try { fs.symlinkSync(external, output); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'EPERM') return; throw err; }
  expect(resolveExamVideo(root, workdir, [{path: owner, name: 'owner'}])).toBeNull();
});

it('resolves historical workspace aliases against canonical registered project paths', () => {
  const root = tempDir(), owner = tempDir(), aliases = tempDir();
  const relative = 'production/memory-exams/exam-0001/q1/control';
  const workdir = path.join(owner, relative);
  const sc = writeSceneDir(workdir, 'scene-001', '题目', '');
  const output = path.join(workdir, sc.output);
  writeStudioFile(output, 'video');
  const alias = path.join(aliases, 'project');
  fs.symlinkSync(owner, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const expected = {file: fs.realpathSync(output), source_project: 'owner'};
  expect(resolveExamVideo(root, path.join(alias, relative), [{path: fs.realpathSync(owner), name: 'owner'}])).toEqual(expected);
  expect(resolveExamVideo(root, fs.realpathSync(workdir), [{path: alias, name: 'owner'}])).toEqual(expected);
  fs.unlinkSync(alias);
  expect(resolveExamVideo(root, path.join(alias, relative), [{path: owner, name: 'owner'}])).toBeNull();
});
