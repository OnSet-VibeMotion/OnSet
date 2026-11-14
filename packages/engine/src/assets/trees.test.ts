// 资产树与画幅表必须一致。
import { describe, expect, it } from 'vitest';
import * as preset from '../preset';
import { canvas, files } from './index';

describe('canvas trees', () => {
  // 每个画幅都有自己的源树，里面只有 frame.md；风格树已经不存在。
  it('resolve for every canvas', () => {
    for (const p of preset.all()) expect(canvas(p.id).walkFiles(), p.id).toEqual(['frame.md']);
    expect(files().exists('styles')).toBe(false);
    expect(files().exists('fontpool')).toBe(false);
  });

  it('list exactly the canvases of the preset table', () => {
    const dirs = files().readDir('presets').filter((e) => e.isDir).map((e) => e.name).sort();
    expect(dirs).toEqual(preset.ids().sort());
  });
});
