import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as filmstyle from '../../filmstyle';
import '../../plugin';
import { verifySceneMotionEffects } from '../../scene/motion_prompt';
import {
  catalog,
  entryStyle,
  find,
  LicenseName,
  mgSource,
  PinnedStyleCount,
  PinnedVersion,
  SourceID,
  UpstreamRepo,
} from './index';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-mg-styles-'));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe('mg-styles catalog', () => {
  it('ships all 15 non-Blender MIT styles with complete visual specs and contracts', () => {
    const list = catalog();
    expect(list.length).toBe(PinnedStyleCount);
    expect(list.map((s) => s.slug)).not.toContain('04-3d-render');

    const slugs = new Set<string>();
    const threejs: string[] = [];
    const webgl2: string[] = [];
    const canvas2d: string[] = [];

    for (const entry of list) {
      expect(entry.slug).toMatch(/^\d{2}-[a-z0-9-]+$/);
      expect(slugs.has(entry.slug), `slug 重复：${entry.slug}`).toBe(false);
      slugs.add(entry.slug);
      expect(entry.cn).not.toBe('');
      expect(entry.en).not.toBe('');
      expect(entry.summary).not.toBe('');
      expect(entry.uses.length).toBeGreaterThanOrEqual(2);
      expect(entry.typography).not.toBe('');
      expect(entry.composition).not.toBe('');
      expect(entry.texture).not.toBe('');
      expect(entry.motion_grammar).not.toBe('');
      expect(entry.recipes.transition).not.toBe('');
      expect(entry.recipes.impact).not.toBe('');
      expect(entry.recipes.camera).not.toBe('');
      expect(entry.recipes.grain).not.toBe('');
      expect(entry.recipes.secondary).not.toBe('');
      expect(entry.taboos.length).toBeGreaterThanOrEqual(2);

      // 每套风格推荐的 motion_effects 都必须通过 verifySceneMotionEffects 校验。
      expect(entry.motion_effects.length).toBeGreaterThanOrEqual(1);
      const hits = verifySceneMotionEffects(entry.motion_effects, undefined, entry.slug);
      expect(hits.length).toBe(entry.motion_effects.length);

      // 引擎契约分级：threejs/webgl2 为 error，canvas2d 为 warn。
      const req = entry.engine_contract.required;
      expect(req.length).toBe(1);
      if (req[0] === 'threejs') {
        expect(entry.engine_contract.severity).toBe('error');
        threejs.push(entry.slug);
      } else if (req[0] === 'webgl2') {
        expect(entry.engine_contract.severity).toBe('error');
        webgl2.push(entry.slug);
      } else if (req[0] === 'canvas2d') {
        expect(entry.engine_contract.severity).toBe('warn');
        canvas2d.push(entry.slug);
      }
    }

    expect(threejs.sort()).toEqual(['03-isometric', '10-synthwave', '22-hud']);
    expect(webgl2.sort()).toEqual(['07-liquid', '12-aurora-glass', '20-pixel']);
    expect(canvas2d.length).toBe(9);
  });

  it('registers in filmstyle catalog without colliding with other sources', () => {
    expect(filmstyle.sourceByID(SourceID)).toBeDefined();
    expect(filmstyle.categories(SourceID).length).toBeGreaterThanOrEqual(4);

    const others = filmstyle
      .sources()
      .filter((s) => s.id() !== SourceID)
      .flatMap((s) => s.catalog());
    const otherCN = new Set(others.map((o) => o.cn));
    const otherSlugs = new Set(others.map((o) => o.slug));

    for (const entry of catalog()) {
      expect(otherCN.has(entry.cn), `中文名撞车：${entry.cn}`).toBe(false);
      expect(otherSlugs.has(entry.slug), `slug 撞车：${entry.slug}`).toBe(false);
      for (const query of [`${SourceID}/${entry.slug}`, entry.slug, entry.cn, entry.en]) {
        expect(filmstyle.styleKey(filmstyle.lookup(query)), query).toBe(`${SourceID}/${entry.slug}`);
      }
    }
  });

  it('installs every style offline with contract files, MIT attribution, and idempotency', () => {
    const entry = find('03-isometric')!;
    const project = tempDir();
    const first = filmstyle.install({
      projectDir: project,
      style: entryStyle(entry),
      now: new Date('2026-11-25T00:00:00Z'),
    });
    expect(first.unchanged).toBe(false);
    expect(first.manifest).toMatchObject({ source: SourceID, slug: '03-isometric', version: PinnedVersion });

    const dir = filmstyle.skillDir(project);
    const styleMD = fs.readFileSync(path.join(dir, filmstyle.StyleFile), 'utf8');
    const skillMD = fs.readFileSync(path.join(dir, filmstyle.GuideFile), 'utf8');
    const styleJSON = JSON.parse(fs.readFileSync(path.join(dir, 'style.json'), 'utf8')) as Record<string, unknown>;
    const attribution = fs.readFileSync(path.join(dir, 'ATTRIBUTION.md'), 'utf8');

    expect(styleMD).toContain(UpstreamRepo);
    expect(styleMD).toContain('效果配方表');
    expect(styleMD).toContain('onset-engine-deviation');
    expect(styleMD).toContain('motion-prompt:030');
    expect(skillMD).toContain('HyperFrames');
    expect(skillMD).toContain(filmstyle.RefsDirEnv);
    expect(styleJSON.license).toBe(LicenseName);
    expect(styleJSON.engine_contract).toMatchObject({ required: ['threejs'], severity: 'error' });
    expect(attribution).toContain('MIT');

    const second = filmstyle.install({ projectDir: project, style: entryStyle(entry) });
    expect(second.unchanged).toBe(true);
  });

  it('resolves poster from local offline refs directory when configured', () => {
    expect(() => mgSource.poster({}, '03-isometric')).toThrow();
    const refsRoot = tempDir();
    const slugDir = path.join(refsRoot, '03-isometric');
    fs.mkdirSync(slugDir, { recursive: true });
    const img = path.join(slugDir, 'frame-01.png');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const poster = mgSource.poster({ [filmstyle.RefsDirEnv]: refsRoot }, '03-isometric');
    expect(poster).toBe(fs.realpathSync(img));
  });
});
