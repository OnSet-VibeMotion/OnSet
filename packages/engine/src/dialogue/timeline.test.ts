// 移植自 internal/dialogue/timeline_test.go。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SchemaVersion, type Plan } from './plan';
import { rebuild, writeResultJSON, writeSRT } from './timeline';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-dialogue-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function samplePlan(): Plan {
  return {
    schema: SchemaVersion,
    segments: [
      {
        index: 1,
        speaker: 'heiwa',
        voiceId: 'v-1',
        audio: 'seg-001-heiwa.wav',
        gapAfterMs: 100,
        lines: [
          { text: '第一句', startSeconds: 0.0, endSeconds: 2.14 },
          { text: '第二句', startSeconds: 2.14, endSeconds: 4.32 },
        ],
      },
      { index: 2, speaker: 'zhaocai', voiceId: 'v-2', audio: 'seg-002-zhaocai.wav', gapAfterMs: 0, lines: [{ text: '等一下', startSeconds: 0.0, endSeconds: 1.08 }] },
    ],
  };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9;

describe('rebuild', () => {
  it('offsets by measured duration and gap', () => {
    const result = rebuild(samplePlan(), [4.32, 1.08]);
    expect(near(result.segments![1].startSeconds, 4.42)).toBe(true);
    expect(result.lines!.length).toBe(3);
    const third = result.lines![2];
    expect(third.srtIndex).toBe(3);
    expect(third.speaker).toBe('zhaocai');
    expect(near(third.startSeconds, 4.42) && near(third.endSeconds, 5.5)).toBe(true);
  });

  // 实测时长与声明的段内时间戳不一致时，必须按实测拉伸，否则误差会一段段累积到片尾。
  it('scales lines to measured duration', () => {
    const result = rebuild(samplePlan(), [8.64, 1.08]);
    expect(near(result.lines![0].endSeconds, 4.28)).toBe(true);
    expect(near(result.segments![1].startSeconds, 8.74)).toBe(true);
  });

  const cases: Array<{ name: string; mutate: (p: Plan) => void; measured: number[]; want: string }> = [
    { name: '实测时长数量对不上', mutate: () => {}, measured: [4.32], want: '数量' },
    { name: '段内时间倒挂', mutate: (p) => (p.segments![0].lines![1].endSeconds = 1.0), measured: [4.32, 1.08], want: '倒挂' },
    { name: '段内有空洞', mutate: (p) => (p.segments![0].lines![1].startSeconds = 3.0), measured: [4.32, 1.08], want: '不连续' },
    { name: '说话人为空', mutate: (p) => (p.segments![1].speaker = ''), measured: [4.32, 1.08], want: '说话人' },
    { name: '间隔为负', mutate: (p) => (p.segments![0].gapAfterMs = -5), measured: [4.32, 1.08], want: '间隔' },
    { name: '实测时长含 NaN', mutate: () => {}, measured: [NaN, 1.08], want: '无效' },
    { name: '实测时长含 +Inf', mutate: () => {}, measured: [Infinity, 1.08], want: '无效' },
    { name: '行的结束时间为 NaN', mutate: (p) => (p.segments![0].lines![1].endSeconds = NaN), measured: [4.32, 1.08], want: '无效' },
  ];
  for (const tc of cases) {
    it(`rejects: ${tc.name}`, () => {
      const plan = samplePlan();
      tc.mutate(plan);
      expect(() => rebuild(plan, tc.measured)).toThrow(tc.want);
    });
  }
});

describe('writeSRT', () => {
  it('format', () => {
    const result = rebuild(samplePlan(), [4.32, 1.08]);
    const file = path.join(tempDir(), 'transcription-production.srt');
    writeSRT(file, result.lines);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      '1\n00:00:00,000 --> 00:00:02,140\n第一句\n\n' + '2\n00:00:02,140 --> 00:00:04,320\n第二句\n\n' + '3\n00:00:04,420 --> 00:00:05,500\n等一下\n',
    );
  });

  // SRT 里不得出现说话人：会进成片字幕。
  it('has no speaker', () => {
    const result = rebuild(samplePlan(), [4.32, 1.08]);
    const file = path.join(tempDir(), 'a.srt');
    writeSRT(file, result.lines);
    const body = fs.readFileSync(file, 'utf8');
    for (const speaker of ['heiwa', 'zhaocai']) expect(body.includes(speaker), speaker).toBe(false);
  });

  it('empty lines', () => {
    expect(() => writeSRT(path.join(tempDir(), 'empty.srt'), [])).toThrow('没有任何字幕行');
  });
});

describe('result JSON', () => {
  it('omits text', () => {
    const result = rebuild(samplePlan(), [4.32, 1.08]);
    const file = path.join(tempDir(), 'dialogue.json');
    writeResultJSON(result, file);
    const body = fs.readFileSync(file, 'utf8');
    expect(body.includes('第一句')).toBe(false);
    expect(body).toContain('"speaker": "zhaocai"');
  });
});
