import { describe, expect, it } from 'vitest';
import { all, byCanvas, byID, canvasLabel, defaultPreset, ids, resolveBox, resolveSafeArea, type ResolvedBox } from './index';

function assertSafeArea(id: string, want: Record<string, ResolvedBox>) {
  const p = byID(id);
  expect(p, `找不到预设 ${id}`).toBeDefined();
  const boxes = resolveSafeArea(p!);
  expect(boxes).toHaveLength(Object.keys(want).length);
  for (const item of boxes) expect(item.box, item.name).toEqual(want[item.name]);
}

describe('preset', () => {
  // 3:4 的推导结果钉死：安全区的数字进 frame.md、镜头的 onset-scene.js 与渲染指纹。
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
