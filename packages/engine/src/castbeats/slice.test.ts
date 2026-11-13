// 移植自 internal/castbeats/slice_test.go。
import { describe, expect, it } from 'vitest';
import type { Line } from '../dialogue';
import type { Beat } from '../plugins/cast/block';
import { slice } from './slice';

/** 构造 dialogue.Line 的简写。 */
function line(index: number, speaker: string, start: number, end: number): Line {
  return { srtIndex: index, speaker, startSeconds: start, endSeconds: end, text: '' };
}

/** 逐拍比较，浮点用 1e-9 容差。 */
function beatsEqual(got: Beat[] | null, want: Beat[]): boolean {
  const list = got ?? [];
  if (list.length !== want.length) return false;
  return list.every(
    (b, i) => b.speaker === want[i].speaker && Math.abs(b.start - want[i].start) <= 1e-9 && Math.abs(b.end - want[i].end) <= 1e-9,
  );
}

describe('slice', () => {
  it('single scene, single line', () => {
    const { beats, uncovered } = slice([line(1, 'heiwa', 0, 1.5)], [0], [2]);
    expect(uncovered).toEqual([]);
    expect(beatsEqual(beats[0], [{ speaker: 'heiwa', start: 0, end: 1.5 }])).toBe(true);
  });

  // 钉住"减去镜头起点"这件事本身：第二个镜头的台词落在全局 [2.5, 4.0]，写进 scene.json 的必须是本地 [0, 1.5]。
  it('subtracts the scene offset', () => {
    const { beats } = slice([line(1, 'heiwa', 2.5, 4.0)], [0, 2.5], [2.5, 2]);
    expect(beats[0] ?? []).toHaveLength(0);
    expect(beatsEqual(beats[1], [{ speaker: 'heiwa', start: 0, end: 1.5 }])).toBe(true);
  });

  // 一行台词横跨一个切点：必须拆成两拍，前一拍的 end 恰是前镜头时长、后一拍的 start 恰是 0。
  it('splits a line spanning two scenes', () => {
    const { beats, uncovered } = slice([line(1, 'heiwa', 1.0, 4.0)], [0, 3], [3, 3]);
    expect(uncovered).toEqual([]);
    expect(beatsEqual(beats[0], [{ speaker: 'heiwa', start: 1.0, end: 3.0 }])).toBe(true);
    expect(beatsEqual(beats[1], [{ speaker: 'heiwa', start: 0, end: 1.0 }])).toBe(true);
  });

  // 中间那个镜头被整段盖满：本地 [0, 时长]。
  it('splits a line spanning three scenes', () => {
    const { beats, uncovered } = slice([line(1, 'zhaocai', 0.5, 5.5)], [0, 2, 4], [2, 2, 2]);
    expect(uncovered).toEqual([]);
    expect(beatsEqual(beats[0], [{ speaker: 'zhaocai', start: 0.5, end: 2 }])).toBe(true);
    expect(beatsEqual(beats[1], [{ speaker: 'zhaocai', start: 0, end: 2 }])).toBe(true);
    expect(beatsEqual(beats[2], [{ speaker: 'zhaocai', start: 0, end: 1.5 }])).toBe(true);
  });

  // 中间镜头整段没人说话：这一镜的节拍是空的，不是漏算。
  it('leaves a silent scene empty', () => {
    const { beats, uncovered } = slice([line(1, 'heiwa', 0, 1), line(2, 'heiwa', 4, 5)], [0, 2, 4], [2, 2, 2]);
    expect(uncovered).toEqual([]);
    expect(beats[1] ?? []).toHaveLength(0);
  });

  // 一行恰好止于切点：下一个镜头不能凭空多出一拍长度为 0 的节拍。
  it('does not create a zero beat at a boundary touch', () => {
    const { beats } = slice([line(1, 'heiwa', 0, 2)], [0, 2], [2, 2]);
    expect(beats[1] ?? []).toHaveLength(0);
  });

  // 镜头时长之和短于对白：末行超出的部分没有任何镜头能装，必须点名报出来。
  it('reports a line beyond the last scene', () => {
    const { uncovered } = slice([line(1, 'heiwa', 0, 1), line(2, 'heiwa', 1, 3)], [0], [2]);
    expect(uncovered).toEqual([1]);
  });
});
