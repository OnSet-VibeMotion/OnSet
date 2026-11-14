import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, prepare, freeze, inputs, verify, CacheDir, ManifestFile } from './index';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-renderassets-')));
  roots.push(root);
  const project = path.join(root, 'project');
  const source = path.join(project, 'assets', 'fonts');
  const scene = path.join(project, 'scenes', 'one');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(scene, { recursive: true });
  fs.writeFileSync(path.join(source, 'font.woff2'), 'font version 1');
  const files = () => collect([{ from: source, to: 'assets/fonts' }]);
  return { root, project, source, scene, files };
}

describe('shared render resources', () => {
  it('shares immutable content across scenes and survives moving the entire project', () => {
    const f = fixture();
    prepare(f.project, f.scene, f.files());
    const second = path.join(f.project, 'scenes', 'two');
    fs.mkdirSync(second);
    prepare(f.project, second, f.files());
    const rel = 'assets/fonts/font.woff2';
    const firstFile = path.join(f.scene, rel);
    if (process.platform !== 'win32') {
      expect(fs.lstatSync(firstFile).isSymbolicLink()).toBe(true);
      expect(path.isAbsolute(fs.readlinkSync(firstFile))).toBe(false);
      expect(fs.realpathSync(firstFile)).toBe(fs.realpathSync(path.join(second, rel)));
    }
    expect(fs.readdirSync(path.join(f.project, CacheDir))).toHaveLength(1);
    const before = inputs(f.scene, f.files());
    const moved = path.join(f.root, 'moved');
    fs.renameSync(f.project, moved);
    expect(fs.readFileSync(path.join(moved, 'scenes/one', rel), 'utf8')).toBe('font version 1');
    expect(inputs(path.join(moved, 'scenes/one'), collect([{ from: path.join(moved, 'assets/fonts'), to: 'assets/fonts' }]))).toEqual(before);
  });

  it('updates only the rerendered scene when a source changes', () => {
    const f = fixture();
    const second = path.join(f.project, 'scenes', 'two');
    fs.mkdirSync(second);
    prepare(f.project, f.scene, f.files());
    prepare(f.project, second, f.files());
    const before = inputs(f.scene, f.files());
    fs.writeFileSync(path.join(f.source, 'font.woff2'), 'font version 2');
    expect(inputs(f.scene, f.files())).not.toEqual(before);
    prepare(f.project, f.scene, f.files());
    expect(fs.readFileSync(path.join(f.scene, 'assets/fonts/font.woff2'), 'utf8')).toBe('font version 2');
    expect(fs.readFileSync(path.join(second, 'assets/fonts/font.woff2'), 'utf8')).toBe('font version 1');
    expect(fs.readFileSync(path.join(f.source, 'font.woff2'), 'utf8')).toBe('font version 2');
  });

  it('adopts an identical old copy but refuses to replace customized files', () => {
    const f = fixture();
    const dest = path.join(f.scene, 'assets/fonts/font.woff2');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'custom');
    expect(() => prepare(f.project, f.scene, f.files())).toThrow('已有文件');
    expect(fs.readFileSync(dest, 'utf8')).toBe('custom');
    fs.writeFileSync(dest, 'font version 1');
    prepare(f.project, f.scene, f.files());
    expect(fs.existsSync(path.join(f.scene, ManifestFile))).toBe(true);
    prepare(f.project, f.scene, f.files());
  });

  it('materializes replay inputs without links or dependence on the original project', () => {
    const f = fixture();
    prepare(f.project, f.scene, f.files());
    const before = inputs(f.scene, f.files());
    const replay = path.join(f.root, 'replay');
    freeze(f.scene, replay);
    fs.rmSync(f.project, { recursive: true, force: true });
    expect(fs.lstatSync(path.join(replay, 'assets/fonts/font.woff2')).isSymbolicLink()).toBe(false);
    expect(inputs(replay, [])).toEqual(before);
  });

  it('falls back to independent copies when symlinks are unavailable', () => {
    const f = fixture();
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    prepare(f.project, f.scene, f.files());
    const dest = path.join(f.scene, 'assets/fonts/font.woff2');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    fs.chmodSync(dest, 0o644);
    fs.writeFileSync(dest, 'modified');
    expect(() => prepare(f.project, f.scene, f.files())).toThrow('已有文件');
    expect(fs.readFileSync(path.join(f.source, 'font.woff2'), 'utf8')).toBe('font version 1');
  });

  it('rejects escaping destinations, symlinked sources and symlinked destination parents', () => {
    const f = fixture();
    expect(() => collect([{ from: f.source, to: '../escape' }])).toThrow();
    expect(() => collect([{ from: f.source, to: 'C:/escape' }])).toThrow();
    if (process.platform === 'win32') return;
    fs.symlinkSync(f.source, path.join(f.scene, 'assets'));
    expect(() => prepare(f.project, f.scene, f.files())).toThrow('符号链接');
    fs.symlinkSync(path.join(f.source, 'font.woff2'), path.join(f.source, 'alias.woff2'));
    expect(() => f.files()).toThrow('符号链接');
  });

  it('detects corrupted cache contents and rejects a forged resource manifest', () => {
    const f = fixture();
    prepare(f.project, f.scene, f.files());
    const cache = path.join(f.project, CacheDir);
    const blob = path.join(cache, fs.readdirSync(cache)[0]!);
    fs.chmodSync(blob, 0o644);
    fs.writeFileSync(blob, 'bad bytes');
    expect(() => verify(f.scene)).toThrow('已被修改');
    expect(() => prepare(f.project, f.scene, f.files())).toThrow();
    fs.writeFileSync(path.join(f.scene, ManifestFile), '{"schema":1,"files":[{"path":"../escape","sha256":"bad","kind":"link"}]}');
    expect(() => freeze(f.scene, path.join(f.root, 'replay'))).toThrow();
  });

  it('rejects conflicting mounts before writing and ignores absent optional mounts', () => {
    const f = fixture();
    expect(collect([{ from: path.join(f.root, 'absent'), to: 'vendor' }])).toEqual([]);
    const other = path.join(f.root, 'other.js');
    fs.writeFileSync(other, 'different');
    expect(() => collect([{ from: path.join(f.source, 'font.woff2'), to: 'same.js' }, { from: other, to: 'same.js' }])).toThrow('冲突');
  });

  it('recovers a completed link when interrupted before the manifest write', () => {
    const f = fixture();
    prepare(f.project, f.scene, f.files());
    fs.unlinkSync(path.join(f.scene, ManifestFile));
    prepare(f.project, f.scene, f.files());
    expect(() => verify(f.scene)).not.toThrow();
  });

  it('rejects a forged link to an ancestor’s cache outside this project', () => {
    if (process.platform === 'win32') return;
    const f = fixture();
    prepare(f.project, f.scene, f.files());
    const file = path.join(f.scene, 'assets/fonts/font.woff2');
    const outer = path.join(f.root, CacheDir, f.files()[0]!.sha256);
    fs.mkdirSync(path.dirname(outer), { recursive: true });
    fs.copyFileSync(file, outer);
    fs.unlinkSync(file);
    fs.symlinkSync(path.relative(path.dirname(file), outer), file);
    expect(() => freeze(f.scene, path.join(f.root, 'replay'))).toThrow('链接目标');
  });
});
