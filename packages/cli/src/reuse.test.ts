import { tempDir } from './testutil';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as config from '@onset/engine/config';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import { reuseDecision } from './reuse';

function reuseScene(): scene.Scene {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\n一句\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"一句"}');
  fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
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

  it('upgrades a verifiably matching legacy record without rerendering the video', () => {
    const s = reuseScene();
    const cfg = config.newConfig({ renderer: 'codex' });
    const env = { HOME: tempDir() };
    const resolved = scene.resolveAllSkills('codex', s.directory, env, s);
    scene.writeRecord(s, scene.fingerprint(s, 'codex', resolved, scene.RecordSchemaRenderContract));
    const file = path.join(s.directory, scene.RecordFile);
    const old = { ...JSON.parse(fs.readFileSync(file, 'utf8')), schema: scene.RecordSchemaRenderContract, onset_version: '2.0.0' };
    fs.writeFileSync(file, JSON.stringify(old));
    expect(reuseDecision(s, cfg, env)[0]).toBe(schedule.Skipped);
    expect(scene.loadRecord(s)).toMatchObject({ schema: scene.RenderRecordSchema, onset_version: '2.0.0', output_sha256: old.output_sha256 });
    expect(fs.readFileSync(scene.outputPath(s), 'utf8')).toBe('video');
  });

  it('does not upgrade a legacy record when the prompt changes after the first check', () => {
    const s = reuseScene();
    const cfg = config.newConfig({ renderer: 'codex' });
    const env = { HOME: tempDir() };
    const prompt = path.join(s.directory, 'prompt.md');
    fs.writeFileSync(prompt, 'original');
    const resolved = scene.resolveAllSkills('codex', s.directory, env, s);
    const legacy = scene.RecordSchemaRenderContract;
    scene.writeRecord(s, scene.fingerprint(s, 'codex', resolved, legacy));
    const recordFile = path.join(s.directory, scene.RecordFile);
    fs.writeFileSync(recordFile, JSON.stringify({ ...scene.loadRecord(s), schema: legacy }));
    const read = fs.readFileSync;
    let reads = 0;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      const result = read(file, options);
      if (file === recordFile && ++reads === 2) fs.writeFileSync(prompt, 'changed');
      return result;
    });
    try {
      reuseDecision(s, cfg, env);
    } finally {
      spy.mockRestore();
    }
    expect(scene.loadRecord(s)?.schema).toBe(legacy);
    expect(reuseDecision(s, cfg, env)[0]).toBe(schedule.Stale);
  });
});
