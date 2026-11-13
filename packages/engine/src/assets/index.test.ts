import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinSkills, files, fontFiles, preset, setAssetsBaseForTest, shared, style } from './index';

afterEach(() => setAssetsBaseForTest(null));

describe('assets (real tree)', () => {
  it('finds the repository assets', () => {
    expect(shared().exists('PROMPT.md')).toBe(true);
  });

  it('includes the explicitly embedded dot entries', () => {
    const top = shared().readDir().map((e) => e.name);
    expect(top).toContain('.env.example');
    expect(top).toContain('.agents');
  });

  it('lists builtin skills from the tree', () => {
    const skills = builtinSkills();
    expect(skills.size).toBeGreaterThan(0);
    for (const name of skills) expect(shared().exists(`.agents/skills/${name}/SKILL.md`)).toBe(true);
  });

  it('rejects unknown presets and styles with Go-identical messages', () => {
    expect(() => preset('no-such-canvas')).toThrow('找不到预设素材 no-such-canvas');
    expect(() => style('no-such-style', 'vertical-3x4')).toThrow('找不到风格素材 no-such-style/vertical-3x4');
  });

  it('reads fonts from the pool and dedupes licenses', () => {
    const pool = files().readDir('fontpool').filter((e) => !e.isDir).map((e) => e.name);
    const font = pool.find((n) => n.endsWith('.woff2'));
    const license = pool.find((n) => /\.(txt|md)$/i.test(n));
    if (!font || !license) return;
    const out = fontFiles([
      { file: font, license },
      { file: font, license },
    ]);
    expect([...out.keys()].sort()).toEqual([`assets/fonts/${font}`, `assets/fonts/${license}`].sort());
    expect(() => fontFiles([{ file: 'missing.woff2', license }])).toThrow('字体池里没有文件 missing.woff2');
  });
});

describe('assets (go:embed filtering)', () => {
  it('skips dot and underscore entries except the explicit ones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-assets-'));
    const sharedDir = path.join(root, 'assets', 'shared');
    fs.mkdirSync(path.join(sharedDir, '.agents', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'PROMPT.md'), 'x');
    fs.writeFileSync(path.join(sharedDir, '.env.example'), 'x');
    fs.writeFileSync(path.join(sharedDir, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(sharedDir, '_draft.md'), 'x');
    fs.writeFileSync(path.join(sharedDir, '.agents', 'skills', 'demo', 'SKILL.md'), 'x');
    fs.writeFileSync(path.join(sharedDir, '.agents', 'skills', 'demo', '.DS_Store'), 'x');
    setAssetsBaseForTest(root);
    expect(shared().walkFiles()).toEqual(['.agents/skills/demo/SKILL.md', '.env.example', 'PROMPT.md']);
  });
});
