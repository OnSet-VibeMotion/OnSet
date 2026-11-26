// 成片音画回测（av_backtest）的结构化输入输出类型与默认常量。
import type { AudioMatchResult, VisualPeakResult } from './av_backtest_signal';

export const AVBacktestSchemaVersion = 1;
export const DefaultAVToleranceFrames = 2;
export const MaxAVToleranceFrames = 3;
export const DefaultAVVisualWindowFrames = 6;

export type AVBacktestVerdict = 'pass' | 'fail' | 'unverified';

export interface AVBacktestROI {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AVBacktestSfxRef {
  cue_id: string;
  peak_seconds: number;
  /** 可选独立音效源文件路径；提供时用波形互相关精准定位音效峰值。 */
  asset?: string;
}

export interface AVBacktestAnchor {
  id: string;
  type: 'cut' | 'action';
  /** 源音乐中的名义瞬态时刻（秒）。 */
  music_seconds: number;
  /** 成片中的计划帧号（0-based）。 */
  planned_frame: number;
  scene?: string;
  visual?: {
    metric: 'change' | 'brightness';
    roi?: AVBacktestROI;
  };
  sfx?: AVBacktestSfxRef[];
}

export interface AVBacktestSfxResult {
  cue_id: string;
  peak_seconds: number;
  status: AVBacktestVerdict;
  verified: boolean;
  actual_seconds?: number;
  sfx_error_seconds?: number;
  sfx_error_frames?: number;
  correlation?: number;
  reason?: string;
}

export interface AVBacktestAnchorReport {
  id: string;
  type: 'cut' | 'action';
  scene?: string;
  music_seconds: number;
  planned_frame: number;
  planned_seconds: number;
  status: AVBacktestVerdict;
  music: AudioMatchResult;
  visual: VisualPeakResult & { roi?: AVBacktestROI };
  visual_error_seconds?: number;
  visual_error_frames?: number;
  sfx: AVBacktestSfxResult[];
  reasons: string[];
}

export interface AVBacktestSummary {
  total: number;
  pass: number;
  fail: number;
  unverified: number;
  reliable_music_matches: number;
  music_offset_spread_seconds: number | null;
}

export interface AVBacktestReport {
  schema_version: number;
  video: string;
  source_music: string;
  fps: number;
  total_frames: number;
  tolerance_frames: number;
  window_frames: number;
  verdict: AVBacktestVerdict;
  measured_output_offset_seconds: number | null;
  summary: AVBacktestSummary;
  anchors: AVBacktestAnchorReport[];
}

export interface AVBacktestOptions {
  video: string;
  sourceMusic: string;
  anchors: readonly AVBacktestAnchor[];
  /** 可选 SFX 独立分轨（如 production/audio/sfx.wav），用于实测音效-音乐误差。 */
  sfxStem?: string;
  fps?: number;
  /** 允许的音画误差容差（整数帧，0–3，默认 2）。 */
  toleranceFrames?: number;
  /** 画面变化/亮度峰搜索窗口（±帧，默认 6）。 */
  windowFrames?: number;
  /** 音频互相关搜索窗口（±秒，默认 0.25s）。 */
  audioSearchWindowSeconds?: number;
  /** 音频互相关最低阈值（默认 0.35）。 */
  minAudioCorrelation?: number;
  /** 画面变化/亮度最小显著幅值（0–255，默认 4.0）。 */
  minVisualDelta?: number;
  /** 报告落盘路径（如 av-backtest.json）；提供时原子写出。 */
  outPath?: string;
  signal?: AbortSignal;
}
