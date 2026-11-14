import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialize } from './init';
import { builtinSources, mapTree } from './testsupport';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-project-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('initialize', () => {
  it('writes reusable skeleton', () => {
    const target = path.join(tempDir(), 'video');
    const result = initialize(target, ...builtinSources());
    expect(result.created).toBeGreaterThan(0);
    for (const name of [
      'onset.conf',
      '.env.example',
      'frame.md',
      'templates/project-rules.md',
      'assets/fonts/noto-sans-sc-400.woff2',
    ]) {
      expect(fs.existsSync(path.join(target, ...name.split('/'))), `missing ${name}`).toBe(true);
    }
    // 制作提示词不拷进项目：开工时按流程组合。
    for (const name of ['PROMPT.md', 'PROMPT-PRODUCTION.md', 'PROMPT-SONG.md', 'PROMPT-CAST-ADDENDUM.md']) expect(fs.existsSync(path.join(target, name)), name).toBe(false);
  });

  it('is idempotent for identical files', () => {
    const target = path.join(tempDir(), 'video');
    initialize(target, ...builtinSources());
    const result = initialize(target, ...builtinSources());
    expect(result.created).toBe(0);
    expect(result.unchanged).toBeGreaterThan(0);
  });

  it('refuses conflicting file without partial writes', () => {
    const target = tempDir();
    fs.writeFileSync(path.join(target, 'frame.md'), 'custom');
    expect(() => initialize(target, ...builtinSources())).toThrow();
    expect(fs.existsSync(path.join(target, 'onset.conf')), 'initializer wrote files before conflict check').toBe(false);
  });

  it('rejects symlinked template directory', () => {
    const target = tempDir();
    const outside = tempDir();
    fs.symlinkSync(outside, path.join(target, 'templates'));
    expect(() => initialize(target, ...builtinSources())).toThrow();
    expect(fs.existsSync(path.join(outside, 'project-rules.md')), 'initializer escaped through symlink').toBe(false);
  });

  it('merges multiple sources', () => {
    const shared = mapTree({ 'PROMPT.md': 'shared\n', 'assets/fonts/noto.woff2': 'font\n' });
    const chosen = mapTree({ 'frame.md': 'frame\n', 'assets/style-guide/examples/a.svg': 'svg\n' });
    const target = tempDir();
    const result = initialize(target, shared, chosen);
    expect(result.created).toBe(4);
    for (const name of ['PROMPT.md', 'assets/fonts/noto.woff2', 'frame.md', 'assets/style-guide/examples/a.svg']) {
      expect(fs.existsSync(path.join(target, ...name.split('/'))), `缺少 ${name}`).toBe(true);
    }
  });

  // 两棵源树写同一路径属于素材组织错误，必须报错而不是让后者静默覆盖前者。
  it('rejects overlapping sources', () => {
    const a = mapTree({ 'frame.md': 'a\n' });
    const b = mapTree({ 'frame.md': 'b\n' });
    expect(() => initialize(tempDir(), a, b)).toThrow('多棵源树写入同一路径');
  });
});
