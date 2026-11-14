import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as preset from '../index';
import { canvasAndSafeArea, canvasMarker, frameAssetPath, generate, loadTemplate, renderFrame, repoRoot, selectTargets, substituteCanvas } from './gen';

const repo = repoRoot(__dirname);
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onset-gen-'));
const discard = { write: () => {} };
const byID = (id: string) => preset.byID(id)!;
const frameOf = (p: preset.Preset) => renderFrame(p, loadTemplate(repo));

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

  it('rejects a template without the marker', () => {
    expect(() => renderFrame(byID('vertical-3x4'), '---\nschema_version: 1\n---\n')).toThrow(canvasMarker);
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

  // frame.md 只有技术信息：画布、安全区、字幕版式与响度目标，没有任何视觉风格字段。
  it('writes only canvas facts into frame.md', () => {
    for (const p of preset.all()) {
      const body = frameOf(p);
      expect(body.startsWith('---\n')).toBe(true);
      expect(body).not.toContain(canvasMarker);
      const front = body.split('\n---\n')[0];
      const keys = front.split('\n').filter((line) => /^[a-z_]+:/.test(line)).map((line) => line.slice(0, line.indexOf(':')));
      expect(keys, p.id).toEqual(['schema_version', 'canvas', 'safe_area', 'subtitles', 'audio']);
    }
  });

  it('writes every preset into the root', () => {
    const root = temp();
    let log = '';
    generate(repo, root, preset.all(), { write: (t) => (log += t) });
    for (const p of preset.all()) expect(fs.existsSync(path.join(root, ...frameAssetPath(p).split('/'))), p.id).toBe(true);
    expect(log).toContain('generated assets/presets/vertical-9x16/frame.md');
  });

  // 产物必须与仓库里签入的一致——这正是 CI 幂等门要保证的事。
  it('matches the committed assets byte-for-byte', () => {
    const root = temp();
    generate(repo, root, preset.all(), discard);
    for (const p of preset.all()) {
      const rel = frameAssetPath(p);
      const fresh = fs.readFileSync(path.join(root, ...rel.split('/')));
      const committed = fs.readFileSync(path.join(repo, ...rel.split('/')));
      expect(fresh.equals(committed), `${rel} 与签入产物不一致，需重跑生成器`).toBe(true);
    }
  });

  it('selects targets', () => {
    expect(selectTargets('')).toHaveLength(preset.all().length);
    expect(selectTargets('vertical-9x16').map((p) => p.id)).toEqual(['vertical-9x16']);
    expect(() => selectTargets('square-1x1')).toThrow();
  });

  it('fills canvas placeholders per orientation', () => {
    const v = frameOf(byID('vertical-3x4'));
    const l = frameOf(byID('landscape-16x9'));
    for (const want of ['max_width_px: 812', '竖屏', '抖音右侧互动栏']) expect(v).toContain(want);
    for (const want of ['max_width_px: 1440', '横屏', '播放器底部控制栏', '## 横屏构图要点']) expect(l).toContain(want);
    for (const leaked of ['{{', '抖音']) expect(l).not.toContain(leaked);
  });

  it('rejects unknown placeholders and applies offsets', () => {
    expect(() => substituteCanvas(byID('vertical-3x4'), 'x {{NO_SUCH_TOKEN}} y')).toThrow('未知占位符');
    expect(substituteCanvas(byID('vertical-3x4'), '{{CONTENT_LEFT_PX+8}}/{{CONTENT_WIDTH_PX-16}}')).toBe('96/888');
  });
});
