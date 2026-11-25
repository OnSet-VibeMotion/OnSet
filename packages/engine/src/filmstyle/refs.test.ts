import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listStyleRefs, normalizeRefSlug, RefsDirEnv } from './refs';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-style-refs-'));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('offline film style refs', () => {
  it('degrades gracefully when env is unset or directory does not exist', () => {
    const unset = listStyleRefs('03-isometric', { env: {} });
    expect(unset).toMatchObject({
      available: false,
      slug: '03-isometric',
      frames: [],
      manifest_checked: false,
      mismatches: [],
    });
    expect(unset.hint).toContain(RefsDirEnv);

    const missing = listStyleRefs('mg-styles/07-liquid', { refsDir: path.join(tempDir(), 'does-not-exist'), env: {} });
    expect(missing).toMatchObject({ available: false, slug: '07-liquid', frames: [] });
    expect(missing.hint).toContain('不存在');
  });

  it('lists frames from local directory and verifies SHA-256 against manifest.json', () => {
    const root = tempDir();
    const slugDir = path.join(root, '03-isometric');
    fs.mkdirSync(slugDir, { recursive: true });
    const f1 = Buffer.from('fake-png-01');
    const f2 = Buffer.from('fake-webp-02');
    fs.writeFileSync(path.join(slugDir, 'frame-01.png'), f1);
    fs.writeFileSync(path.join(slugDir, 'frame-02.webp'), f2);
    fs.writeFileSync(path.join(slugDir, 'notes.txt'), 'ignored');
    fs.writeFileSync(
      path.join(slugDir, 'manifest.json'),
      JSON.stringify({
        files: {
          'frame-01.png': sha256(f1),
          'frame-02.webp': 'sha256:' + sha256(f2),
        },
      }),
    );

    const ok = listStyleRefs('mg-styles/03-isometric', { env: { [RefsDirEnv]: root } });
    expect(ok.available).toBe(true);
    expect(ok.manifest_checked).toBe(true);
    expect(ok.mismatches).toEqual([]);
    expect(ok.frames.map((f) => f.file)).toEqual(['frame-01.png', 'frame-02.webp']);
    expect(ok.frames.every((f) => f.verified === true)).toBe(true);

    // 篡改一帧触发 SHA-256 不匹配报告
    fs.writeFileSync(path.join(slugDir, 'frame-02.webp'), Buffer.from('tampered-bytes'));
    const bad = listStyleRefs('03-isometric', { refsDir: root });
    expect(bad.available).toBe(true);
    expect(bad.manifest_checked).toBe(true);
    expect(bad.mismatches).toHaveLength(1);
    expect(bad.mismatches[0].file).toBe('frame-02.webp');
    expect(bad.frames.find((f) => f.file === 'frame-02.webp')?.mismatch).toBe(true);
  });

  it('supports root-level manifest.json keyed by <slug>/<file>', () => {
    const root = tempDir();
    const slugDir = path.join(root, '12-aurora-glass');
    fs.mkdirSync(slugDir, { recursive: true });
    const img = Buffer.from('aurora-jpg');
    fs.writeFileSync(path.join(slugDir, 'hero.jpg'), img);
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({ files: [{ file: '12-aurora-glass/hero.jpg', sha256: sha256(img) }] }),
    );
    const res = listStyleRefs('12-aurora-glass', { refsDir: root });
    expect(res.available).toBe(true);
    expect(res.frames[0].verified).toBe(true);
  });

  it('blocks path traversal and symlink escapes outside refs root', () => {
    for (const bad of ['..', '../etc', 'mg-styles/../secret', 'a/b/c', '01\\..\\evil', '.hidden', '']) {
      expect(() => normalizeRefSlug(bad), bad).toThrow();
    }

    const root = tempDir();
    const outside = tempDir();
    const secret = path.join(outside, 'secret.png');
    fs.writeFileSync(secret, Buffer.from('secret-bytes'));

    // 1) 帧文件符号链接逃逸
    const slugDir = path.join(root, '20-pixel');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.symlinkSync(secret, path.join(slugDir, 'escape.png'));
    expect(() => listStyleRefs('20-pixel', { refsDir: root })).toThrow('安全拦截');

    // 2) 风格子目录本身为指向根目录外的符号链接
    fs.symlinkSync(outside, path.join(root, '22-hud'));
    expect(() => listStyleRefs('22-hud', { refsDir: root })).toThrow('安全拦截');
  });
});
