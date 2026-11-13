// 移植自 internal/filmstyle/filmstyle_test.go。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GuideFile,
  LegacySkillName,
  RootEnv,
  StyleFile,
  categories,
  childEnvKeys,
  install,
  installed,
  installedDir,
  lookup,
  manifestKey,
  register,
  remove,
  skillDir,
  styleKey,
  type PrepareOptions,
  type Source,
  type Style,
} from './index';

/** 测试用的风格来源：证明通用部分不依赖任何具体来源。 */
function fakeSource(id: string, styles: Style[], noGuide = false): Source {
  return {
    id: () => id,
    name: () => '测试来源 ' + id,
    gallery: () => '',
    location: () => '/dev/null',
    check: () => {},
    prepare: async (_opts: PrepareOptions) => {},
    poster: () => {
      throw Object.assign(new Error('file does not exist'), { code: 'ENOENT' });
    },
    envKeys: () => ['AM_TEST_' + id.replaceAll('-', '_').toUpperCase()],
    catalog: () => styles,
    fill: (dir: string, style: Style) => {
      fs.writeFileSync(path.join(dir, StyleFile), '# ' + styleKey(style));
      if (!noGuide) fs.writeFileSync(path.join(dir, GuideFile), 'guide');
      return 'v1';
    },
  };
}

function st(source: string, slug: string, cn: string, en: string, category_cn = ''): Style {
  return { source, slug, order: '', cn, en, category_cn, category_en: '', uses: null, summary: '' };
}

register(fakeSource('alpha', [st('alpha', 'ink', '水墨', 'Ink', '绘画'), st('alpha', 'pixel', '像素', 'Pixel', '游戏')]));
register(fakeSource('beta', [st('beta', 'ink', '墨线', 'Ink Line', '线描')]));
register(fakeSource('broken', [st('broken', 'nope', '坏', 'Broken')], true));

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'am-filmstyle-'));
}

function errorOf(fn: () => unknown): Error | undefined {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  return undefined;
}

describe('filmstyle', () => {
  it('looks up across sources', () => {
    expect(lookup('alpha/ink').cn).toBe('水墨');
    expect(styleKey(lookup('像素'))).toBe('alpha/pixel');
    expect(errorOf(() => lookup('ink'))?.message).toContain('来源/目录名');
    expect(errorOf(() => lookup('nothing'))?.message).toContain('am film-style list');
    const got = categories('alpha');
    expect(got.length).toBe(2);
    expect(got[0]).toBe('绘画');
    const keys = childEnvKeys().join(',');
    expect(keys).toContain(RootEnv);
    expect(keys).toContain('AM_TEST_ALPHA');
  });

  it('enforces the contract and replaces the legacy directory', () => {
    const project = tempDir();
    const broken = lookup('broken/nope');
    const err = errorOf(() => install({ projectDir: project, style: broken }));
    expect(err?.message).toContain(GuideFile);
    expect(fs.existsSync(skillDir(project))).toBe(false);

    // 旧版只有 lemo-opuscar 时装出的目录：照样认得，装新风格时被换掉。
    const legacy = path.join(project, '.agents', 'skills', LegacySkillName);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'lemo-upstream.json'), '{"commit":"abc","slug":"impasto","cn":"油画厚涂","en":"Impasto"}');
    let { manifest, ok } = installed(project);
    expect(ok).toBe(true);
    expect(manifest.legacy).toBe(true);
    expect(manifestKey(manifest)).toBe('lemo-opuscar/impasto');
    expect(manifest.version).toBe('abc');
    expect(installedDir(project)).toBe(legacy);

    const ink = lookup('alpha/ink');
    expect(errorOf(() => install({ projectDir: project, style: ink }))?.message).toContain('--replace');
    const result = install({ projectDir: project, style: ink, replace: true });
    expect(result.replaced).toBe('lemo-opuscar/impasto');
    expect(fs.existsSync(legacy)).toBe(false);
    ({ manifest } = installed(project));
    expect(manifest.source).toBe('alpha');
    expect(manifest.version).toBe('v1');
    expect(manifest.digest).not.toBe('');
    const again = install({ projectDir: project, style: ink });
    expect(again.unchanged).toBe(true);
    expect(remove(project).had).toBe(true);
    ({ ok } = installed(project));
    expect(ok).toBe(false);
  });
});
