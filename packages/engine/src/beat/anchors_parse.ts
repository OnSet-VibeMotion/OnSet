// 锚点表的数据类型定义与严格 JSON 解析校验（供 beat/anchors.ts 使用）。
import { goQuote, goTrimSpace } from '../gofmt';

export const AnchorsSchemaVersion = 1;

export type AnchorType = 'cut' | 'action';
export type AnchorVisualMetric = 'change' | 'brightness';

/** 画面验收 ROI：支持 0..1 归一化坐标或正数像素坐标。 */
export interface AnchorROI {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnchorVisual {
  metric: AnchorVisualMetric;
  roi?: AnchorROI;
}

export interface AnchorSfxBinding {
  cue_id: string;
  peak_seconds: number;
}

export interface AnchorSpec {
  id: string;
  type: AnchorType;
  /** 节拍网格中的拍号（0-based 整数索引，对应 grid.beats[beat]），与 at 二选一。 */
  beat?: number;
  /** 音乐瞬态时刻（秒，非负有限数），与 beat 二选一。 */
  at?: number;
  /** 可选显式归属镜头 ID；省略时按全局帧自动归属，填写时严格校验镜头存在且覆盖该帧。 */
  scene?: string;
  visual?: AnchorVisual;
  sfx?: AnchorSfxBinding[];
}

export interface AnchorsFileData {
  schema: number;
  /** 可选全局输出校准补偿（秒）：正值把画面与音效目标向后移以对齐实际听到的音乐延迟。 */
  output_offset_seconds?: number;
  anchors: AnchorSpec[];
}

export interface SfxPeakTiming {
  anchor_frame: number;
  peak_seconds: number;
  peak_frames: number;
  raw_start_frame: number;
  start_frame: number;
  source_start_frame: number;
  trim_start_seconds: number;
  trimmed_frames: number;
}

export interface ResolvedSfxCue extends SfxPeakTiming {
  cue_id: string;
  anchor_id: string;
}

export interface ResolvedAnchor {
  id: string;
  type: AnchorType;
  source: 'beat' | 'at';
  beat?: number;
  music_seconds: number;
  output_offset_seconds: number;
  global_seconds: number;
  global_frame: number;
  scene: string;
  shot_start_frame: number;
  local_frame: number;
  visual?: AnchorVisual;
  sfx: ResolvedSfxCue[];
}

export interface ResolvedAnchorTable {
  schema: number;
  fps: number;
  total_frames: number;
  output_offset_seconds: number;
  anchors: ResolvedAnchor[];
  by_scene: Record<string, Record<string, number>>;
  by_id: Record<string, ResolvedAnchor>;
  sfx_cues: ResolvedSfxCue[];
  sfx_by_cue_id: Record<string, ResolvedSfxCue>;
}

const topKeys = new Set(['schema', 'output_offset_seconds', 'anchors']);
const anchorKeys = new Set(['id', 'type', 'beat', 'at', 'scene', 'visual', 'sfx']);
const visualKeys = new Set(['metric', 'roi']);
const roiKeys = new Set(['x', 'y', 'w', 'h']);
const sfxKeys = new Set(['cue_id', 'peak_seconds']);

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function checkAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(`${label} 包含未知字段 ${goQuote(key)}`);
  }
}

function parseROI(raw: unknown, label: string): AnchorROI {
  const obj = asObject(raw, `${label}.roi`);
  checkAllowedKeys(obj, roiKeys, `${label}.roi`);
  const { x, y, w, h } = obj;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    throw new Error(`${label}.roi 的 x/y/w/h 必须是有限数字`);
  }
  if (x < 0 || y < 0 || w <= 0 || h <= 0) {
    throw new Error(`${label}.roi 越界：x/y 必须非负且 w/h 必须为正`);
  }
  const normalized = x <= 1 && y <= 1 && w <= 1 && h <= 1;
  if (normalized && (x + w > 1 + 1e-6 || y + h > 1 + 1e-6)) {
    throw new Error(`${label}.roi 归一化区域越界：x+w 与 y+h 不得超过 1`);
  }
  return { x, y, w, h };
}

function parseVisual(raw: unknown, label: string): AnchorVisual {
  const obj = asObject(raw, `${label}.visual`);
  checkAllowedKeys(obj, visualKeys, `${label}.visual`);
  if (obj.metric !== 'change' && obj.metric !== 'brightness') {
    throw new Error(`${label}.visual.metric 必须是 "change" 或 "brightness"`);
  }
  const visual: AnchorVisual = { metric: obj.metric };
  if (obj.roi !== undefined) visual.roi = parseROI(obj.roi, `${label}.visual`);
  return visual;
}

function parseSfxList(raw: unknown, label: string): AnchorSfxBinding[] {
  if (!Array.isArray(raw)) throw new Error(`${label}.sfx 必须是数组`);
  return raw.map((item, idx) => {
    const itemLabel = `${label}.sfx[${idx}]`;
    const obj = asObject(item, itemLabel);
    checkAllowedKeys(obj, sfxKeys, itemLabel);
    if (typeof obj.cue_id !== 'string' || goTrimSpace(obj.cue_id) === '') {
      throw new Error(`${itemLabel}.cue_id 必须是非空字符串`);
    }
    if (typeof obj.peak_seconds !== 'number' || !Number.isFinite(obj.peak_seconds) || obj.peak_seconds < 0) {
      throw new Error(`${itemLabel}.peak_seconds 必须是有限且非负的数字`);
    }
    return { cue_id: obj.cue_id, peak_seconds: obj.peak_seconds };
  });
}

/** 校验并解析原始 anchors JSON 对象。 */
export function parseAnchorsData(raw: unknown): AnchorsFileData {
  const obj = asObject(raw, 'anchors.json');
  checkAllowedKeys(obj, topKeys, 'anchors.json');
  if (obj.schema !== AnchorsSchemaVersion) {
    throw new Error(`anchors.json 的 schema 必须为 ${AnchorsSchemaVersion}`);
  }
  let outputOffsetSeconds: number | undefined;
  if (obj.output_offset_seconds !== undefined) {
    if (typeof obj.output_offset_seconds !== 'number' || !Number.isFinite(obj.output_offset_seconds)) {
      throw new Error('anchors.json 的 output_offset_seconds 必须是有限数字');
    }
    outputOffsetSeconds = obj.output_offset_seconds;
  }
  if (!Array.isArray(obj.anchors)) throw new Error('anchors.json 缺少 anchors 数组');
  const anchors: AnchorSpec[] = obj.anchors.map((item, idx) => {
    const label = `anchors[${idx}]`;
    const a = asObject(item, label);
    checkAllowedKeys(a, anchorKeys, label);
    if (typeof a.id !== 'string' || goTrimSpace(a.id) === '') {
      throw new Error(`${label}.id 必须是非空字符串`);
    }
    if (a.type !== 'cut' && a.type !== 'action') {
      throw new Error(`${label}（${goQuote(a.id)}）的 type 必须是 "cut" 或 "action"`);
    }
    const hasBeat = a.beat !== undefined;
    const hasAt = a.at !== undefined;
    if (hasBeat === hasAt) {
      throw new Error(`${label}（${goQuote(a.id)}）必须且只能指定 beat 或 at 之一`);
    }
    const spec: AnchorSpec = { id: a.id, type: a.type };
    if (hasBeat) {
      if (typeof a.beat !== 'number' || !Number.isSafeInteger(a.beat) || a.beat < 0) {
        throw new Error(`${label}（${goQuote(a.id)}）的 beat 必须是非负整数拍号`);
      }
      spec.beat = a.beat;
    }
    if (hasAt) {
      if (typeof a.at !== 'number' || !Number.isFinite(a.at) || a.at < 0) {
        throw new Error(`${label}（${goQuote(a.id)}）的 at 必须是有限且非负的秒数`);
      }
      spec.at = a.at;
    }
    if (a.scene !== undefined) {
      if (typeof a.scene !== 'string' || goTrimSpace(a.scene) === '') {
        throw new Error(`${label}（${goQuote(a.id)}）的 scene 必须是非空字符串`);
      }
      spec.scene = a.scene;
    }
    if (a.visual !== undefined) spec.visual = parseVisual(a.visual, `${label}（${goQuote(a.id)}）`);
    if (a.sfx !== undefined) spec.sfx = parseSfxList(a.sfx, `${label}（${goQuote(a.id)}）`);
    return spec;
  });
  return {
    schema: AnchorsSchemaVersion,
    ...(outputOffsetSeconds !== undefined ? { output_offset_seconds: outputOffsetSeconds } : {}),
    anchors,
  };
}
