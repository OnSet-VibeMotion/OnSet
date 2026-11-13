import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPrompt, fingerprint, load, resolveAllSkills } from '../scene';
import { runPrompt } from '../project/runprompt';
import { projectExtras, recordFlow, route, stationOwners, builtinPlugins, disabledPluginOps, loadProjectStations, parseManifest, readLock, setBuiltinEnabled, addToProject, fetchStation } from './index';

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

  it('is on by default, can be turned off per project, and not while the project uses it', () => {
    const root = project();
    expect(loadProjectStations(root).stations.map((s) => s.manifest.id)).toEqual(['algorithmic-art', 'cast', 'publishing', 'song', 'text-to-lottie']);
    expect(disabledPluginOps(root).size).toBe(0);
    setBuiltinEnabled(root, 'song', false);
    expect(readLock(root).disabled).toEqual(['song']);
    expect(loadProjectStations(root).stations.map((s) => s.manifest.id)).toEqual(['algorithmic-art', 'cast', 'publishing', 'text-to-lottie']);
    expect(disabledPluginOps(root).has('song_generate')).toBe(true);
    // 锁文件里的其他记录不受影响。
    addToProject(root, fetchStation(`link:${path.join(__dirname, 'testdata', 'fake-publisher')}`, process.env).entry);
    expect(readLock(root).disabled).toEqual(['song']);
    setBuiltinEnabled(root, 'song', true);
    expect(readLock(root).disabled).toBeUndefined();
    fs.writeFileSync(path.join(root, 'song.yaml'), 'provider: none\n');
    expect(() => setBuiltinEnabled(root, 'song', false)).toThrow('正在用「歌曲讲解」（有 song.yaml）');
    expect(() => setBuiltinEnabled(root, 'nope', false)).toThrow('没有内置插件 nope');
  });
});

describe('builtin plugins that register renderer skills', () => {
  it('leave the renderer prompt and fingerprint alone unless the project turns them off', () => {
    const root = project();
    const sceneDir = path.join(root, 'scenes', 'scene-001');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify({ id: 'scene-001', duration_seconds: 1, output: 'out.mp4', transcript: 'voice.srt', text: 'hello' }));
    const s = load(sceneDir);
    const before = resolveAllSkills('claude', sceneDir, {}, s);
    const prompt = buildPrompt(s, before);
    const print = fingerprint(s, 'claude', before).fingerprint;
    // 锁文件在但没关任何插件：逐字不变。
    addToProject(root, fetchStation(`link:${path.join(__dirname, 'testdata', 'fake-publisher')}`, process.env).entry);
    const same = resolveAllSkills('claude', sceneDir, {}, s);
    expect(buildPrompt(s, same)).toBe(prompt);
    expect(fingerprint(s, 'claude', same).fingerprint).toBe(print);
    // 关掉生成式艺术：提示词里没有那一段，指纹变了（渲染输入确实变了）。
    setBuiltinEnabled(root, 'algorithmic-art', false);
    const off = resolveAllSkills('claude', sceneDir, {}, s);
    expect(Object.keys(off).some((k) => k.includes('algorithmic-art'))).toBe(false);
    expect(prompt).toContain('生成式艺术参考');
    expect(buildPrompt(s, off)).not.toContain('生成式艺术参考');
    expect(buildPrompt(s, off)).toContain('Lottie 图层');
    expect(fingerprint(s, 'claude', off).fingerprint).not.toBe(print);
  });
});

describe('builtin plugins that register stations', () => {
  it('own the stations they register', () => {
    expect(stationOwners().get('publish')).toBe('publishing');
  });

  it('take the station off the production map and out of the prompt when the project turns them off', () => {
    const root = project();
    recordFlow(root, { id: 'speech', canvas: 'vertical-3x4' });
    expect(route('speech', projectExtras(root)).some((r) => r.node.id === 'publish')).toBe(true);
    expect(runPrompt(root, '').prompt.toString('utf8')).toContain('### 发布配置生命周期');
    setBuiltinEnabled(root, 'publishing', false);
    expect(route('speech', projectExtras(root)).some((r) => r.node.id === 'publish')).toBe(false);
    const off = runPrompt(root, '').prompt.toString('utf8');
    expect(off).not.toContain('发布配置生命周期');
    expect(off).not.toContain('刷新发布配置');
    expect(disabledPluginOps(root).has('validate_publish')).toBe(true);
  });
});
