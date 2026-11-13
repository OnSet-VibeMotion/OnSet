import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookPath } from '../envutil';
import { goodSVG, goodYAML, tempDir, viewsYAML, writePack } from './fixtures';
import { DefaultView, load, type Pack } from './pack';
import { poseSVG, preview } from './preview';

function has(name: string): boolean {
  try {
    lookPath(name, process.env.PATH ?? '');
    return true;
  } catch {
    return false;
  }
}
const hasRenderers = has('rsvg-convert') && has('magick');

function loadedPack(): Pack {
  const dir = writePack(goodYAML);
  fs.writeFileSync(path.join(dir, 'rig.svg'), goodSVG);
  return load(dir);
}

function loadedMultiViewPack(): Pack {
  const dir = writePack(viewsYAML);
  // 本测试只关心 pivot 来自哪个视图的声明，三个 rig 文件内容相同即可。
  for (const name of ['rig.svg', 'rig-tq.svg', 'rig-side.svg']) fs.writeFileSync(path.join(dir, name), goodSVG);
  return load(dir);
}

describe('poseSVG', () => {
  it('applies rotation at pivot', () => {
    const body = poseSVG(loadedPack(), DefaultView, 'pointing');
    // pointing: frontLeg 48 度、head -6 度，pivot 来自 yaml。
    expect(body).toContain('rotate(48 176 330)');
    expect(body).toContain('rotate(-6 200 168)');
  });

  it('idle has no rotation', () => {
    expect(poseSVG(loadedPack(), DefaultView, 'idle')).not.toContain('rotate(');
  });

  it('unknown pose', () => {
    expect(() => poseSVG(loadedPack(), DefaultView, 'flying')).toThrow('flying');
  });

  it('uses requested view pivot', () => {
    // side 视图的 frontLeg pivot 是 [160, 334]，不是默认视图的 [176, 330]。
    expect(poseSVG(loadedMultiViewPack(), 'side', 'pointing')).toContain('rotate(48 160 334)');
  });

  // id 不在 <g 后第一位（手写 rig 里很常见）时，正则式实现会完全不匹配，
  // 静默丢掉整个关节的旋转、不报错。按属性名定位注入点后必须与属性顺序无关。
  it('injects regardless of attribute order', () => {
    const dir = writePack(goodYAML);
    fs.writeFileSync(path.join(dir, 'rig.svg'), goodSVG.replace('<g id="j-head">', '<g class="limb" id="j-head">'));
    expect(poseSVG(load(dir), DefaultView, 'pointing')).toContain('rotate(-6 200 168)');
  });

  // 自闭合的 j- 分组（<g id="j-x"/>）注入点在 "/>" 之前，不是任意 ">" 之前。
  it('injects into self-closing joint group', () => {
    const dir = writePack(goodYAML);
    fs.writeFileSync(
      path.join(dir, 'rig.svg'),
      goodSVG.replace('<g id="j-frontLeg"><path d="M176 330 L176 420" stroke="#000" stroke-width="6"/></g>', '<g id="j-frontLeg"/>'),
    );
    expect(poseSVG(load(dir), DefaultView, 'pointing')).toContain('<g id="j-frontLeg" transform="rotate(48 176 330)"/>');
  });
});

describe.skipIf(!hasRenderers)('preview (needs rsvg-convert and ImageMagick)', () => {
  it('returns one sheet per view', () => {
    const sheets = preview(loadedMultiViewPack(), tempDir());
    // 每个视图一张，共 3 张。
    expect(Object.keys(sheets)).toHaveLength(3);
    for (const sheet of Object.values(sheets)) expect(fs.existsSync(sheet)).toBe(true);
  });

  // 姿势数超过一行 4 张时，如果 contactSheet 的 tile 还写死 "4x1"，
  // ImageMagick 的 montage 会静默产出 out-0.png、out-1.png，preview 返回的
  // 那个路径根本不存在。这里用 6 个姿势覆盖这条回归线。
  it('produces contact sheet for many poses', () => {
    const manyPosesYAML = goodYAML.replace(
      'poses:\n  idle: {}\n  pointing: { frontLeg: 48, head: -6 }\n',
      `poses:
  idle: {}
  pose1: { head: 5 }
  pose2: { head: -5 }
  pose3: { frontLeg: 10 }
  pose4: { frontLeg: -10 }
  pose5: { head: 3, frontLeg: 3 }
`,
    );
    const dir = writePack(manyPosesYAML);
    fs.writeFileSync(path.join(dir, 'rig.svg'), goodSVG);
    const pack = load(dir);
    // 测试夹具姿势数应超过一行 4 张。
    expect(Object.keys(pack.poses!).length).toBeGreaterThan(4);
    const sheets = preview(pack, tempDir());
    expect(sheets[DefaultView]).toBeDefined();
    expect(fs.existsSync(sheets[DefaultView])).toBe(true);
  });
});
