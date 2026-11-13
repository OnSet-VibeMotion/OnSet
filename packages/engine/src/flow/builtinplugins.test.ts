import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinPlugins, disabledAmOps, loadProjectStations, parseManifest, readLock, setBuiltinEnabled, addToProject, fetchStation } from './index';

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
  it('ships the song explainer as a builtin plugin that claims the song ops', () => {
    const song = builtinPlugins().find((p) => p.manifest.id === 'song');
    expect(song?.builtin).toBe(true);
    expect(song?.entry.source).toBe('builtin');
    expect(song?.manifest.in_use).toEqual(['song.yaml']);
    expect(song?.manifest.am_ops).toContain('song_init');
    expect(song?.manifest.am_ops).toContain('validate_song');
  });

  it('does not let a third party claim am ops or take a builtin id', () => {
    const base = { id: 'mine', version: '1', name: 'x' };
    expect(() => parseManifest(JSON.stringify({ ...base, am_ops: ['scene_run'] }))).toThrow('只有随 ArticleToMotion 下发的内置插件');
    expect(() => parseManifest(JSON.stringify({ ...base, id: 'song' }))).toThrow('与内置插件重名');
    expect(parseManifest(JSON.stringify({ ...base, am_ops: ['scene_run'] }), { builtin: true }).am_ops).toEqual(['scene_run']);
  });

  it('is on by default, can be turned off per project, and not while the project uses it', () => {
    const root = project();
    expect(loadProjectStations(root).stations.map((s) => s.manifest.id)).toEqual(['song']);
    expect(disabledAmOps(root).size).toBe(0);
    setBuiltinEnabled(root, 'song', false);
    expect(readLock(root).disabled).toEqual(['song']);
    expect(loadProjectStations(root).stations).toEqual([]);
    expect(disabledAmOps(root).has('song_generate')).toBe(true);
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
