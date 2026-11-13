import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addToProject, fetchStation } from '../flow';
import { fingerprint, load, resolveAllSkills } from './index';

const fake = path.join(__dirname, '..', 'flow', 'testdata', 'fake-publisher');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sceneDir(extra: Record<string, unknown> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-plugin-skill-')));
  temps.push(root);
  const dir = path.join(root, 'scenes', 'scene-001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify({ id: 'scene-001', duration_seconds: 1, output: 'out.mp4', transcript: 'voice.srt', text: 'hello', ...extra }));
  return dir;
}

describe('plugin skills on scenes', () => {
  it('reads plugin_skills and checks how they are written', () => {
    expect(load(sceneDir()).plugin_skills).toEqual([]);
    expect(load(sceneDir({ plugin_skills: ['fake-publisher/caption-kit'] })).plugin_skills).toEqual(['fake-publisher/caption-kit']);
    expect(() => load(sceneDir({ plugin_skills: ['caption-kit'] }))).toThrow('插件 id/技能名');
  });

  it('puts an opt-in skill into the fingerprint of the scenes that name it only', () => {
    const plain = load(sceneDir());
    const named = load(sceneDir({ plugin_skills: ['fake-publisher/caption-kit'] }));
    const before = fingerprint(plain, 'claude', resolveAllSkills('claude', plain.directory, {}, plain));
    for (const s of [plain, named]) addToProject(path.dirname(path.dirname(s.directory)), fetchStation(`link:${fake}`, process.env).entry);
    // 加了插件，没点名它的镜头指纹不变。
    expect(fingerprint(plain, 'claude', resolveAllSkills('claude', plain.directory, {}, plain)).fingerprint).toBe(before.fingerprint);
    const inputs = fingerprint(named, 'claude', resolveAllSkills('claude', named.directory, {}, named));
    expect(Object.keys(inputs.parts ?? {})).toContain('skill:plugin:fake-publisher/caption-kit');
  });
});
