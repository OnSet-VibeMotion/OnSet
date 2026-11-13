import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { registerBuiltin } from '../plugin/registry';
import {
  GuideFile,
  StyleFile,
  categories,
  extraDir,
  install,
  installed,
  installedDir,
  installedExtras,
  lookup,
  manifestKey,
  remove,
  removeStyle,
  skillDir,
  styleDirOf,
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

// 假来源经测试里登记的内置插件进来源表：通用部分只认登记表，不认识任何具体来源。
const unregister = registerBuiltin({
  id: 'test-fake-styles',
  apply(ctx) {
    ctx.filmStyleSource(fakeSource('alpha', [st('alpha', 'ink', '水墨', 'Ink', '绘画'), st('alpha', 'pixel', '像素', 'Pixel', '游戏')]));
    ctx.filmStyleSource(fakeSource('beta', [st('beta', 'ink', '墨线', 'Ink Line', '线描')]));
    ctx.filmStyleSource(fakeSource('broken', [st('broken', 'nope', '坏', 'Broken')], true));
  },
});
afterAll(unregister);

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
    expect(errorOf(() => lookup('nothing'))?.message).toContain('film_style_list()');
    const got = categories('alpha');
    expect(got.length).toBe(2);
    expect(got[0]).toBe('绘画');
  });

  it('enforces the contract and replaces the default style', () => {
    const project = tempDir();
    const broken = lookup('broken/nope');
    const err = errorOf(() => install({ projectDir: project, style: broken }));
    expect(err?.message).toContain(GuideFile);
    expect(fs.existsSync(skillDir(project))).toBe(false);

    install({ projectDir: project, style: lookup('beta/ink') });
    let { manifest, ok } = installed(project);
    expect(ok).toBe(true);
    expect(manifestKey(manifest)).toBe('beta/ink');
    expect(installedDir(project)).toBe(skillDir(project));

    const ink = lookup('alpha/ink');
    expect(errorOf(() => install({ projectDir: project, style: ink }))?.message).toContain('--replace');
    const result = install({ projectDir: project, style: ink, replace: true });
    expect(result.replaced).toBe('beta/ink');
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

  // 一个项目可以装几种风格：默认风格在 .agents/skills/am-film-style，其余在 .agents/am-film-styles/<来源>/<目录名>，
  // 不进 .agents/skills（那里整棵算进每个镜头的指纹）。
  it('installs extra styles beside the default', () => {
    const project = tempDir();
    install({ projectDir: project, style: lookup('alpha/ink') });
    const extra = install({ projectDir: project, style: lookup('beta/ink'), as: 'extra' });
    expect(extra.replaced).toBe('');
    expect(manifestKey(installed(project).manifest), '装额外风格不该动默认风格').toBe('alpha/ink');
    expect(fs.existsSync(path.join(extraDir(project, 'beta/ink'), StyleFile))).toBe(true);
    expect(extraDir(project, 'beta/ink').startsWith(path.join(project, '.agents', 'skills')), '额外风格不能进 .agents/skills').toBe(false);
    expect(installedExtras(project).map(manifestKey)).toEqual(['beta/ink']);
    expect(styleDirOf(project, 'alpha/ink')).toBe(skillDir(project));
    expect(styleDirOf(project, 'beta/ink')).toBe(extraDir(project, 'beta/ink'));
    expect(styleDirOf(project, 'alpha/pixel')).toBe('');
    expect(install({ projectDir: project, style: lookup('beta/ink'), as: 'extra' }).unchanged, '重装同一份应当无改动').toBe(true);
    expect(errorOf(() => install({ projectDir: project, style: lookup('alpha/ink'), as: 'extra' }))?.message, '默认风格不能再装成额外风格').toContain('默认风格');

    expect(removeStyle(project, 'beta/ink')).toMatchObject({ had: true, wasDefault: false });
    expect(installedExtras(project)).toEqual([]);
    expect(fs.existsSync(path.join(project, '.agents', 'am-film-styles', 'beta')), '空下来的来源目录应当删掉').toBe(false);
    expect(removeStyle(project, 'beta/ink').had).toBe(false);
    expect(removeStyle(project, 'alpha/ink')).toMatchObject({ had: true, wasDefault: true });
    expect(installed(project).ok).toBe(false);
  });

  // 换默认风格时还有镜头点名旧的：keepReplaced 把旧的留作额外风格；新的默认原先是额外风格时，那份额外的删掉。
  it('keeps the replaced default as an extra and promotes an extra to default', () => {
    const project = tempDir();
    install({ projectDir: project, style: lookup('alpha/ink') });
    install({ projectDir: project, style: lookup('alpha/pixel'), as: 'extra' });
    const result = install({ projectDir: project, style: lookup('alpha/pixel'), replace: true, keepReplaced: true });
    expect(result.replaced).toBe('alpha/ink');
    expect(manifestKey(installed(project).manifest)).toBe('alpha/pixel');
    expect(installedExtras(project).map(manifestKey), '旧默认应当留作额外风格，新默认不该再有额外的一份').toEqual(['alpha/ink']);
    expect(fs.readFileSync(path.join(extraDir(project, 'alpha/ink'), StyleFile), 'utf8')).toBe('# alpha/ink');

    install({ projectDir: project, style: lookup('beta/ink'), replace: true });
    expect(installedExtras(project).map(manifestKey), '不留旧默认时直接删掉').toEqual(['alpha/ink']);
    expect(manifestKey(installed(project).manifest)).toBe('beta/ink');
  });
});
