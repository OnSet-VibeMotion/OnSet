// 音乐 × 画面动作 × 音效同源锚点表：从已确认节拍网格（beat 拍号）与/或音乐瞬态时刻（at 秒）
// 生成全片唯一命名的锚点表，同时切片为各镜头的局部帧号与混音的音效峰值反推入点。
import fs from 'node:fs';
import { goQuote, goRound } from '../gofmt';
import { compareBytes } from '../gojson';
import {
  type AnchorsFileData,
  AnchorsSchemaVersion,
  parseAnchorsData,
  type ResolvedAnchor,
  type ResolvedAnchorTable,
  type ResolvedSfxCue,
  type SfxPeakTiming,
} from './anchors_parse';
import { frameOf, type Grid, totalFrames } from './grid';
import type { Segment } from './plan';
import { AnchorsFile, localPath, pathError, wrapError } from './store';

export type {
  AnchorROI,
  AnchorSfxBinding,
  AnchorSpec,
  AnchorsFileData,
  AnchorType,
  AnchorVisual,
  AnchorVisualMetric,
  ResolvedAnchor,
  ResolvedAnchorTable,
  ResolvedSfxCue,
  SfxPeakTiming,
} from './anchors_parse';
export { AnchorsSchemaVersion, parseAnchorsData } from './anchors_parse';

/** 根据锚点帧号与音效峰值时刻反推节目入点；负入点自动截断至 0 并换算素材起播位置。 */
export function resolveSfxPeakTiming(
  anchorFrame: number,
  peakSeconds: number,
  fps: number,
  baseSourceStartFrame = 0,
): SfxPeakTiming {
  if (!Number.isSafeInteger(anchorFrame) || anchorFrame < 0) {
    throw new Error(`anchor_frame 必须是非负整数，收到 ${anchorFrame}`);
  }
  if (!Number.isFinite(peakSeconds) || peakSeconds < 0) {
    throw new Error(`peak_seconds 必须是有限且非负的数字，收到 ${peakSeconds}`);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`fps 必须为正数，收到 ${fps}`);
  }
  if (!Number.isSafeInteger(baseSourceStartFrame) || baseSourceStartFrame < 0) {
    throw new Error(`source_start_frame 必须是非负整数，收到 ${baseSourceStartFrame}`);
  }
  const peakFrames = goRound(peakSeconds * fps) + 0;
  const rawStartFrame = anchorFrame - peakFrames;
  const trimmedFrames = rawStartFrame < 0 ? -rawStartFrame : 0;
  const startFrame = rawStartFrame < 0 ? 0 : rawStartFrame;
  const sourceStartFrame = baseSourceStartFrame + trimmedFrames;
  const trimStartSeconds = goRound((sourceStartFrame / fps) * 1_000_000) / 1_000_000;
  return {
    anchor_frame: anchorFrame,
    peak_seconds: peakSeconds,
    peak_frames: peakFrames,
    raw_start_frame: rawStartFrame,
    start_frame: startFrame,
    source_start_frame: sourceStartFrame,
    trim_start_seconds: trimStartSeconds,
    trimmed_frames: trimmedFrames,
  };
}

/** 读取并校验指定路径的 anchors JSON 文件。 */
export function readAnchorsFile(file: string): AnchorsFileData {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw pathError('open', file, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw wrapError(`JSON 文件无效：${file}（${(err as Error).message}）`, err);
  }
  return parseAnchorsData(parsed);
}

/** 报告项目是否存在可选的 production/beat/anchors.json。 */
export function hasAnchors(root: string): boolean {
  return fs.existsSync(localPath(root, AnchorsFile));
}

/** 读取项目根下的 production/beat/anchors.json。 */
export function loadAnchors(root: string): AnchorsFileData {
  return readAnchorsFile(localPath(root, AnchorsFile));
}

export interface ResolveAnchorsOptions {
  /** 已确认节拍网格（有任意锚点使用 beat 拍号时必传）。 */
  grid?: Grid;
  /** 按小节布局好的镜头区间表（有镜头上下文时提供，用于严格校验镜头引用并切片局部帧号）。 */
  segments?: readonly Segment[];
  fps: number;
  /** 无 grid 时的总帧数；提供 grid 时默认由 totalFrames(grid.duration_seconds, fps) 推导。 */
  totalFrames?: number;
  /** 无 grid 时的音频总时长（秒）；省略时按 totalFrames / fps 计算。 */
  durationSeconds?: number;
}

/**
 * 统一解析器：把 anchors.json 结合已确认节拍网格与分镜布局解析成全片命名锚点表、
 * 各镜头局部帧号（local_frame = global_frame - shot_start_frame）与混音音效反推时间点。
 */
export function resolveAnchors(data: AnchorsFileData, opts: ResolveAnchorsOptions): ResolvedAnchorTable {
  const validated = parseAnchorsData(data);
  const { fps, grid, segments } = opts;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`帧率必须为正，收到 ${fps}`);
  const programFrames =
    opts.totalFrames ??
    (grid
      ? totalFrames(grid.duration_seconds, fps)
      : segments && segments.length > 0
        ? segments[segments.length - 1].startFrame + segments[segments.length - 1].frames
        : 0);
  if (!Number.isSafeInteger(programFrames) || programFrames <= 0) {
    throw new Error(`总帧数必须为正整数，收到 ${programFrames}`);
  }
  const durationSeconds = opts.durationSeconds ?? grid?.duration_seconds ?? programFrames / fps;
  const outputOffsetSeconds = validated.output_offset_seconds ?? 0;
  const beats = grid?.beats ?? [];
  const segmentById = new Map<string, Segment>();
  const bySceneDraft = new Map<string, Map<string, number>>();
  if (segments) {
    for (const seg of segments) {
      segmentById.set(seg.id, seg);
      bySceneDraft.set(seg.id, new Map());
    }
  }

  const seenIds = new Set<string>();
  const seenSfxCueIds = new Set<string>();
  const seenCutFrames = new Map<number, string>();
  const resolved: ResolvedAnchor[] = [];
  const byId = Object.create(null) as Record<string, ResolvedAnchor>;
  const sfxCues: ResolvedSfxCue[] = [];
  const sfxByCueId = Object.create(null) as Record<string, ResolvedSfxCue>;

  for (const spec of validated.anchors) {
    if (seenIds.has(spec.id)) throw new Error(`锚点 id 重复绑定：${goQuote(spec.id)}`);
    seenIds.add(spec.id);

    let musicSeconds: number;
    let source: 'beat' | 'at';
    if (spec.beat !== undefined) {
      if (!grid) throw new Error(`锚点 ${goQuote(spec.id)} 引用了拍号 beat=${spec.beat}，但未提供节拍网格`);
      if (spec.beat < 0 || spec.beat >= beats.length) {
        throw new Error(`锚点 ${goQuote(spec.id)} 的拍号 beat=${spec.beat} 越界（合法范围 0..${beats.length - 1}）`);
      }
      musicSeconds = beats[spec.beat];
      source = 'beat';
    } else {
      const at = spec.at!;
      if (at < 0 || at >= durationSeconds) {
        throw new Error(`锚点 ${goQuote(spec.id)} 的时刻 at=${at} 秒越界（音乐时长 ${durationSeconds} 秒）`);
      }
      musicSeconds = at;
      source = 'at';
    }

    const globalSeconds = musicSeconds + outputOffsetSeconds;
    const globalFrame = frameOf(globalSeconds, fps);
    if (globalFrame < 0 || globalFrame >= programFrames) {
      throw new Error(
        `锚点 ${goQuote(spec.id)} 换算到全局第 ${globalFrame} 帧越界（合法范围 0..${programFrames - 1}）`,
      );
    }

    if (spec.type === 'cut') {
      const existingCut = seenCutFrames.get(globalFrame);
      if (existingCut !== undefined) {
        throw new Error(`切点锚点 ${goQuote(spec.id)} 与 ${goQuote(existingCut)} 重复绑定到第 ${globalFrame} 帧`);
      }
      seenCutFrames.set(globalFrame, spec.id);
    }

    let sceneId = '';
    let shotStartFrame = 0;
    let localFrame = globalFrame;
    if (segments) {
      let target: Segment | undefined;
      if (spec.scene !== undefined) {
        target = segmentById.get(spec.scene);
        if (!target) throw new Error(`锚点 ${goQuote(spec.id)} 引用了未知镜头 ${goQuote(spec.scene)}`);
        if (globalFrame < target.startFrame || globalFrame >= target.startFrame + target.frames) {
          throw new Error(
            `锚点 ${goQuote(spec.id)} 位于全局第 ${globalFrame} 帧，越出镜头 ${goQuote(target.id)} 的帧范围 [${target.startFrame}, ${target.startFrame + target.frames})`,
          );
        }
      } else {
        target = segments.find((s) => globalFrame >= s.startFrame && globalFrame < s.startFrame + s.frames);
        if (!target) {
          throw new Error(`锚点 ${goQuote(spec.id)} 位于全局第 ${globalFrame} 帧，不属于任何镜头区间`);
        }
      }
      sceneId = target.id;
      shotStartFrame = target.startFrame;
      localFrame = globalFrame - target.startFrame;
      bySceneDraft.get(target.id)!.set(spec.id, localFrame);
    } else if (spec.scene !== undefined) {
      sceneId = spec.scene;
    }

    const resolvedSfx: ResolvedSfxCue[] = [];
    for (const binding of spec.sfx ?? []) {
      if (seenSfxCueIds.has(binding.cue_id)) {
        throw new Error(`音效 cue_id 重复绑定：${goQuote(binding.cue_id)}`);
      }
      seenSfxCueIds.add(binding.cue_id);
      const timing = resolveSfxPeakTiming(globalFrame, binding.peak_seconds, fps);
      const item: ResolvedSfxCue = { cue_id: binding.cue_id, anchor_id: spec.id, ...timing };
      resolvedSfx.push(item);
      sfxCues.push(item);
      sfxByCueId[binding.cue_id] = item;
    }

    const entry: ResolvedAnchor = {
      id: spec.id,
      type: spec.type,
      source,
      ...(spec.beat !== undefined ? { beat: spec.beat } : {}),
      music_seconds: musicSeconds,
      output_offset_seconds: outputOffsetSeconds,
      global_seconds: globalSeconds,
      global_frame: globalFrame,
      scene: sceneId,
      shot_start_frame: shotStartFrame,
      local_frame: localFrame,
      ...(spec.visual ? { visual: spec.visual } : {}),
      sfx: resolvedSfx,
    };
    resolved.push(entry);
    byId[spec.id] = entry;
  }

  const byScene = Object.create(null) as Record<string, Record<string, number>>;
  for (const [sceneId, map] of bySceneDraft.entries()) {
    const sorted = Object.create(null) as Record<string, number>;
    for (const key of [...map.keys()].sort(compareBytes)) sorted[key] = map.get(key)!;
    byScene[sceneId] = sorted;
  }

  return {
    schema: AnchorsSchemaVersion,
    fps,
    total_frames: programFrames,
    output_offset_seconds: outputOffsetSeconds,
    anchors: resolved,
    by_scene: byScene,
    by_id: byId,
    sfx_cues: sfxCues,
    sfx_by_cue_id: sfxByCueId,
  };
}

/** 读取并解析项目根下的 production/beat/anchors.json。 */
export function loadAndResolveAnchors(
  root: string,
  grid: Grid,
  segments: readonly Segment[],
  fps: number,
): ResolvedAnchorTable {
  return resolveAnchors(loadAnchors(root), { grid, segments, fps });
}
