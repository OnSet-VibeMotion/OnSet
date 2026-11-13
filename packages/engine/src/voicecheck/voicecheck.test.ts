import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Cue } from '../srt';
import { check, medianOf, speech, writeReportJSON, type Segment } from './voicecheck';

/** 按 10ms 一窗构造电平：loud 区间内 -20 dBFS，其余 -90。 */
function levels(total: number, ...loud: Segment[]): number[] {
  const out = new Array<number>(Math.round(total / 0.01));
  for (let i = 0; i < out.length; i++) {
    const at = i * 0.01;
    out[i] = -90;
    for (const segment of loud) {
      if (at >= segment.start - 1e-9 && at < segment.end - 1e-9) out[i] = -20;
    }
  }
  return out;
}

const seg = (start: number, end: number): Segment => ({ start, end });
const cue = (index: number, start: number, end: number): Cue => ({ index, start_seconds: start, end_seconds: end, text: '句子' });

describe('voicecheck', () => {
  it('speech merges short gaps and drops clicks', () => {
    // 1.00–1.50 与 1.55–2.00 之间 50ms 间隙（字间），应合并；3.00–3.02 是咔哒声。
    const [segments, threshold] = speech(levels(4, seg(1, 1.5), seg(1.55, 2), seg(3, 3.02)));
    expect(segments).toEqual([seg(1, 2)]);
    // 阈值应为峰值 -20 减 35 dB。
    expect(threshold).toBe(-55);
  });

  it('aligned cues pass', () => {
    const [segments, threshold] = speech(levels(6, seg(0.5, 2), seg(2.5, 4.5)));
    const report = check([cue(1, 0.5, 2.05), cue(2, 2.45, 4.5)], segments, threshold);
    expect(report.ok).toBe(true);
    expect(report.hints ?? []).toHaveLength(0);
    expect(report.median_start_delta).toBeDefined();
    expect(Math.abs(report.median_start_delta!)).toBeLessThanOrEqual(0.05);
  });

  // 记忆里记下的真实故障——TTS 自带 SRT 整体早 0.4 秒。
  it('systematic early offset is caught', () => {
    const [segments, threshold] = speech(levels(8, seg(1, 2.5), seg(3, 5), seg(5.6, 7)));
    const report = check([cue(1, 0.6, 2.1), cue(2, 2.6, 4.6), cue(3, 5.2, 6.6)], segments, threshold);
    // 整体提前时每句末尾的 0.4 秒也失去覆盖：3 条「早」加 3 段「未覆盖」。
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(6);
    expect(report.problems[0]).toContain('早 0.400 秒');
    expect(report.median_start_delta).toBe(-0.4);
    expect((report.hints ?? []).join('\n')).toContain('整体比声音早约 0.400 秒');
  });

  // 一口气读完的长句被拆成两条字幕，第二条开始时声音早已响起——这是正常拆分，
  // 不是字幕晚了，也不计入偏移中位数。
  it('continuous speech split across cues is not late', () => {
    const [segments, threshold] = speech(levels(5, seg(1, 4)));
    const report = check([cue(1, 1, 2.5), cue(2, 2.5, 4)], segments, threshold);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.cues[1].owns_onset).toBe(false);
    expect(report.median_start_delta).toBe(0);
  });

  it('late start, silent cue and uncovered speech', () => {
    const [segments, threshold] = speech(levels(10, seg(1, 2), seg(3, 4), seg(6, 7)));
    const report = check(
      [
        cue(1, 1.5, 2), // 晚 0.5 秒开始，且 1.0–1.5 没字幕
        cue(2, 3, 4), // 正常
        cue(3, 8.5, 9.5), // 落在静音里
      ],
      segments,
      threshold,
    );
    const joined = report.problems.join('\n');
    for (const want of [
      '第 1 条字幕比声音晚 0.500 秒',
      '第 3 条字幕（8.500–9.500 秒）整段落在静音里',
      '1.000–1.500 秒有声音但没有字幕覆盖',
      '6.000–7.000 秒有声音但没有字幕覆盖',
    ]) {
      expect(joined).toContain(want);
    }
  });

  // 终稿字幕按可读单元延长停留是允许的。
  it('lingering end is only a hint', () => {
    const [segments, threshold] = speech(levels(5, seg(1, 2)));
    const report = check([cue(1, 1, 3)], segments, threshold);
    expect(report.ok).toBe(true);
    expect(report.hints).toHaveLength(1);
    expect(report.hints![0]).toContain('停留 1.000 秒');
  });

  // 数字静音文件每窗都是地板值，峰值也是地板值；阈值只相对峰值的话，整段静音会被当成发声。
  it('no speech at all', () => {
    const silent = new Array<number>(100).fill(-120);
    const [segments, threshold] = speech(silent);
    const report = check([cue(1, 0, 1)], segments, threshold);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toBe('音频里没有检测到任何发声');
  });

  it('median and writeJSON', () => {
    expect(medianOf([0.3, -0.1, 0.1, 0.2])).toBe(0.15);
    const [segments, threshold] = speech(levels(3, seg(1, 2)));
    const report = check([cue(1, 1, 2)], segments, threshold);
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-voicecheck-')), 'check.json');
    writeReportJSON(report, target);
    // 与 Go 的 json.MarshalIndent 输出逐字节一致（字段顺序、空 hints 省略、末尾换行）。
    expect(fs.readFileSync(target, 'utf8')).toBe(`{
  "schema_version": 1,
  "ok": true,
  "threshold_db": -55,
  "speech": [
    {
      "start": 1,
      "end": 2
    }
  ],
  "cues": [
    {
      "index": 1,
      "start": 1,
      "end": 2,
      "text": "句子",
      "speech_start": 1,
      "speech_end": 2,
      "start_delta": 0,
      "end_delta": 0,
      "owns_onset": true
    }
  ],
  "median_start_delta": 0,
  "problems": []
}
`);
  });

  // 审查报告的复现——第 2 条字幕提前 0.5 秒开始，开头擦到上一句的尾音；
  // 不能因为擦边就把上一句当成它的首段发声。
  it('early cue overlapping previous tail is caught', () => {
    const [segments, threshold] = speech(levels(5, seg(0, 2), seg(2.4, 4)));
    const report = check([cue(1, 0, 1.5), cue(2, 1.9, 4)], segments, threshold);
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('第 2 条字幕比声音早 0.500 秒');
    // 第 2 条应拥有自己的发声起点并计入中位数。
    expect(report.cues[1].owns_onset).toBe(true);
  });

  it('zero-length cue is only a hint', () => {
    const [segments, threshold] = speech(levels(3, seg(1, 2)));
    const report = check([cue(1, 1, 2), cue(2, 2.5, 2.5)], segments, threshold);
    expect(report.ok).toBe(true);
    expect(report.hints).toHaveLength(1);
    expect(report.cues).toHaveLength(1);
  });
});
