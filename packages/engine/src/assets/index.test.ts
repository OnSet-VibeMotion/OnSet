import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinSkills, canvas, setAssetsBaseForTest, shared } from './index';

afterEach(() => setAssetsBaseForTest(null));

describe('assets (real tree)', () => {
  it('finds the repository assets', () => {
    expect(shared().exists('article-to-motion.conf')).toBe(true);
    // 制作提示词不再随项目下发：段落在 assets/prompts/，开工时组合。
    expect(shared().exists('PROMPT.md')).toBe(false);
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

  it('rejects unknown canvases', () => {
    expect(() => canvas('no-such-canvas')).toThrow('找不到画幅素材 no-such-canvas');
  });
});

describe('assets (go:embed filtering)', () => {
  it('skips dot and underscore entries except the explicit ones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-assets-'));
    const sharedDir = path.join(root, 'assets', 'shared');
    fs.mkdirSync(path.join(sharedDir, '.agents', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'article-to-motion.conf'), 'x');
    fs.writeFileSync(path.join(sharedDir, '.env.example'), 'x');
    fs.writeFileSync(path.join(sharedDir, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(sharedDir, '_draft.md'), 'x');
    fs.writeFileSync(path.join(sharedDir, '.agents', 'skills', 'demo', 'SKILL.md'), 'x');
    fs.writeFileSync(path.join(sharedDir, '.agents', 'skills', 'demo', '.DS_Store'), 'x');
    setAssetsBaseForTest(root);
    expect(shared().walkFiles()).toEqual(['.agents/skills/demo/SKILL.md', '.env.example', 'article-to-motion.conf']);
  });
});
