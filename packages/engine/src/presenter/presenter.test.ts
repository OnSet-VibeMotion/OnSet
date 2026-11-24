import { describe, expect, it } from 'vitest';
import {
  buildOutputTimeline,
  formatOutputCues,
  mapSourceTimeToOutput,
  patchManagedCaptionBlock,
  remapCuesToOutput,
} from './index';

describe('presenter dual-clock timeline', () => {
  it('maps source times across cuts and speed changes and remaps captions cleanly', () => {
    const { segments, total_duration } = buildOutputTimeline([
      { id: 'seg-1', source_start: 12, source_end: 18, playback_rate: 1, role: 'presenter' },
      { id: 'seg-2', source_start: 30, source_end: 40, playback_rate: 2, role: 'screen' },
    ]);
    expect(total_duration).toBe(11);
    expect(mapSourceTimeToOutput(segments, 15)).toBe(3);
    expect(mapSourceTimeToOutput(segments, 22)).toBeNull(); // 被剪掉的废话段
    expect(mapSourceTimeToOutput(segments, 34)).toBe(8); // 6 + (34-30)/2

    const remapped = remapCuesToOutput(segments, [
      { id: 'c1', start: 10, end: 14, text: '开场问好' },
      { id: 'c2', start: 20, end: 25, text: '这段要剪掉' },
      { id: 'c3', start: 32, end: 38, text: '屏幕演示重点' },
    ]);
    expect(remapped).toHaveLength(2);
    expect(remapped[0]).toMatchObject({ segment_id: 'seg-1', start: 0, end: 2, text: '开场问好' });
    expect(remapped[1]).toMatchObject({ segment_id: 'seg-2', start: 7, end: 10, text: '屏幕演示重点' });

    const srt = formatOutputCues(remapped, 'srt');
    expect(srt).toContain('00:00:00,000 --> 00:00:02,000');
    expect(srt).toContain('屏幕演示重点');
    expect(srt).not.toContain('这段要剪掉');

    const vtt = formatOutputCues(remapped, 'vtt');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
  });

  it('patches managed caption block in-place without damaging surrounding HTML', () => {
    const base = '<html><body><div id="hero">Hello</div></body></html>';
    const cues = [{ id: 'c1', segment_id: 's1', start: 0, end: 2, text: '第一句 <字幕>' }];
    const once = patchManagedCaptionBlock(base, 'main', cues, {
      preset: 'minimal',
      position: 'bottom',
      scale: 1,
      visible: true,
    });
    expect(once).toContain('<!-- onset-caption:main:start -->');
    expect(once).toContain('第一句 &lt;字幕&gt;');
    expect(once).toContain('<div id="hero">Hello</div>');

    const twice = patchManagedCaptionBlock(once, 'main', cues, {
      preset: 'box',
      position: 'top',
      scale: 1.2,
      visible: false,
    });
    expect(twice.split('onset-caption:main:start').length).toBe(2);
    expect(twice).toContain('data-caption-preset="box"');
    expect(twice).toContain('data-hidden="true"');
  });
});
