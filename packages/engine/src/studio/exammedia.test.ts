import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import * as memory from '../memory';
import { freezeInput } from '../memory';
import { load, newAttempt, OutcomeSucceeded } from '../scene';
import { writeSceneDir } from '../memory/testsupport';
import { send, setEnv, startStudio, studioRequest, tempDir, writeStudioFile } from './testsupport';
import { examPreviewAudio, resolveExamAudio } from './exammedia';

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
  expect(cell.preview_audio).toMatchObject({start_seconds: 2, source_project: path.basename(sourceRoot)});
  const served = await send(server, 'GET', cell.preview_audio.url, undefined, {Range: 'bytes=0-5'});
  expect(served.status).toBe(206);
  expect(await served.text()).toBe('SOURCE');
  expect((await send(server, 'GET', cell.preview_audio.url.replace('question=h1', 'question=unknown'))).status).toBe(404);
  expect(resolveExamAudio(root, exam.cells![0].workdir, directory, [])).toBeNull();
  expect(server.currentProject().path).toBe(root);
  expect((await send(server, 'GET', '/api/raw?path=' + encodeURIComponent(path.join(sourceRoot, 'production/audio/voice.wav')))).status).toBe(404);
  const file = path.join(memoryDir, 'exams', exam.id, 'result.json');
  const lost = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(lost.questions[0], {holdout: false, episode: 'missing-source'});
  writeStudioFile(file, JSON.stringify(lost));
  expect((await send(server, 'GET', cell.preview_audio.url)).status).toBe(404);
  const missing = await studioRequest(server, 'GET', '/api/memory');
  expect(missing.body.exams[0].cells[0].preview_audio).toBeUndefined();
});
