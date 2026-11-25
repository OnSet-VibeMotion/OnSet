import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AnchorsFileData,
  AnchorsSchemaVersion,
  hasAnchors,
  loadAndResolveAnchors,
  parseAnchorsData,
  resolveAnchors,
  resolveSfxPeakTiming,
} from './anchors';
import { encodeLocal, sliceGrid } from './cue';
import { type Grid, newGrid } from './grid';
import { layout, type Plan } from './plan';
import { AnchorsFile, ConfigFile, DefaultConfig, Store } from './store';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-anchors-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

/** 120 BPM、4/4、弱起 0.5 秒、共 3 小节（总时长 6.5s，30fps 共 195 帧）。 */
function sampleGrid(): Grid {
  const beats: number[] = [];
  for (let i = 0; i < 13; i++) beats.push(i * 0.5);
  return newGrid({
    schema: 1,
    audio_sha256: 'abc',
    duration_seconds: 6.5,
    source: 'test',
    reviewed: true,
    beats,
    downbeats: [0.5, 2.5, 4.5],
  });
}

function samplePlan(): Plan {
  return {
    schema: 1,
    scenes: [
      { id: 'scene-001', bars: 1 }, // [0, 75) -> 0.0s .. 2.5s
      { id: 'scene-002', bars: 2 }, // [75, 195) -> 2.5s .. 6.5s
    ],
  };
}

describe('beat anchors', () => {
  it('resolves beat and at anchors into exact local frames and SFX peak timings', () => {
    const grid = sampleGrid();
    const segments = layout(grid, samplePlan(), 30);
    const input: AnchorsFileData = {
      schema: AnchorsSchemaVersion,
      anchors: [
        {
          id: 'intro_hit',
          type: 'action',
          at: 0.2, // frame 6 in scene-001 (start 0) -> local 6
          sfx: [{ cue_id: 'sfx_intro', peak_seconds: 0.35 }], // raw = 6 - 11 = -5 -> clamp 0, sourceStart 5
        },
        {
          id: 'cut_bar2',
          type: 'cut',
          beat: 5, // 2.5s -> frame 75 in scene-002 (start 75) -> local 0
          scene: 'scene-002',
          visual: { metric: 'change', roi: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } },
          sfx: [{ cue_id: 'sfx_cut', peak_seconds: 0.35 }], // raw = 75 - 11 = 64
        },
        {
          id: 'climax_flash',
          type: 'action',
          beat: 9, // 4.5s -> frame 135 in scene-002 (start 75) -> local 60
          visual: { metric: 'brightness', roi: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
        },
      ],
    };

    const table = resolveAnchors(input, { grid, segments, fps: 30 });
    expect(table.anchors).toHaveLength(3);
    for (const anchor of table.anchors) {
      expect(anchor.local_frame).toBe(anchor.global_frame - anchor.shot_start_frame);
    }

    expect(table.by_id.intro_hit).toMatchObject({
      source: 'at',
      music_seconds: 0.2,
      global_frame: 6,
      scene: 'scene-001',
      shot_start_frame: 0,
      local_frame: 6,
    });
    expect(table.by_id.cut_bar2).toMatchObject({
      source: 'beat',
      beat: 5,
      music_seconds: 2.5,
      global_frame: 75,
      scene: 'scene-002',
      shot_start_frame: 75,
      local_frame: 0,
    });
    expect(table.by_id.climax_flash).toMatchObject({
      global_frame: 135,
      scene: 'scene-002',
      shot_start_frame: 75,
      local_frame: 60,
    });

    expect(table.by_scene['scene-001']).toEqual({ intro_hit: 6 });
    expect(table.by_scene['scene-002']).toEqual({ climax_flash: 60, cut_bar2: 0 });

    // 验证音效反推时间点
    expect(table.sfx_by_cue_id.sfx_cut).toMatchObject({
      anchor_id: 'cut_bar2',
      anchor_frame: 75,
      peak_frames: 11,
      raw_start_frame: 64,
      start_frame: 64,
      source_start_frame: 0,
      trimmed_frames: 0,
    });
    expect(table.sfx_by_cue_id.sfx_intro).toMatchObject({
      anchor_id: 'intro_hit',
      anchor_frame: 6,
      peak_frames: 11,
      raw_start_frame: -5,
      start_frame: 0,
      source_start_frame: 5,
      trimmed_frames: 5,
    });

    // 验证切片进 beat-cues.json 时字节稳定且带局部 anchors
    const local2 = sliceGrid(grid, segments[1], 30, table.by_scene['scene-002']);
    expect(local2.anchors).toEqual({ climax_flash: 60, cut_bar2: 0 });
    const encoded = JSON.parse(encodeLocal(local2).body.toString('utf8')) as { anchors: Record<string, number> };
    expect(encoded.anchors).toEqual({ climax_flash: 60, cut_bar2: 0 });
  });

  it('applies global output_offset_seconds calibration compensation', () => {
    const grid = sampleGrid();
    const segments = layout(grid, samplePlan(), 30);
    const table = resolveAnchors(
      {
        schema: 1,
        output_offset_seconds: 0.1, // +3 帧
        anchors: [{ id: 'hit_1', type: 'action', beat: 2 }], // 1.0s + 0.1s = 1.1s -> frame 33
      },
      { grid, segments, fps: 30 },
    );
    expect(table.by_id.hit_1.music_seconds).toBe(1.0);
    expect(table.by_id.hit_1.global_frame).toBe(33);
    expect(table.by_id.hit_1.local_frame).toBe(33);
  });

  it('rejects out-of-bounds, unknown scenes, and duplicate bindings strictly', () => {
    const grid = sampleGrid();
    const segments = layout(grid, samplePlan(), 30);
    const run = (data: AnchorsFileData) => resolveAnchors(data, { grid, segments, fps: 30 });

    // beat 与 at 二选一
    expect(() => run({ schema: 1, anchors: [{ id: 'a', type: 'action', beat: 1, at: 0.5 }] })).toThrow(
      /只能指定 beat 或 at/,
    );
    expect(() => run({ schema: 1, anchors: [{ id: 'a', type: 'action' }] })).toThrow(/只能指定 beat 或 at/);

    // beat 越界
    expect(() => run({ schema: 1, anchors: [{ id: 'a', type: 'action', beat: 99 }] })).toThrow(/越界/);

    // at 越界
    expect(() => run({ schema: 1, anchors: [{ id: 'a', type: 'action', at: 6.5 }] })).toThrow(/越界/);

    // 偏移后越界（不静默截断）
    expect(() =>
      run({ schema: 1, output_offset_seconds: -0.5, anchors: [{ id: 'a', type: 'action', at: 0.1 }] }),
    ).toThrow(/越界/);

    // 未知镜头引用
    expect(() => run({ schema: 1, anchors: [{ id: 'a', type: 'action', beat: 1, scene: 'scene-999' }] })).toThrow(
      /未知镜头/,
    );

    // 镜头区间不匹配
    expect(() => run({ schema: 1, anchors: [{ id: 'a', type: 'action', beat: 1, scene: 'scene-002' }] })).toThrow(
      /越出镜头/,
    );

    // 重复锚点 id
    expect(() =>
      run({
        schema: 1,
        anchors: [
          { id: 'dup', type: 'action', beat: 1 },
          { id: 'dup', type: 'action', beat: 2 },
        ],
      }),
    ).toThrow(/重复绑定/);

    // 重复 sfx cue_id
    expect(() =>
      run({
        schema: 1,
        anchors: [
          { id: 'a1', type: 'action', beat: 1, sfx: [{ cue_id: 'hit', peak_seconds: 0.1 }] },
          { id: 'a2', type: 'action', beat: 2, sfx: [{ cue_id: 'hit', peak_seconds: 0.2 }] },
        ],
      }),
    ).toThrow(/cue_id 重复绑定/);

    // 重复 cut 绑定同一帧
    expect(() =>
      run({
        schema: 1,
        anchors: [
          { id: 'c1', type: 'cut', beat: 5 },
          { id: 'c2', type: 'cut', at: 2.5 },
        ],
      }),
    ).toThrow(/重复绑定/);

    // 非法 ROI 归一化越界
    expect(() =>
      parseAnchorsData({
        schema: 1,
        anchors: [
          {
            id: 'a',
            type: 'action',
            beat: 1,
            visual: { metric: 'brightness', roi: { x: 0.8, y: 0.2, w: 0.5, h: 0.2 } },
          },
        ],
      }),
    ).toThrow(/roi/);
  });

  it('loads production/beat/anchors.json from project root', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, ConfigFile), DefaultConfig);
    expect(hasAnchors(root)).toBe(false);
    fs.mkdirSync(path.join(root, Store), { recursive: true });
    fs.writeFileSync(
      path.join(root, AnchorsFile),
      JSON.stringify({ schema: 1, anchors: [{ id: 'drop', type: 'action', beat: 5 }] }),
    );
    expect(hasAnchors(root)).toBe(true);
    const grid = sampleGrid();
    const segments = layout(grid, samplePlan(), 30);
    const resolved = loadAndResolveAnchors(root, grid, segments, 30);
    expect(resolved.by_scene['scene-002']).toEqual({ drop: 0 });
  });

  it('computes SFX peak timing with exact rounding and negative clamping', () => {
    const normal = resolveSfxPeakTiming(30, 0.35, 30);
    expect(normal).toMatchObject({
      peak_frames: 11,
      raw_start_frame: 19,
      start_frame: 19,
      source_start_frame: 0,
      trim_start_seconds: 0,
      trimmed_frames: 0,
    });
    const clamped = resolveSfxPeakTiming(4, 0.35, 30);
    expect(clamped).toMatchObject({
      peak_frames: 11,
      raw_start_frame: -7,
      start_frame: 0,
      source_start_frame: 7,
      trimmed_frames: 7,
    });
    expect(clamped.trim_start_seconds).toBeCloseTo(7 / 30, 5);
  });
});
