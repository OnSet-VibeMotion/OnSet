import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as audition from '../audition';
import { load as loadScene, newAttempt } from '../scene';
import { discoverScenes } from './scenes';
import { startStudio, studioRequest, tempDir, writeTree } from './testsupport';

function setup() {
  const root = fs.realpathSync(tempDir());
  writeTree(root, {
    'onset.conf': '',
    'frame.md': '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n',
    'scenes/scene-001/scene.json': '{"id":"scene-001","duration_seconds":3,"output":"scene-001.mp4","transcript":"t.srt","text":"口播"}',
    'scenes/scene-001/t.srt': '1\n00:00:00,000 --> 00:00:03,000\n字幕\n',
  });
  const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
  const a = audition.create(root, loadScene(path.join(root, 'scenes', 'scene-001')), [{ renderer: 'claude', model: 'opus' }, { renderer: 'codex', model: '' }], {
    withMemory: true,
    shuffle: (l) => [...l],
  });
  return { root, s, a };
}

function finishAll(root: string, a: audition.Audition): void {
  for (const c of a.contestants) {
    fs.writeFileSync(path.join(root, c.workdir, 'scene-001.mp4'), 'v');
    audition.applyAttempt(root, c, newAttempt({ outcome: 'succeeded', model: 'm-' + c.renderer }), '');
  }
  audition.save(root, a);
}

describe('auditions API', () => {
  it('keeps the copies out of the scene list', () => {
    const { root } = setup();
    expect(discoverScenes(root).map((x) => x.directory)).toEqual([path.join(root, 'scenes', 'scene-001')]);
  });

  it('lists auditions blind until judged, then reveals', async () => {
    const { root, s, a } = setup();
    let r = await studioRequest(s, 'GET', '/api/auditions?scene=scene-001');
    expect(r.status).toBe(200);
    expect(r.body.auditions).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain('codex');
    r = await studioRequest(s, 'POST', `/api/auditions/${a.id}/vote`, JSON.stringify({ kind: 'tie' }));
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('还有选手没渲染完');
    finishAll(root, a);
    r = await studioRequest(s, 'POST', `/api/auditions/${a.id}/adopt`, JSON.stringify({ slot: 'A' }));
    expect(r.status).toBe(409);
    r = await studioRequest(s, 'POST', `/api/auditions/${a.id}/vote`, JSON.stringify({ kind: 'winner', winner: 'B', note: '更稳' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.blind).toBe(false);
    expect(r.body.contestants[1].renderer).toBe('codex');
    expect(r.body.warning).toBeUndefined();
    // 跨项目的评判记录写进了记忆库目录（测试里 ONSET_MEMORY_DIR 指到临时目录）。
    expect(audition.readVerdicts(process.env.ONSET_MEMORY_DIR!).map((v) => v.winner)).toContain('codex/m-codex');
    expect((await studioRequest(s, 'GET', `/api/auditions/${a.id}`)).body.verdict.winner).toBe('B');
  });

  it('rejects bad requests', async () => {
    const { s } = setup();
    const post = (body: unknown) => studioRequest(s, 'POST', '/api/auditions', JSON.stringify(body));
    expect((await post({ scene_id: 'scene-001', contestants: [{ renderer: 'claude' }] })).body.code).toBe('invalid_contestants');
    expect((await post({ scene_id: 'scene-001', contestants: [{ renderer: 'nope' }, { renderer: 'claude' }] })).body.code).toBe('invalid_agent');
    expect((await post({ scene_id: 'scene-001', contestants: [{ renderer: 'codex', model: 'a,b' }, { renderer: 'claude' }] })).body.code).toBe('invalid_model');
    expect((await post({ scene_id: 'scene-404', contestants: [{ renderer: 'codex' }, { renderer: 'claude' }] })).status).toBe(404);
    expect((await studioRequest(s, 'GET', '/api/auditions/not-an-id')).status).toBe(404);
  });
});
