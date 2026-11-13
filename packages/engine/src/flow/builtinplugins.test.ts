import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPrompt, fingerprint, load, resolveAllSkills } from '../scene';
import { runPrompt } from '../project/runprompt';
import { projectExtras, recordFlow, route, stationOwners, builtinPlugins, loadProjectStations, parseManifest, readLock, addToProject, fetchStation } from './index';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-builtin-'));
  temps.push(root);
  return root;
};

describe('builtin plugins', () => {
  it('ships the song explainer as a builtin plugin', () => {
    const song = builtinPlugins().find((p) => p.manifest.id === 'song');
    expect(song?.builtin).toBe(true);
    expect(song?.entry.source).toBe('builtin');
  });

  it('does not let a third party take a builtin id', () => {
    const base = { id: 'mine', version: '1', name: 'x' };
    expect(() => parseManifest(JSON.stringify({ ...base, id: 'song' }))).toThrow('与内置插件重名');
    expect(parseManifest(JSON.stringify({ ...base, id: 'song' }), { builtin: true }).id).toBe('song');
  });

  it('is always on: an old lock file\'s disabled field is ignored and not written back', () => {
    const root = project();
    const all = ['algorithmic-art', 'beat', 'cast', 'lemo-styles', 'publishing', 'song', 'text-to-lottie'];
    expect(loadProjectStations(root).stations.map((s) => s.manifest.id)).toEqual(all);
    fs.writeFileSync(path.join(root, 'article-to-motion.flow.json'), JSON.stringify({ version: 1, stations: [], disabled: ['song'] }));
    expect(loadProjectStations(root).stations.map((s) => s.manifest.id)).toEqual(all);
    expect('disabled' in readLock(root)).toBe(false);
    addToProject(root, fetchStation(`link:${path.join(__dirname, 'testdata', 'fake-publisher')}`, process.env).entry);
    expect(fs.readFileSync(path.join(root, 'article-to-motion.flow.json'), 'utf8')).not.toContain('disabled');
  });
});

describe('builtin plugins that register renderer skills', () => {
  it('give every scene their skills, whatever the lock file says', () => {
    const root = project();
    const sceneDir = path.join(root, 'scenes', 'scene-001');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
    fs.writeFileSync(path.join(sceneDir, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify({ id: 'scene-001', duration_seconds: 1, output: 'out.mp4', transcript: 'voice.srt', text: 'hello' }));
    const s = load(sceneDir);
    const before = resolveAllSkills('claude', sceneDir, {}, s);
    const prompt = buildPrompt(s, before);
    const print = fingerprint(s, 'claude', before).fingerprint;
    expect(prompt).toContain('生成式艺术参考');
    expect(prompt).toContain('Lottie 图层');
    // 锁文件在（连旧的 disabled 一起）：逐字不变。
    fs.writeFileSync(path.join(root, 'article-to-motion.flow.json'), JSON.stringify({ version: 1, stations: [], disabled: ['algorithmic-art'] }));
    const same = resolveAllSkills('claude', sceneDir, {}, s);
    expect(buildPrompt(s, same)).toBe(prompt);
    expect(fingerprint(s, 'claude', same).fingerprint).toBe(print);
  });
});

describe('builtin plugins that register stations', () => {
  it('own the stations they register', () => {
    expect(stationOwners().get('publish')).toBe('publishing');
  });

  it('put their station on the production map and into the prompt of every project', () => {
    const root = project();
    recordFlow(root, { id: 'speech', canvas: 'vertical-3x4' });
    expect(route('speech', projectExtras(root)).some((r) => r.node.id === 'publish')).toBe(true);
    expect(runPrompt(root, '').prompt.toString('utf8')).toContain('### 发布配置生命周期');
  });
});
