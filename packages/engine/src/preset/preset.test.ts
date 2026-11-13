import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { files } from '../assets';
import {
  all,
  allFontsCopy,
  allStyles,
  byCanvas,
  byID,
  canvasLabel,
  CustomStyle,
  defaultPreset,
  defaultStyle,
  DraftStyleID,
  guideDoc,
  ids,
  isCustomStyleID,
  resolveBox,
  resolveSafeArea,
  type ResolvedBox,
  styleByID,
  styleByIDOrError,
  styleIDs,
} from './index';

function assertSafeArea(id: string, want: Record<string, ResolvedBox>) {
  const p = byID(id);
  expect(p, `找不到预设 ${id}`).toBeDefined();
  const boxes = resolveSafeArea(p!);
  expect(boxes).toHaveLength(Object.keys(want).length);
  for (const item of boxes) expect(item.box, item.name).toEqual(want[item.name]);
}

describe('preset', () => {
  // 3:4 的推导结果必须逐值等于仓库现有 frame.md 的字面值：改坏了存量项目会撞 am init 的内容冲突检查。
  it('vertical 3:4 matches the shipped frame values', () => {
    assertSafeArea('vertical-3x4', {
      structural: { leftPx: 40, rightPx: 40, topPx: 96, bottomPx: 60 },
      main_content: { leftPx: 88, rightPx: 88, topPx: 120, bottomPx: 100 },
      critical_text: { leftPx: 88, rightPx: 180, topPx: 120, bottomPx: 260 },
      cover_title: { leftPx: 88, rightPx: 180, topPx: 260, bottomPx: 460 },
      subtitles: { leftPx: 88, rightPx: 180, topPx: 990, bottomPx: 260 },
    });
  });

  it('vertical 9:16 derives from the same anchors', () => {
    assertSafeArea('vertical-9x16', {
      structural: { leftPx: 40, rightPx: 40, topPx: 96, bottomPx: 60 },
      main_content: { leftPx: 88, rightPx: 88, topPx: 120, bottomPx: 100 },
      critical_text: { leftPx: 88, rightPx: 180, topPx: 120, bottomPx: 260 },
      cover_title: { leftPx: 88, rightPx: 180, topPx: 260, bottomPx: 940 },
      subtitles: { leftPx: 88, rightPx: 180, topPx: 1470, bottomPx: 260 },
    });
  });

  it('keeps the safe-area order stable', () => {
    expect(resolveSafeArea(byID('vertical-3x4')!).map((b) => b.name)).toEqual(['structural', 'main_content', 'critical_text', 'cover_title', 'subtitles']);
  });

  it('rejects overflow', () => {
    expect(() => resolveBox({ name: 'subtitles', leftPx: 0, rightPx: 0, anchor: 'bottom', insetBottomPx: 260, heightPx: 190 }, 400)).toThrow();
  });

  it('rejects an unknown anchor', () => {
    expect(() => resolveBox({ name: 'x', leftPx: 0, rightPx: 0, anchor: 'middle' }, 1440)).toThrow('anchor 无效');
  });

  it('looks presets up by canvas', () => {
    expect(byCanvas(1080, 1920, 30, 'vertical')?.id).toBe('vertical-9x16');
    expect(byCanvas(1920, 1080, 30, 'horizontal')).toBeUndefined();
  });

  it('defaults to vertical 3:4', () => {
    expect(defaultPreset().id).toBe('vertical-3x4');
  });

  it('lists all builtins', () => {
    expect(ids()).toEqual(['vertical-3x4', 'vertical-9x16', 'landscape-16x9']);
  });

  it('returns copies from all()', () => {
    const first = all();
    first[0].id = '篡改';
    expect(defaultPreset().id).toBe('vertical-3x4');
  });

  it('labels canvases with a full-width multiplication sign', () => {
    expect(canvasLabel({ widthPx: 1080, heightPx: 1440 })).toBe('1080×1440');
  });

  // 横屏没有右侧互动栏，需要让开的是底部播放器控制栏：左右对称、底部最深。
  it('defines the landscape 16:9 safe area', () => {
    assertSafeArea('landscape-16x9', {
      structural: { leftPx: 48, rightPx: 48, topPx: 40, bottomPx: 40 },
      main_content: { leftPx: 120, rightPx: 120, topPx: 80, bottomPx: 96 },
      critical_text: { leftPx: 160, rightPx: 160, topPx: 96, bottomPx: 200 },
      cover_title: { leftPx: 160, rightPx: 160, topPx: 220, bottomPx: 340 },
      subtitles: { leftPx: 240, rightPx: 240, topPx: 840, bottomPx: 90 },
    });
    const p = byCanvas(1920, 1080, 30, 'landscape');
    expect(p?.id).toBe('landscape-16x9');
    expect(p?.platform.orientation).toBe('横屏');
    expect(p?.layoutNotes).not.toBe('');
  });
});

describe('style', () => {
  it('defaults to the first style and lookups agree', () => {
    const styles = allStyles();
    expect(defaultStyle().id).toBe(styles[0].id);
    const idList = styleIDs();
    expect(idList).toHaveLength(styles.length);
    expect(new Set(idList).size).toBe(idList.length);
    styles.forEach((s, i) => {
      expect(idList[i]).toBe(s.id);
      expect(styleByID(s.id)?.name).toBe(s.name);
      const doc = guideDoc(s);
      expect(doc.startsWith('docs/' + s.name) && doc.endsWith('-视频风格说明书.md')).toBe(true);
    });
  });

  it('returns copies from allStyles()', () => {
    const styles = allStyles();
    styles[0].id = 'mutated';
    expect(defaultStyle().id).not.toBe('mutated');
  });

  it('lists the choices for an unknown style', () => {
    expect(styleByIDOrError(defaultStyle().id).id).toBe(defaultStyle().id);
    expect(() => styleByIDOrError('no-such-style')).toThrow(defaultStyle().id);
  });

  // 自定义风格的草稿身份不能混进内置风格表。
  it('keeps the custom draft out of the builtin table', () => {
    expect(styleByID(CustomStyle.id)).toBeUndefined();
    expect(CustomStyle.id).toBe(DraftStyleID);
    for (const id of styleIDs()) expect(isCustomStyleID(id), id).toBe(false);
  });

  it('recognises custom style ids', () => {
    const cases: Record<string, boolean> = {
      [DraftStyleID]: true,
      'custom-warm-film': true,
      'custom-a1': true,
      'custom-': false,
      custom: false,
      'custom-Warm': false,
      'custom-warm--film': false,
      'custom-warm/../x': false,
      'pixel-arcade-v1': false,
      'x-custom-warm-film': false,
    };
    for (const [id, want] of Object.entries(cases)) expect(isCustomStyleID(id), id).toBe(want);
  });
});

describe('fonts', () => {
  // 每个内置风格用到的字体都必须在 AllFonts 里，否则 am style add-font 拿不到内置风格在用的字体。
  it('covers every style font', () => {
    const seen = new Set<string>();
    for (const f of allFontsCopy()) {
      expect(seen.has(f.file), `AllFonts 重复列出 ${f.file}`).toBe(false);
      seen.add(f.file);
    }
    for (const s of allStyles()) for (const f of s.fonts) expect(seen.has(f.file), `${s.id} 的 ${f.file}`).toBe(true);
  });

  it('returns copies', () => {
    const fonts = allFontsCopy();
    fonts[0].file = 'mutated';
    expect(allFontsCopy()[0].file).not.toBe('mutated');
  });
});

describe('shipped specs', () => {
  // frame.md 与风格说明书曾要求「每个镜头至少两个视觉焦点」，制作提示词却要求「一拍一个焦点」，
  // 统一为「同一时刻一个主焦点，整镜最多两个依次登场」。
  it('agree on focus', () => {
    const stylesDir = path.join(files().dir, 'styles');
    const paths: string[] = [];
    for (const s of fs.readdirSync(stylesDir)) {
      for (const canvas of fs.readdirSync(path.join(stylesDir, s))) {
        const dir = path.join(stylesDir, s, canvas);
        if (fs.existsSync(path.join(dir, 'frame.md'))) paths.push(path.join(dir, 'frame.md'));
        const docs = path.join(dir, 'docs');
        if (fs.existsSync(docs)) for (const d of fs.readdirSync(docs)) if (d.endsWith('.md')) paths.push(path.join(docs, d));
      }
    }
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const content = fs.readFileSync(p, 'utf8');
      for (const conflicting of ['至少有两个视觉焦点', '至少两个焦点', '标出两个焦点']) expect(content.includes(conflicting), `${p}: ${conflicting}`).toBe(false);
    }
  });
});
