import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as audition from '../audition';
import { load as loadScene, newAttempt } from '../scene';
import { startStudio, studioRequest, tempDir, writeTree } from './testsupport';

function setup() {
  const root = fs.realpathSync(tempDir());
  writeTree(root, {
    'onset.conf': '',
    'frame.md': '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n',
    'scenes/scene-001/scene.json': '{"id":"scene-001","duration_seconds":3,"output":"scene-001.mp4","transcript":"t.srt","text":"口播"}',
    'scenes/scene-001/t.srt': '1\n00:00:00,000 --> 00:00:03,000\n字幕\n',
    'scenes/scene-001/prompt.md': '画一个三维的场景 three.js',
  });
  const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
  return { root, s };
}

/** 开一场、两位都拍完、经 API 评判。 */
async function judged(root: string, s: ReturnType<typeof startStudio>, winner: 'teacher' | 'student') {
  const a = audition.create(root, loadScene(path.join(root, 'scenes', 'scene-001')), [{ renderer: 'claude', model: 'teacher' }, { renderer: 'codex', model: 'student' }], {
    withMemory: true,
    shuffle: (l) => [...l],
    now: new Date(Date.now() + Math.random() * 1e9),
  });
  for (const c of a.contestants) {
    fs.writeFileSync(path.join(root, c.workdir, 'scene-001.mp4'), 'v');
    fs.writeFileSync(path.join(root, c.workdir, 'index.html'), '<html></html>');
    audition.applyAttempt(root, c, newAttempt({ outcome: 'succeeded' }), '');
  }
  audition.save(root, a);
  const r = await studioRequest(s, 'POST', `/api/auditions/${a.id}/vote`, JSON.stringify({ kind: 'winner', winner: winner === 'teacher' ? 'A' : 'B' }));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return a;
}

describe('learning API', () => {
  it('proposes from verdicts, confirms, reports progress and exemplars, dismisses and removes', async () => {
    const { root, s } = setup();
    for (const w of ['teacher', 'teacher', 'student', 'teacher'] as const) await judged(root, s, w);
    let r = await studioRequest(s, 'GET', '/api/learning');
    expect(r.status).toBe(200);
    expect(r.body.verdicts).toBe(4);
    expect(r.body.exemplars).toBe(4);
    const [proposal] = r.body.proposals;
    expect(proposal).toMatchObject({ student: 'codex/student', teacher: 'claude/teacher', matches: 4, teacher_wins: 3, enough: true });

    r = await studioRequest(s, 'POST', '/api/learning/relations', JSON.stringify({ student: proposal.student, teacher: proposal.teacher, features: [] }));
    expect(r.status).toBe(200);
    const id = r.body.id;
    r = await studioRequest(s, 'GET', '/api/learning');
    expect(r.body.proposals ?? []).toEqual([]);
    const [relation] = r.body.relations;
    expect(relation.progress.points.map((x: { result: string }) => x.result)).toEqual(['loss', 'loss', 'win', 'loss']);
    expect(relation.exemplars).toBe(3);
    expect(relation.learnable).toBe(3);

    // 按镜头分派：这类镜头老师赢得最多。
    r = await studioRequest(s, 'GET', '/api/auditions/recommend?scene=scene-001');
    expect(r.body.recommendations[0]).toMatchObject({ key: 'claude/teacher', wins: 3, appearances: 4 });

    expect((await studioRequest(s, 'POST', '/api/learning/relations/rel-nope/learn', '{}')).status).toBe(400);
    expect((await studioRequest(s, 'DELETE', `/api/learning/relations/${id}`)).status).toBe(200);
    r = await studioRequest(s, 'POST', '/api/learning/dismiss', JSON.stringify({ student: proposal.student, teacher: proposal.teacher, features: [] }));
    expect(r.status).toBe(200);
    r = await studioRequest(s, 'GET', '/api/learning');
    expect(r.body.relations).toEqual([]);
    expect(r.body.proposals ?? []).toEqual([]);
  });
});
