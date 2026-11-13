// 资产树与预设表、字体表必须一致。
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import * as presetMod from '../preset';
import { files, fontFiles, FontsDir, style, styleFonts } from './index';

describe('style trees', () => {
  // 画幅不再有自己的源树：制作提示词按流程组合，assets/presets 已经不存在。
  it('resolve for every combination', () => {
    expect(files().exists('presets')).toBe(false);
    for (const canvas of presetMod.all()) {
      for (const s of presetMod.allStyles()) expect(style(s.id, canvas.id).exists(presetMod.guideDoc(s)), `${s.id}/${canvas.id}`).toBe(true);
    }
  });

  it('reject unknown ids', () => {
    expect(() => style('no-such-style', presetMod.defaultPreset().id)).toThrow();
    expect(() => style(presetMod.defaultStyle().id, 'no-such-canvas')).toThrow();
  });

  // 自定义风格的草稿骨架要随每个画幅下发：am init --style custom 直接取这棵树。
  it('ship the custom draft for every canvas', () => {
    for (const canvas of presetMod.all()) expect(style(presetMod.CustomStyle.id, canvas.id).exists(presetMod.guideDoc(presetMod.CustomStyle)), canvas.id).toBe(true);
  });
});

describe('font pool', () => {
  // 风格声明的字体必须真的在字体池里，且随字体带上许可证：OFL 要求分发时附带许可文本。
  it('has every style font with its license', () => {
    for (const s of presetMod.allStyles()) {
      const out = styleFonts(s);
      for (const font of s.fonts) for (const name of [font.file, font.license]) expect(out.has(FontsDir + name), `${s.id} 缺少 ${name}`).toBe(true);
    }
  });

  // 字体池与 AllFonts 必须双向一致：池里有而表里没有只是白占体积；表里有而池里没有，am style add-font 会在用户项目里才失败。
  it('matches AllFonts in both directions', () => {
    const listed = new Set<string>();
    const out = fontFiles(presetMod.allFontsCopy());
    for (const font of presetMod.allFontsCopy()) {
      listed.add(font.file).add(font.license);
      for (const name of [font.file, font.license]) expect(out.has(FontsDir + name), `${name} 不在字体池里`).toBe(true);
    }
    for (const entry of files().readDir('fontpool')) {
      if (entry.name === 'README.md') continue;
      expect(listed.has(entry.name), `字体池文件 ${entry.name} 不在 AllFonts 里`).toBe(true);
    }
  });

  it('rejects an unknown font and names it', () => {
    expect(() => fontFiles([{ file: 'no-such.woff2', license: 'LICENSE-x.txt' }])).toThrow('no-such.woff2');
  });

  // frame.md 的 font_files 与风格表必须一致：声明了却没带进项目，渲染时静默回退；带进项目却没声明，只是白占体积。族名也必须对上。
  it('agrees with frame.md font_files', () => {
    const available = new Map(presetMod.SharedFonts.map((f) => [FontsDir + f.file, f]));
    for (const s of presetMod.allStyles()) {
      const body = files().readText(`styles/${s.id}/${presetMod.defaultPreset().id}/frame.md`);
      const tokens = parse(body.split('---')[1]) as { typography?: { font_files?: { family: string; weight: number; file: string }[] } };
      const declared = new Set<string>();
      for (const entry of tokens.typography?.font_files ?? []) {
        declared.add(entry.file);
        const font = available.get(entry.file) ?? s.fonts.find((own) => FontsDir + own.file === entry.file);
        expect(font, `风格 ${s.id} 声明了项目里不会有的字体 ${entry.file}`).toBeDefined();
        expect(entry.family.toLowerCase(), `${s.id} 的 ${entry.file} 族名`).toBe(font!.family.toLowerCase());
      }
      for (const own of s.fonts) expect(declared.has(FontsDir + own.file), `${s.id} 的 ${own.file} 没写进 font_files`).toBe(true);
    }
  });
});
