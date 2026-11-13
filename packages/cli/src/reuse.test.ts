import { tempDir } from './testutil';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as config from '@am/engine/config';
import * as scene from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';
import { reuseDecision } from './reuse';

function reuseScene(): scene.Scene {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\n一句\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"一句"}');
  fs.writeFileSync(path.join(dir, 'out.mp4'), 'video');
  return scene.load(dir);
}

const shift = (file: string, seconds: number) => {
  const t = new Date(Date.now() + seconds * 1000);
  fs.utimesSync(file, t, t);
};

describe('reuseDecision', () => {
  it('uses the fingerprint', () => {
    const s = reuseScene();
    const cfg = config.newConfig({ renderer: 'codex' });
    const env = { HOME: tempDir() };
    const resolved = scene.resolveAllSkills('codex', s.directory, env);
    scene.writeRecord(s, scene.fingerprint(s, 'codex', resolved));
    // 只动修改时间不动内容：旧判定会误报 Stale，指纹判定不会。
    shift(path.join(s.directory, 'scene.json'), 3600);
    let [status, reason] = reuseDecision(s, cfg, env);
    expect(status).toBe(schedule.Skipped);
    expect(reason).toContain('指纹一致');
    // prompt.md 之外的输入变了也要能发现，并说出是哪一项。
    fs.writeFileSync(path.join(s.directory, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\n改过\n');
    [status, reason] = reuseDecision(s, cfg, env);
    expect(status).toBe(schedule.Stale);
    expect(reason).toContain('file:transcript.srt');
  });

  it('marks an output without a record stale', () => {
    const s = reuseScene();
    const cfg = config.newConfig({ renderer: 'codex' });
    const env = { HOME: tempDir() };
    const [status, reason] = reuseDecision(s, cfg, env);
    expect(status).toBe(schedule.Stale);
    expect(reason).toContain('渲染记录');
  });
});
