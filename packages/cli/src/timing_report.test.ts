import { expect, it } from 'vitest';
import { calculateTimingReport } from './timing_report';

const cues = [
  { index: 1, start_seconds: 0.2, end_seconds: 0.5, text: '第一句' },
  { index: 2, start_seconds: 0.7, end_seconds: 1.2, text: '第二句' },
];

it('derives the end frame and sample count from voice and approved tail, including caption gaps', () => {
  expect(calculateTimingReport(cues, [{ ...cues[0], end_seconds: 1.101 }], 30, 6, 9)).toMatchObject({
    total_frames: 40,
    closing_hold_frames: 6,
    voice_end_frame_exclusive: 34,
    sample_rate: 48000,
    target_samples_per_channel: 64000,
    gaps: [
      { start_seconds: 0, end_seconds: 0.2 },
      { start_seconds: 0.5, end_seconds: 0.7 },
      { start_seconds: 1.2, end_seconds: 40 / 30 },
    ],
  });
});

it('rejects a tail beyond its approved maximum or subtitles past the program end', () => {
  expect(() => calculateTimingReport(cues, cues, 30, 7, 6)).toThrow(/最大尾留白/);
  expect(() => calculateTimingReport(cues, [cues[0]], 30, 0)).toThrow(/超出节目终点/);
});
