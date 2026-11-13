// 新增一个内置风格来源只要在插件的 apply 里登记：来源（ctx.filmStyleSource）、前置资源（ctx.prereq）、
// 数据目录的覆盖变量（ctx.childEnv）。filmstyle、prereqs、config、studio 都从登记表取，不用改。
import '../studio/testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as config from '../config';
import { registerBuiltin } from '../plugin/registry';
import * as prereqs from '../prereqs';
import { filmStylesAPI } from '../studio/filmstyle';
import { tempDir } from '../studio/testsupport';
import * as filmstyle from './index';

const library = tempDir();
fs.mkdirSync(path.join(library, 'ink'), { recursive: true });
fs.writeFileSync(path.join(library, 'ink', 'STYLE.md'), '# 水墨\n');
fs.writeFileSync(path.join(library, 'ink', 'style.json'), JSON.stringify({ cn: '测试水墨', en: 'Test Ink', category_cn: '国风' }));

const unregister = registerBuiltin({
  id: 'test-builtin-styles',
  apply(ctx) {
    const source = new filmstyle.DirectorySource({ id: 'test-ink', name: '测试风格库', dir: library, version: 'test@1', origin: '测试插件' });
    ctx.filmStyleSource(source);
    ctx.prereq({ ...prereqs.filmStyleSourceItem(source), later: { title: '测试风格库', desc: '测试' } });
    ctx.childEnv({ key: 'AM_TEST_INK_LIBRARY', value: () => '' });
  },
});
afterAll(unregister);

describe('builtin film-style source', () => {
  it('reaches the catalog, prerequisites, child environment and the studio without changing them', async () => {
    expect(filmstyle.styleKey(filmstyle.lookup('测试水墨'))).toBe('test-ink/ink');
    const item = prereqs.items().find((i) => i.id === 'styles:test-ink');
    expect(item).toMatchObject({ group: 'styles', name: '整片风格 test-ink', required: false, later: { title: '测试风格库' } });
    expect(item!.ready({})).toEqual([true, library]);

    const root = tempDir();
    fs.writeFileSync(path.join(root, 'article-to-motion.conf'), '');
    const env = { HOME: tempDir(), PATH: '/usr/bin:/bin', AM_TEST_INK_LIBRARY: '/elsewhere' };
    expect(config.childEnvironment(config.load(root, env), env).AM_TEST_INK_LIBRARY).toBe('/elsewhere');

    const body = (await filmStylesAPI(new Request('http://studio.test/api/film-styles')).json()) as { sources: { id: string; ready: boolean }[]; styles: { source: string; slug: string }[] };
    expect(body.sources.find((s) => s.id === 'test-ink')).toMatchObject({ ready: true });
    expect(body.styles.filter((s) => s.source === 'test-ink').map((s) => s.slug)).toEqual(['ink']);

    const installed = filmstyle.install({ projectDir: root, style: filmstyle.lookup('test-ink/ink'), now: new Date('2026-11-11T00:00:00Z') });
    expect(installed.manifest).toMatchObject({ source: 'test-ink', slug: 'ink', version: 'test@1' });
    expect(fs.readFileSync(path.join(filmstyle.skillDir(root), 'SKILL.md'), 'utf8')).toContain('来自测试插件');
  });

  it('refuses a builtin source id reserved for third-party plugins', () => {
    expect(() =>
      registerBuiltin({ id: 'test-bad-styles', apply: (ctx) => ctx.filmStyleSource(new filmstyle.DirectorySource({ id: 'x-bad', name: '', dir: library, version: '', origin: '' })) }),
    ).toThrow('不以 x- 开头');
  });
});
