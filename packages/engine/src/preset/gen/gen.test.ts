import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as preset from '../index';
import {
  canvasAndSafeArea,
  canvasMarker,
  generate,
  generatedStyles,
  loadTemplates,
  renderExamples,
  renderStyle,
  repoRoot,
  selectStyles,
  selectTargets,
  substituteCanvas,
} from './gen';

const repo = repoRoot(__dirname);
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-gen-'));
const discard = { write: () => {} };
const byID = (id: string) => preset.byID(id)!;
const renderStyleOf = (p: preset.Preset, style: preset.Style) => renderStyle(p, style, loadTemplates(repo, style.id));
const frontmatterOf = (body: string) => {
  const parts = body.split('---');
  expect(parts.length).toBeGreaterThanOrEqual(3);
  return parts[1];
};

/** generate 应写出的全部文本产物（相对 assets/）。 */
function outputs(): string[] {
  const out: string[] = [];
  for (const p of preset.all()) {
    for (const style of generatedStyles()) {
      const dir = `styles/${style.id}/${p.id}`;
      out.push(`${dir}/frame.md`, `${dir}/${preset.guideDoc(style)}`);
    }
  }
  return out;
}

describe('preset generator', () => {
  it('renders the canvas and safe-area block', () => {
    expect(canvasAndSafeArea(byID('vertical-9x16'))).toBe(
      [
        'canvas:',
        '  width_px: 1080',
        '  height_px: 1920',
        '  fps: 30',
        '  orientation: vertical',
        'safe_area:',
        '  structural: {left_px: 40, right_px: 40, top_px: 96, bottom_px: 60}',
        '  main_content: {left_px: 88, right_px: 88, top_px: 120, bottom_px: 100}',
        '  critical_text: {left_px: 88, right_px: 180, top_px: 120, bottom_px: 260}',
        '  cover_title: {left_px: 88, right_px: 180, top_px: 260, bottom_px: 940}',
        '  subtitles: {left_px: 88, right_px: 180, top_px: 1470, bottom_px: 260}',
      ].join('\n'),
    );
  });

  // frame.md 与说明书的 frontmatter 必须逐字节相同，validate.Style 会做 DeepEqual。
  it('keeps frontmatter identical across frame.md and the guide', () => {
    const p = byID('vertical-9x16');
    for (const style of preset.allStyles()) {
      const files = renderStyleOf(p, style);
      const frame = frontmatterOf(files.get('frame.md')!);
      expect(frontmatterOf(files.get(preset.guideDoc(style))!), style.id).toBe(frame);
      expect(frame).toContain('height_px: 1920');
    }
  });

  it('rejects a mismatched style identity', () => {
    const style = preset.defaultStyle();
    const tpl = loadTemplates(repo, style.id);
    tpl.frontmatter = tpl.frontmatter.replace('style_id: ' + style.id, 'style_id: other-v1');
    expect(() => renderStyle(byID('vertical-3x4'), style, tpl)).toThrow('与风格表不一致');
  });

  it('has templates for every style', () => {
    for (const style of preset.allStyles()) expect(() => loadTemplates(repo, style.id)).not.toThrow();
  });

  it('renders the custom draft for every canvas', () => {
    const tpl = loadTemplates(repo, preset.CustomStyle.id);
    for (const p of preset.all()) {
      const files = renderStyle(p, preset.CustomStyle, tpl);
      expect(frontmatterOf(files.get('frame.md')!)).toContain(`style_id: ${preset.DraftStyleID}\n`);
      expect(files.has(preset.guideDoc(preset.CustomStyle))).toBe(true);
    }
  });

  it('rejects a template without the marker', () => {
    const tpl = loadTemplates(repo, preset.defaultStyle().id);
    tpl.frontmatter = 'schema_version: 1\n';
    expect(() => renderStyle(byID('vertical-3x4'), preset.defaultStyle(), tpl)).toThrow(canvasMarker);
  });

  it('finds the repo root by walking up', () => {
    const root = temp();
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.mkdirSync(path.join(root, 'assets', 'shared'), { recursive: true });
    const deep = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    expect(fs.realpathSync(repoRoot(deep))).toBe(fs.realpathSync(root));
    expect(() => repoRoot(temp())).toThrow('找不到仓库根目录');
  });

  // 缺手写 SVG 时必须报错并点名文件，而不是产出一套残缺示例。
  it('names the missing SVG', () => {
    expect(() => renderExamples(repo, temp(), byID('vertical-3x4'), preset.defaultStyle(), discard)).toThrow('proposition.svg');
  });

  it('rejects a broken anchor', () => {
    const p: preset.Preset = {
      id: 'broken',
      label: '',
      canvas: { widthPx: 1080, heightPx: 1440, fps: 30, orientation: 'vertical' },
      safeArea: [{ name: 'x', leftPx: 0, rightPx: 0, anchor: 'middle' }],
      platform: byID('vertical-3x4').platform,
      layoutNotes: '',
    };
    expect(() => canvasAndSafeArea(p)).toThrow();
  });

  it('produces parseable frontmatter', () => {
    for (const p of preset.all()) {
      const body = renderStyleOf(p, preset.defaultStyle()).get('frame.md')!;
      expect(body.startsWith('---\n')).toBe(true);
      expect(body.split('\n---').length).toBeGreaterThan(1);
      expect(body).not.toContain(canvasMarker);
    }
  });

  it('writes every preset into the root and logs sorted paths', () => {
    const root = temp();
    let log = '';
    generate(repo, root, preset.all(), generatedStyles(), false, { write: (t) => (log += t) });
    for (const name of outputs()) expect(fs.existsSync(path.join(root, 'assets', name)), name).toBe(true);
    // 制作提示词不经生成器（按流程在开工时组合），不再写 assets/presets。
    expect(fs.existsSync(path.join(root, 'assets', 'presets'))).toBe(false);
    expect(log).toContain(`generated assets/styles/${preset.defaultStyle().id}/vertical-9x16/frame.md`);
  });

  // 产物必须与仓库里签入的一致——这正是 CI 幂等门要保证的事，也证明 TS 生成器与 Go 版逐字节相同。
  it('matches the committed assets byte-for-byte', () => {
    const root = temp();
    generate(repo, root, preset.all(), generatedStyles(), false, discard);
    for (const name of outputs()) {
      const fresh = fs.readFileSync(path.join(root, 'assets', name));
      const committed = fs.readFileSync(path.join(repo, 'assets', name));
      expect(fresh.equals(committed), `${name} 与签入产物不一致，需重跑生成器`).toBe(true);
    }
  });

  it('selects styles and targets', () => {
    expect(selectStyles('')).toHaveLength(preset.allStyles().length + 1);
    expect(selectStyles(preset.DraftStyleID).map((s) => s.id)).toEqual([preset.DraftStyleID]);
    expect(() => selectStyles('no-such-style')).toThrow();
    expect(selectTargets('')).toHaveLength(preset.all().length);
    expect(selectTargets('vertical-9x16').map((p) => p.id)).toEqual(['vertical-9x16']);
    expect(() => selectTargets('square-1x1')).toThrow();
  });

  it('fills canvas placeholders per orientation', () => {
    const style = preset.defaultStyle();
    const v = renderStyleOf(byID('vertical-3x4'), style).get('frame.md')!;
    const l = renderStyleOf(byID('landscape-16x9'), style).get('frame.md')!;
    for (const want of ['content_width_px: 904', '竖屏', '抖音右侧互动栏']) expect(v).toContain(want);
    for (const want of ['content_width_px: 1680', '横屏', '播放器底部控制栏', '## 横屏构图要点']) expect(l).toContain(want);
    for (const leaked of ['{{', '抖音']) expect(l).not.toContain(leaked);
  });

  it('rejects unknown placeholders and applies offsets', () => {
    expect(() => substituteCanvas(byID('vertical-3x4'), 'x {{NO_SUCH_TOKEN}} y')).toThrow('未知占位符');
    expect(substituteCanvas(byID('vertical-3x4'), '{{CONTENT_LEFT_PX+8}}/{{CONTENT_WIDTH_PX-16}}')).toBe('96/888');
  });
});
