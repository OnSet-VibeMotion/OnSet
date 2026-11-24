import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildZip,
  exportProjectZip,
  importProjectZip,
  ManifestFileName,
  readZip,
  validateProjectZipBytes,
} from './index';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-projectzip-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('projectzip', () => {
  it('round-trips an OnSet project, strips secrets/caches and self-validates', () => {
    const src = tempDir();
    fs.writeFileSync(path.join(src, 'onset.conf'), 'ORCHESTRATOR=claude\n');
    fs.writeFileSync(path.join(src, '.env'), 'SECRET_API_KEY=do-not-export\n');
    fs.mkdirSync(path.join(src, 'scenes', 'scene-001', 'attempts'), { recursive: true });
    fs.writeFileSync(path.join(src, 'scenes', 'scene-001', 'index.html'), '<!doctype html><div>hello</div>');
    fs.writeFileSync(path.join(src, 'scenes', 'scene-001', 'scene.mp4'), 'fake-mp4');
    fs.writeFileSync(path.join(src, 'scenes', 'scene-001', 'attempts', 'old.log'), 'noise');
    fs.mkdirSync(path.join(src, 'production', 'studio', 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(src, 'production', 'studio', 'blobs', 'abc'), 'blob');
    fs.writeFileSync(path.join(src, 'production', 'script-final.md'), '# 标题\n正文内容\n');

    const zipFile = path.join(tempDir(), 'demo.onset.zip');
    const exported = exportProjectZip(src, zipFile, { title: '测试片子' });
    expect(exported.title).toBe('测试片子');
    expect(exported.file_count).toBe(3); // onset.conf, index.html, script-final.md

    const dest = path.join(tempDir(), 'imported');
    const imported = importProjectZip(zipFile, dest);
    expect(imported.kind).toBe('onset');
    expect(imported.title).toBe('测试片子');
    expect(imported.file_count).toBe(3);
    expect(fs.readFileSync(path.join(dest, 'production', 'script-final.md'), 'utf8')).toContain('正文内容');
    expect(fs.existsSync(path.join(dest, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'scenes', 'scene-001', 'attempts'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'scenes', 'scene-001', 'scene.mp4'))).toBe(false);
    // 不允许覆盖非空目录
    expect(() => importProjectZip(zipFile, dest)).toThrow(/非空/);
  });

  it('imports a standard HyperFrames project ZIP wrapped in a single folder', () => {
    const zipBytes = buildZip(
      new Map([
        ['MyFilm/index.html', Buffer.from('<div data-composition-id="root">hi</div>')],
        ['MyFilm/assets/note.txt', Buffer.from('asset')],
        ['__MACOSX/._index.html', Buffer.from('mac-junk')],
      ]),
    );
    const zipFile = path.join(tempDir(), 'hf.zip');
    fs.writeFileSync(zipFile, zipBytes);

    const dest = path.join(tempDir(), 'hf-out');
    const imported = importProjectZip(zipFile, dest);
    expect(imported.kind).toBe('hyperframes');
    expect(imported.title).toBe('MyFilm');
    expect(fs.existsSync(path.join(dest, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'hyperframes.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'assets', 'note.txt'), 'utf8')).toBe('asset');
  });

  it('rejects tampered manifests, path traversal and case collisions', () => {
    expect(() => buildZip(new Map([['../evil.txt', Buffer.from('x')]]))).toThrow(/不安全路径/);
    expect(() =>
      buildZip(
        new Map([
          ['Foo.txt', Buffer.from('a')],
          ['foo.txt', Buffer.from('b')],
        ]),
      ),
    ).toThrow(/冲突/);

    const badManifestZip = buildZip(
      new Map([
        [
          ManifestFileName,
          Buffer.from(
            JSON.stringify({
              format: 'onset.project-archive',
              version: 1,
              title: 'bad',
              exported_at: new Date().toISOString(),
              files: [{ path: 'a.txt', bytes: 5, sha256: '0'.repeat(64) }],
            }),
          ),
        ],
        ['a.txt', Buffer.from('hello')],
      ]),
    );
    expect(() => validateProjectZipBytes(badManifestZip)).toThrow(/校验失败/);
    expect(readZip(badManifestZip).size).toBe(2);
  });
});
