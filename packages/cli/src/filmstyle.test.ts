import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as filmstyle from '@am/engine/filmstyle';
import { registerBuiltin } from '@am/engine/plugin';
import './filmstyle';
import { Command, ref } from './cobra';
import { opCommand } from './ops/cli';
import { allOps } from './ops/op';
import { Buffer, tempDir } from './testutil';

// 假来源：命令只依赖 filmstyle 的通用部分，不需要真实风格库。
const style = (slug: string, cn: string): filmstyle.Style => ({
  source: 'fake',
  slug,
  order: '',
  cn,
  en: slug,
  category_cn: '测试',
  category_en: 'Test',
  uses: null,
  summary: '',
});
// 假来源经测试里登记的内置插件进来源表。
registerBuiltin({
  id: 'test-cli-styles',
  apply(ctx) {
    ctx.filmStyleSource({
      id: () => 'fake',
      name: () => '测试来源',
      gallery: () => '',
      location: () => '/dev/null',
      check: () => {},
      prepare: async () => {},
      poster: () => {
        throw Object.assign(new Error('file does not exist'), { code: 'ENOENT' });
      },
      catalog: () => [style('ink', '水墨'), style('oil', '油画'), style('pixel', '像素')],
      fill: (dir, s) => {
        fs.writeFileSync(path.join(dir, filmstyle.StyleFile), '# ' + filmstyle.styleKey(s));
        fs.writeFileSync(path.join(dir, filmstyle.GuideFile), 'guide');
        return 'v1';
      },
    });
  },
});

function project(): string {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'article-to-motion.conf'), '');
  return root;
}

function sceneWith(root: string, id: string, filmStyle: string): void {
  const dir = path.join(root, 'scenes', id);
  fs.mkdirSync(dir, { recursive: true });
  const body: Record<string, unknown> = { id, duration_seconds: 1, output: 'out.mp4', transcript: 't.srt', text: 'x' };
  if (filmStyle !== '') body.film_style = filmStyle;
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(body));
}

async function am(root: string, ...args: string[]): Promise<{ out: string; err: Error | null }> {
  const out = new Buffer();
  // 只挂 film-style 这一组操作：命令行适配与 mountOps 相同。
  const cmd = new Command({ use: 'film-style' });
  for (const op of allOps().filter((o) => o.cli[0] === 'film-style')) cmd.addCommand(opCommand(op, out, out, ref(false)));
  cmd.setOut(out);
  cmd.setErr(out);
  try {
    await cmd.execute([...args, '--project-root', root]);
    return { out: out.text, err: null };
  } catch (err) {
    return { out: out.text, err: err as Error };
  }
}

describe('am film-style', () => {
  it('adds extra styles, shows who uses them, and guards removal', async () => {
    const root = project();
    expect((await am(root, 'use', 'fake/ink')).err).toBeNull();
    const added = await am(root, 'add', '油画');
    expect(added.err, added.out).toBeNull();
    expect(added.out).toContain('"film_style": "fake/oil"');
    expect(filmstyle.installedExtras(root).map(filmstyle.manifestKey)).toEqual(['fake/oil']);

    sceneWith(root, 'scene-001', '');
    sceneWith(root, 'scene-002', 'fake/oil');
    sceneWith(root, 'scene-003', 'none');
    sceneWith(root, 'scene-004', 'fake/pixel');
    const shown = await am(root, 'show');
    expect(shown.out).toContain('默认风格：水墨 ink（fake/ink）');
    expect(shown.out).toMatch(/使用：scene-001\n/);
    expect(shown.out).toContain('额外风格：油画 oil（fake/oil）');
    expect(shown.out).toMatch(/使用：scene-002\n/);
    expect(shown.out).toContain('不用整片风格的镜头：scene-003');
    expect(shown.out).toContain('scene-004 点名的 fake/pixel 没装进项目');
    const json = JSON.parse((await am(root, 'show', '--json')).out);
    expect(json.extras[0].slug).toBe('oil');
    expect(json.scenes.find((s: { id: string }) => s.id === 'scene-002').film_style).toBe('fake/oil');

    const refused = await am(root, 'remove', 'fake/oil');
    expect(refused.err?.message).toContain('还有镜头点名用 fake/oil：scene-002');
    expect((await am(root, 'remove', 'fake/oil', '--force')).err).toBeNull();
    expect(filmstyle.installedExtras(root)).toEqual([]);
  });

  // 换默认风格时还有镜头点名旧的默认风格：旧的留作额外风格，那些镜头照常渲染。
  it('keeps a replaced default that scenes still name', async () => {
    const root = project();
    await am(root, 'use', 'fake/ink');
    sceneWith(root, 'scene-001', 'fake/ink');
    const replaced = await am(root, 'use', 'fake/pixel', '--replace');
    expect(replaced.err, replaced.out).toBeNull();
    expect(replaced.out).toContain('fake/ink 还有镜头点名在用，已留作额外风格');
    expect(filmstyle.styleDirOf(root, 'fake/ink')).toBe(filmstyle.extraDir(root, 'fake/ink'));

    const removed = await am(root, 'remove');
    expect(removed.err, removed.out).toBeNull();
    expect(removed.out).toContain('已去掉默认风格 像素 pixel');
  });
});
