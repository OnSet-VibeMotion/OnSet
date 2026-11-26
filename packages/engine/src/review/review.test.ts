import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envMap, lookPath } from '../envutil';
import {
  audioStream,
  type FrameStats,
  type Media,
  newToolchain,
  type ProgramLoudness,
  videoStream,
} from '../mediaprobe';
import { type LoudnessTarget, type Prober, run, type Segment, writeReportJSON } from './review';

class FakeProber implements Prober {
  frames = 0;
  blankAt = new Map<number, boolean>();
  sheets: number[][] = [];
  columns: number[] = [];
  countErr: Error | null = null;
  loudness: ProgramLoudness = { integrated_lufs: 0, true_peak_dbtp: 0, range_lu: 0 };
  measured = 0;
  /** difference 是 frameDifference 的返回值，按后一帧的时间点查。 */
  difference = new Map<number, number>();
  compared = 0;

  constructor(
    readonly media: Media,
    fields: Partial<Pick<FakeProber, 'frames' | 'blankAt' | 'countErr' | 'loudness' | 'difference'>> = {},
  ) {
    Object.assign(this, fields);
  }
  probe(): Media {
    return this.media;
  }
  countFrames(): number {
    if (this.countErr) throw this.countErr;
    return this.frames;
  }
  frameStats(_file: string, at: number): FrameStats {
    if (this.blankAt.get(at)) return { at_seconds: at, mean: 0, stddev: 0 };
    return { at_seconds: at, mean: 100, stddev: 40 };
  }
  frameDifference(_file: string, _a: number, b: number): number {
    this.compared++;
    return this.difference.get(b) ?? 0;
  }
  measureProgramLoudness(): ProgramLoudness {
    this.measured++;
    return this.loudness;
  }
  contactSheet(_file: string, points: number[], columns: number): void {
    this.sheets.push(points);
    this.columns.push(columns);
  }
}

function media(video: number, audio: number, withAudio: boolean): Media {
  return {
    path: '',
    duration_seconds: Math.max(video, audio),
    video: videoStream({ duration_seconds: video, fps_num: 30, fps_den: 1 }),
    audio: withAudio ? audioStream({ duration_seconds: audio }) : null,
  };
}

const segments = (): Segment[] => [
  { id: 's1', frames: 30 },
  { id: 's2', frames: 60 },
  { id: 's3', frames: 30 },
];

describe('review', () => {
  it('reuses the precise count from the preceding validation and still checks loudness and cuts', () => {
    const inspected = media(4, 4, true);
    inspected.path = 'final.mp4';
    inspected.video!.nb_frames = 120;
    const p = new FakeProber(inspected, { countErr: new Error('重复统计帧数') });
    const result = run(p, { video: 'final.mp4', fps: 30, segments: segments(), verifiedMedia: inspected });
    expect(result.counted_frames).toBe(120);
    expect(result.cuts).toHaveLength(2);
    expect(p.measured).toBe(1);
  });
  it('handoff seams are compared only where declared', () => {
    const segs: Segment[] = [
      { id: 's1', frames: 30 },
      { id: 's2', frames: 60, handoff: 'push_in', crossChapter: true },
      { id: 's3', frames: 30 },
    ];
    const p = new FakeProber(media(4, 4.02, true), { frames: 120, difference: new Map([[1, 3]]) });
    const report = run(p, { video: 'final.mp4', fps: 30, segments: segs, outDir: 'out' });
    expect(p.compared, '只有声明了交接的交界才比对').toBe(1);
    expect(report.ok && report.hints.length === 0, `${report.problems} ${report.hints}`).toBe(true);
    const c = report.cuts[0];
    expect([c.handoff, c.difference]).toEqual(['push_in', 3]);
    expect(report.cuts[1].difference, '硬切交界不应有差异值').toBeNull();
  });

  it('broken handoff fails and loose handoff hints', () => {
    const segs: Segment[] = [
      { id: 's1', frames: 30 },
      { id: 's2', frames: 60, handoff: 'flood', crossChapter: true },
      { id: 's3', frames: 30, handoff: 'carry' },
    ];
    const p = new FakeProber(media(4, 4.02, true), {
      frames: 120,
      difference: new Map([
        [1, 70],
        [3, 25],
      ]),
    });
    const report = run(p, { video: 'final.mp4', fps: 30, segments: segs, outDir: 'out' });
    expect(
      !report.ok && report.problems.length === 1 && report.problems[0].includes('s1 → s2 章节交界'),
      String(report.problems),
    ).toBe(true);
    expect(
      report.hints.some((h) => h.includes('s2 → s3 交界')),
      String(report.hints),
    ).toBe(true);
  });

  it('healthy film passes', () => {
    const report = run(new FakeProber(media(4, 4.02, true), { frames: 120 }), {
      video: 'final.mp4',
      fps: 30,
      segments: segments(),
      outDir: 'out',
    });
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.cuts.map((c) => c.frame)).toEqual([30, 90]);
    expect(report.sheets.length).toBe(1);
    expect(report.sheets[0].tiles.length).toBe(9);
    expect(report.sheets[0].columns).toBe(3);
    const tiles = report.sheets[0].tiles;
    // s2 占第 30..89 帧：首帧 30、中间 60、末帧 89。
    expect([tiles[3].frame, tiles[4].frame, tiles[5].frame, tiles[5].position]).toEqual([30, 60, 89, 'end']);
    // 两个交界各一张条带：切点前 6 帧一行、切点后 6 帧一行。
    const seam = report.seams[0];
    expect(report.seams.length).toBe(2);
    expect(seam.tiles.length).toBe(12);
    expect([seam.tiles[5].frame, seam.tiles[6].frame, seam.tiles[6].scene_id, seam.tiles[5].position]).toEqual([
      29,
      30,
      's2',
      'before',
    ]);
  });

  const machineCases: [string, FakeProber, string][] = [
    ['没有音轨', new FakeProber(media(4, 0, false), { frames: 120 }), '没有音轨'],
    ['音轨短了半秒', new FakeProber(media(4, 3.5, true), { frames: 120 }), '音画时长不一致'],
    ['拼接掉一帧', new FakeProber(media(4, 4, true), { frames: 119 }), '相差 -1 帧'],
  ];
  for (const [name, prober, want] of machineCases) {
    it(`machine-checkable problem: ${name}`, () => {
      const report = run(prober, { video: 'final.mp4', fps: 30, segments: segments(), outDir: 'out' });
      expect(report.ok).toBe(false);
      expect(report.problems.join('\n')).toContain(want);
    });
  }

  // 切黑是合法转场，机器分不清，只提示不判失败。
  it('blank cut is only a hint', () => {
    const p = new FakeProber(media(4, 4, true), { frames: 120, blankAt: new Map([[1, true]]) });
    const report = run(p, { video: 'final.mp4', fps: 30, segments: segments(), outDir: 'out' });
    expect(report.ok && report.hints.length === 1 && report.hints[0].includes('s1 → s2'), String(report.hints)).toBe(
      true,
    );
  });

  it('missing stream durations is a hint', () => {
    const report = run(new FakeProber(media(0, 0, true), { frames: 120 }), {
      video: 'final.mp4',
      fps: 30,
      segments: segments(),
      outDir: 'out',
    });
    expect(report.ok && report.hints.length > 0).toBe(true);
  });

  it('sheets are paginated', () => {
    const many: Segment[] = Array.from({ length: 7 }, () => ({ id: 's', frames: 30 }));
    const report = run(new FakeProber(media(7, 7, true), { frames: 210 }), {
      video: 'final.mp4',
      fps: 30,
      segments: many,
      outDir: 'out',
      tilesPerSheet: 18,
    });
    expect(report.sheets.map((s) => s.tiles.length)).toEqual([18, 3]);
    expect(path.basename(report.sheets[1].image)).toBe('sheet-02.png');
  });

  // 脱离镜头目录时只做与镜头无关的检查。
  it('without segments samples at a fixed interval', () => {
    // 容器时长 13 秒（音轨更长），画面实际只有 360 帧：取帧上限必须按实测帧数。
    const p = new FakeProber(media(13, 13, true), { frames: 360 });
    const report = run(p, { video: 'final.mp4', fps: 30, outDir: 'out', every: 5 });
    expect(report.sheets[0].tiles.map((t) => t.frame)).toEqual([0, 150, 300, 359]);
    expect(report.expected_frames).toBe(0);
    expect(report.cuts.length).toBe(0);
    expect(p.columns[0]).toBe(4);
  });

  it('rejects bad options and propagates errors', () => {
    expect(() => run(new FakeProber(media(1, 1, true)), { video: 'x', fps: 0 }), '帧率为 0 应报错').toThrow();
    expect(
      () => run(new FakeProber(media(1, 1, true)), { video: 'x', fps: 30, segments: [{ id: 's', frames: 0 }] }),
      '镜头帧数为 0 应报错',
    ).toThrow();
    const boom = new Error('boom');
    let caught: unknown;
    try {
      run(new FakeProber(media(4, 4, true), { countErr: boom }), { video: 'x', fps: 30, segments: segments() });
    } catch (err) {
      caught = err;
    }
    expect(caught, '统计帧数失败应原样抛出').toBe(boom);
    const report = run(new FakeProber({ path: '', duration_seconds: 0, video: null, audio: audioStream() }), {
      video: 'x',
      fps: 30,
    });
    expect(report.ok, '没有视频流应判不合格').toBe(false);
  });

  // 成片比镜头合计短时，越过末尾的交界与格子没有帧可取；应报帧数问题并给出报告，而不是抽帧报错中断。
  it('short film skips out-of-range cuts and tiles', () => {
    const report = run(new FakeProber(media(2, 2, true), { frames: 60 }), {
      video: 'final.mp4',
      fps: 30,
      segments: segments(),
      outDir: 'out',
    });
    expect(report.ok).toBe(false);
    expect(report.cuts.length).toBe(1);
    for (const tile of report.sheets[0].tiles) expect(tile.frame).toBeLessThan(60);
    expect(report.hints.join('\n')).toContain('已跳过');
  });

  it('silent film', () => {
    let report = run(new FakeProber(media(4, 0, false), { frames: 120 }), {
      video: 'x',
      fps: 30,
      segments: segments(),
      silent: true,
    });
    expect(report.ok, '静音成片没有音轨是正常的').toBe(true);
    report = run(new FakeProber(media(4, 4, true), { frames: 120 }), {
      video: 'x',
      fps: 30,
      segments: segments(),
      silent: true,
    });
    expect(report.ok, '按静音复查时出现音轨应判不合格').toBe(false);
  });

  // 响度只进 hints：偏离目标不改变 ok。
  it('loudness outside target is a hint only', () => {
    const p = new FakeProber(media(4, 4, true), {
      frames: 120,
      loudness: { integrated_lufs: -11.2, true_peak_dbtp: 0.4, range_lu: 3 },
    });
    const target: LoudnessTarget = { integratedLUFS: -16, tolerance: 1, truePeakMax: -1 };
    const report = run(p, { video: 'final.mp4', fps: 30, outDir: 'out', loudness: target });
    expect(report.ok).toBe(true);
    expect(report.loudness?.true_peak_dbtp).toBe(0.4);
    const joined = report.hints.join('\n');
    expect(joined).toContain('-11.2 LUFS');
    expect(joined).toContain('0.4 dBTP');
    expect(joined).toContain('384k');
  });

  it('loudness within target adds no hint', () => {
    const p = new FakeProber(media(4, 4, true), {
      frames: 120,
      loudness: { integrated_lufs: -16.6, true_peak_dbtp: -1.2, range_lu: 0 },
    });
    const report = run(p, {
      video: 'final.mp4',
      fps: 30,
      outDir: 'out',
      loudness: { integratedLUFS: -16, tolerance: 1, truePeakMax: -1 },
    });
    expect(report.hints).toEqual([]);
  });

  // 静音交付与没有目标时：前者不量，后者只记录不比对。
  it('loudness skipped when silent and uncompared without target', () => {
    const silent = new FakeProber(media(4, 0, false), { frames: 120 });
    let report = run(silent, { video: 'final.mp4', fps: 30, outDir: 'out', silent: true });
    expect(silent.measured).toBe(0);
    expect(report.loudness).toBeNull();
    const loud = new FakeProber(media(4, 4, true), {
      frames: 120,
      loudness: { integrated_lufs: -8, true_peak_dbtp: 1, range_lu: 0 },
    });
    report = run(loud, { video: 'final.mp4', fps: 30, outDir: 'out' });
    expect(report.loudness).not.toBeNull();
    expect(report.hints).toEqual([]);
  });

  // 容差之内但超过一个 AAC 帧的音画差只提示。
  it('sync beyond one AAC frame is a hint', () => {
    let report = run(new FakeProber(media(4, 4.05, true), { frames: 120 }), {
      video: 'final.mp4',
      fps: 30,
      segments: segments(),
      outDir: 'out',
    });
    expect(report.ok).toBe(true);
    expect(report.hints.join('\n')).toContain('超过一个 AAC 帧');
    report = run(new FakeProber(media(4, 4.02, true), { frames: 120 }), {
      video: 'final.mp4',
      fps: 30,
      segments: segments(),
      outDir: 'out',
    });
    expect(report.hints.join('\n'), '一个 AAC 帧以内不应提示').not.toContain('AAC');
  });

  it('reuses frame-qc.json only when video SHA-256 matches and warns when video changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-review-qc-'));
    try {
      const video = path.join(dir, 'candidate.mp4');
      fs.writeFileSync(video, 'video-bytes-v1');
      const sha1 = crypto.createHash('sha256').update('video-bytes-v1').digest('hex');
      const qcFile = path.join(dir, 'frame-qc.json');
      fs.writeFileSync(
        qcFile,
        JSON.stringify({
          schema_version: 1,
          path: video,
          video_sha256: sha1,
          verdict: 'pass',
          summary: { verdict: 'pass', issue_count: 0, fail_count: 0, warn_count: 0, info_count: 0, by_kind: {} },
          issues: [],
        }),
      );
      const r1 = run(new FakeProber(media(4, 4, true), { frames: 120 }), { video, fps: 30, outDir: dir });
      expect(r1.frame_qc?.verdict).toBe('pass');

      // 替换视频内容后，不得继续附加旧的 pass 摘要，而应提示重新扫描。
      fs.writeFileSync(video, 'video-bytes-v2');
      const r2 = run(new FakeProber(media(4, 4, true), { frames: 120 }), { video, fps: 30, outDir: dir });
      expect(r2.frame_qc).toBeUndefined();
      expect(r2.hints.join('\n')).toContain('SHA-256 不一致');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function which(name: string): string | null {
  try {
    return lookPath(name, process.env.PATH ?? '');
  } catch {
    return null;
  }
}

// 用真实 ffmpeg 拼出「两镜 + 音轨」的成片走一遍全流程；本机没有 ffmpeg / ffprobe 时跳过。
it.skipIf(which('ffmpeg') === null || which('ffprobe') === null)('runs against real ffmpeg', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-review-'));
  const film = path.join(dir, 'final.mp4');
  const made = spawnSync(
    which('ffmpeg')!,
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=30:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      film,
    ],
    { encoding: 'utf8' },
  );
  if (made.status !== 0) throw new Error(`生成成片失败：${made.stderr}`);
  const outDir = path.join(dir, 'review');
  const report = run(newToolchain(envMap()), {
    video: film,
    fps: 30,
    segments: [
      { id: 'a', frames: 30 },
      { id: 'b', frames: 30 },
    ],
    outDir,
    thumbWidth: 64,
  });
  expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  expect(report.counted_frames).toBe(60);
  writeReportJSON(report, path.join(outDir, 'review.json'));
  for (const name of ['sheet-01.png', 'review.json'])
    expect(fs.statSync(path.join(outDir, name)).size, name).toBeGreaterThan(0);
});
