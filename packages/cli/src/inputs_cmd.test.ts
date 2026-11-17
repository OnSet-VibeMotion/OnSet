import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InputManifestFile, diffInputs, hashInputs } from './inputs_cmd';
import { findOp, normalizeParams } from './ops/op';
import { Buffer, tempDir } from './testutil';

function project(): string {
  const root = tempDir();
  for (const [rel, body] of Object.entries({
    'article.md': '原文',
    'src/a.txt': 'a',
    'src/deep/b.txt': 'b',
    'src/.git/HEAD': 'ref',
    'src/node_modules/x/index.js': 'x',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

async function run(root: string, params: Record<string, unknown>) {
  const op = findOp('inputs_manifest')!;
  const out = new Buffer();
  const result = await op.run(normalizeParams(op, { project_root: root, ...params }), { out, err: out, signal: new AbortController().signal, unsafe: false });
  return { text: out.toString(), data: (result as { data: Record<string, unknown> }).data };
}

describe('inputs_manifest', () => {
  it('hashes regular files and skips dot entries and node_modules', () => {
    const root = project();
    expect(hashInputs(root, ['src', 'article.md']).map((f) => f.path)).toEqual(['article.md', 'src/a.txt', 'src/deep/b.txt']);
    expect(() => hashInputs(root, ['../x'])).toThrow('要在项目里');
    expect(() => hashInputs(root, ['missing'])).toThrow('不存在');
    fs.symlinkSync('/etc/hosts', path.join(root, 'src', 'link'));
    expect(() => hashInputs(root, ['src'])).toThrow('符号链接');
  });

  // 一次调用建好、一次调用核对完；只报变动，不改清单；已有清单不覆盖。
  it('records once and then checks', async () => {
    const root = project();
    const made = await run(root, { paths: ['src', 'article.md'] });
    expect(made.text).toContain('已建输入清单');
    expect(made.data.file_count).toBe(3);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, InputManifestFile), 'utf8'));
    expect(manifest.roots).toEqual(['src', 'article.md']);

    expect((await run(root, { check: true })).data.ok).toBe(true);
    fs.writeFileSync(path.join(root, 'src/a.txt'), 'changed');
    fs.writeFileSync(path.join(root, 'src/new.txt'), 'n');
    fs.rmSync(path.join(root, 'src/deep/b.txt'));
    const checked = await run(root, { check: true });
    expect(checked.data).toMatchObject({ ok: false, changed: ['src/a.txt'], added: ['src/new.txt'], removed: ['src/deep/b.txt'] });
    expect(checked.text).toContain('改动 1 个');
    expect(fs.readFileSync(path.join(root, InputManifestFile), 'utf8')).toBe(JSON.stringify(manifest, null, 2) + '\n');

    await expect(run(root, { paths: ['src'] })).rejects.toThrow('replace');
    const rebuilt = await run(root, { paths: ['src', 'article.md'], replace: true });
    expect(rebuilt.text).toContain('已重建');
    expect((await run(root, { check: true })).data.ok).toBe(true);
  });

  it('lists only a few paths when many changed', () => {
    const before = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}`, bytes: 1, sha256: 'a' }));
    const after = before.map((f) => ({ ...f, sha256: 'b' }));
    expect(diffInputs(before, after).changed).toHaveLength(30);
  });
});
