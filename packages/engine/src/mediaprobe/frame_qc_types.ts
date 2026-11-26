// FFmpeg 全流帧检（frame_qc）的类型、常量、边缘分析、镜头映射、音轨解析与汇总。
import { formatFixed, goRound } from './gofmt';
import { SilenceFloorDB } from './loudness';

export const FrameQCSchemaVersion = 1;
export const DefaultFrameQCWidth = 480;
export const DefaultFreezeSeconds = 1.2;
export const DefaultFreezeWarnMultiplier = 2;
export const DefaultFreezeFailMultiplier = 4;
export const DefaultFreezeNoise = 0.003;
export const DefaultBlackMinFrames = 2;
export const DefaultBlackPixelThreshold = 0.1;
export const DefaultFlashDelta = 45;
export const DefaultFlashNeighborTolerance = 35;
export const DefaultFlatRangeThreshold = 4;
export const DefaultEdgeBandRatio = 0.02;
export const DefaultMinEdgeFrames = 3;
export const DefaultAudioClipPeakDB = -0.1;
export const DefaultSilenceMinSeconds = 3.0;

/** 边缘窄带采样尺寸：四边各缩为 120×4 灰度条，纵向拼成 120×16（1920 字节/帧）。 */
export const EdgeStripWidth = 120;
export const EdgeStripThickness = 4;
export const EdgeStripBytes = EdgeStripWidth * EdgeStripThickness;
export const EdgeFrameBytes = EdgeStripBytes * 4;

export type FrameQCSeverity = 'info' | 'warn' | 'fail';
export type FrameQCVerdict = 'pass' | FrameQCSeverity;
export type FrameQCEdge = 'top' | 'bottom' | 'left' | 'right';
export type FrameQCKind = 'black' | 'blank' | 'flash' | 'edge_clip' | 'freeze' | 'audio_clip' | 'audio_silence';

export interface FrameQCScene {
  id: string;
  /** 镜头起始帧（0 基，含）。 */
  startFrame: number;
  /** 镜头结束帧（默认半开 [startFrame, endFrame)；仅在 inclusive=true 时按闭区间处理）。 */
  endFrame: number;
  /** 显式标记 endFrame 为闭区间端点（含）；省略或 false 表示半开区间 [startFrame, endFrame)。 */
  inclusive?: boolean;
}

export interface FrameQCIssue {
  kind: FrameQCKind;
  severity: FrameQCSeverity;
  start_frame: number;
  end_frame: number;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  scene_id?: string;
  scene_ids?: string[];
  edge?: FrameQCEdge;
  message: string;
  metrics?: Record<string, number>;
}

export interface FrameQCAudioSummary {
  integrated_lufs: number;
  true_peak_dbtp: number;
  range_lu: number;
  silence_seconds: number;
}

export interface FrameQCSummary {
  verdict: FrameQCVerdict;
  issue_count: number;
  fail_count: number;
  warn_count: number;
  info_count: number;
  by_kind: Partial<Record<FrameQCKind, number>>;
}

export interface FrameQCReport {
  schema_version: number;
  path: string;
  /** 扫描目标视频文件的 SHA-256，用于在 review 附加摘要前核对报告与视频一致。 */
  video_sha256?: string;
  fps: number;
  total_frames: number;
  duration_seconds: number;
  scan_width: number;
  verdict: FrameQCVerdict;
  summary: FrameQCSummary;
  audio?: FrameQCAudioSummary;
  issues: FrameQCIssue[];
}

export interface SignalFrame {
  frame: number;
  ptsTime: number;
  ymin: number;
  yavg: number;
  ymax: number;
}

export interface TimeInterval {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

export interface EdgeClipMetrics {
  stddev: number;
  range: number;
  maxGrad: number;
  clipped: boolean;
}

export type EdgeFrameResult = Record<FrameQCEdge, EdgeClipMetrics>;

const severityRank: Record<FrameQCVerdict, number> = { pass: 0, info: 1, warn: 2, fail: 3 };

function measureStrip(buf: Buffer, base: number, stdTh = 18, rangeTh = 50, gradTh = 25): EdgeClipMetrics {
  let min = 255;
  let max = 0;
  let sum = 0;
  let maxGrad = 0;
  for (let y = 0; y < EdgeStripThickness; y++) {
    const row = base + y * EdgeStripWidth;
    for (let x = 0; x < EdgeStripWidth; x++) {
      const v = buf[row + x];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      if (x > 0) {
        const g = Math.abs(v - buf[row + x - 1]);
        if (g > maxGrad) maxGrad = g;
      }
      if (y > 0) {
        const g = Math.abs(v - buf[row - EdgeStripWidth + x]);
        if (g > maxGrad) maxGrad = g;
      }
    }
  }
  const mean = sum / EdgeStripBytes;
  let variance = 0;
  for (let i = 0; i < EdgeStripBytes; i++) {
    const d = buf[base + i] - mean;
    variance += d * d;
  }
  const stddev = Math.sqrt(variance / EdgeStripBytes);
  const range = max - min;
  return { stddev, range, maxGrad, clipped: stddev >= stdTh && range >= rangeTh && maxGrad >= gradTh };
}

/** 分析单帧 120×16 灰度边缘拼接图（top / bottom / left / right 各 120×4）。 */
export function analyzeEdgeFrame(buf: Buffer, offset = 0): EdgeFrameResult {
  return {
    top: measureStrip(buf, offset),
    bottom: measureStrip(buf, offset + EdgeStripBytes),
    left: measureStrip(buf, offset + EdgeStripBytes * 2),
    right: measureStrip(buf, offset + EdgeStripBytes * 3),
  };
}

/** 把 [startFrame, endFrame] 闭区间映射到镜头 ID 列表（默认镜头为半开区间 [startFrame, endFrame)，除非显式 inclusive=true）。 */
export function mapFrameRangeToScenes(
  startFrame: number,
  endFrame: number,
  scenes: readonly FrameQCScene[],
  _totalFrames: number,
): string[] {
  if (scenes.length === 0) return [];
  const ids: string[] = [];
  for (const scene of scenes) {
    const effectiveEnd = scene.inclusive ? scene.endFrame : scene.endFrame - 1;
    if (effectiveEnd < scene.startFrame) continue;
    if (startFrame <= effectiveEnd && endFrame >= scene.startFrame) ids.push(scene.id);
  }
  return ids;
}

export function round3(value: number): number {
  return goRound(value * 1000) / 1000;
}

export function clampFrame(frame: number, totalFrames: number): number {
  if (totalFrames <= 0) return Math.max(0, frame);
  return Math.max(0, Math.min(totalFrames - 1, frame));
}

export function withScenes(
  base: Omit<FrameQCIssue, 'scene_id' | 'scene_ids'>,
  scenes: readonly FrameQCScene[],
  totalFrames: number,
): FrameQCIssue {
  const matched = mapFrameRangeToScenes(base.start_frame, base.end_frame, scenes, totalFrames);
  const issue: FrameQCIssue = { ...base };
  if (matched.length >= 1) issue.scene_id = matched[0];
  if (matched.length > 1) issue.scene_ids = matched;
  return issue;
}

/** 统计全部告警的数量分布并计算最终 verdict（pass / info / warn / fail）。 */
export function summarizeFrameQC(issues: readonly FrameQCIssue[]): FrameQCSummary {
  let verdict: FrameQCVerdict = 'pass';
  let failCount = 0;
  let warnCount = 0;
  let infoCount = 0;
  const byKind: Partial<Record<FrameQCKind, number>> = {};
  for (const issue of issues) {
    if (severityRank[issue.severity] > severityRank[verdict]) verdict = issue.severity;
    if (issue.severity === 'fail') failCount++;
    else if (issue.severity === 'warn') warnCount++;
    else infoCount++;
    byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1;
  }
  return {
    verdict,
    issue_count: issues.length,
    fail_count: failCount,
    warn_count: warnCount,
    info_count: infoCount,
    by_kind: byKind,
  };
}

export function makeIssue(
  params: { fps: number; totalFrames: number; scenes: readonly FrameQCScene[] },
  spec: Pick<FrameQCIssue, 'kind' | 'severity' | 'edge' | 'message' | 'metrics'> & {
    startFrame: number;
    endFrame: number;
    durationSeconds?: number;
  },
): FrameQCIssue {
  const { fps, totalFrames, scenes } = params;
  const count = spec.endFrame - spec.startFrame + 1;
  return withScenes(
    {
      kind: spec.kind,
      severity: spec.severity,
      ...(spec.edge ? { edge: spec.edge } : {}),
      start_frame: spec.startFrame,
      end_frame: spec.endFrame,
      start_seconds: round3(spec.startFrame / fps),
      end_seconds: round3((spec.endFrame + 1) / fps),
      duration_seconds: round3(spec.durationSeconds ?? count / fps),
      message: spec.message,
      ...(spec.metrics ? { metrics: spec.metrics } : {}),
    },
    scenes,
    totalFrames,
  );
}

const reEbuIntegrated = /Integrated loudness:[\t\n\f\r ]+I:[\t ]+([+-]?\d+(?:\.\d+)?|-inf)[\t ]+LUFS/i;
const reEbuLra = /Loudness range:[\t\n\f\r ]+LRA:[\t ]+([+-]?\d+(?:\.\d+)?)[\t ]+LU/i;
const reEbuPeak = /True peak:[\t\n\f\r ]+Peak:[\t ]+([+-]?\d+(?:\.\d+)?|-inf)[\t ]+dBFS/i;
const reSilenceStart = /silence_start:[\t ]*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const reSilenceEnd =
  /silence_end:[\t ]*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[\t ]*\|[\t ]*silence_duration:[\t ]*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

function parseSignedOrInf(raw: string): number {
  return /^-inf$/i.test(raw.trim()) ? SilenceFloorDB : Math.max(SilenceFloorDB, Number(raw));
}

/** 解析 ebur128=peak=true 与 silencedetect 输出，生成音轨摘要与告警。 */
export function parseAudioQC(
  stderr: string,
  durationSeconds: number,
  fps: number,
  totalFrames: number,
  scenes: readonly FrameQCScene[],
  opts: { clipPeakDB: number; silenceMinSeconds: number },
): { summary: FrameQCAudioSummary; issues: FrameQCIssue[] } {
  const idx = stderr.lastIndexOf('Summary:');
  const tail = idx >= 0 ? stderr.slice(idx) : stderr;
  const iMatch = reEbuIntegrated.exec(tail);
  const peakMatch = reEbuPeak.exec(tail);
  const integrated = iMatch ? parseSignedOrInf(iMatch[1]) : SilenceFloorDB;
  const lra = Number(reEbuLra.exec(tail)?.[1] ?? 0);
  const truePeak = peakMatch ? parseSignedOrInf(peakMatch[1]) : SilenceFloorDB;

  const silences: TimeInterval[] = [];
  let openStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const sm = reSilenceStart.exec(line);
    if (sm) {
      openStart = Number(sm[1]);
      continue;
    }
    const em = reSilenceEnd.exec(line);
    if (em) {
      const endSec = Number(em[1]);
      const durSec = Number(em[2]);
      silences.push({
        startSeconds: openStart ?? Math.max(0, endSec - durSec),
        endSeconds: endSec,
        durationSeconds: durSec,
      });
      openStart = null;
    }
  }
  if (openStart !== null) {
    silences.push({
      startSeconds: openStart,
      endSeconds: durationSeconds,
      durationSeconds: Math.max(0, durationSeconds - openStart),
    });
  }
  const totalSilence = silences.reduce((acc, s) => acc + s.durationSeconds, 0);
  const issues: FrameQCIssue[] = [];
  const lastFrame = Math.max(0, totalFrames - 1);
  const ctx = { fps, totalFrames, scenes };

  if (truePeak > opts.clipPeakDB) {
    issues.push(
      makeIssue(ctx, {
        kind: 'audio_clip',
        severity: truePeak >= 0 ? 'fail' : 'warn',
        startFrame: 0,
        endFrame: lastFrame,
        durationSeconds,
        message: `音轨真峰值 ${formatFixed(truePeak, 2)} dBFS 超过削波告警阈值 ${formatFixed(opts.clipPeakDB, 2)} dBFS`,
        metrics: { true_peak_dbtp: round3(truePeak), threshold_db: opts.clipPeakDB },
      }),
    );
  }
  if ((durationSeconds > 0 && totalSilence >= durationSeconds * 0.98) || integrated <= -69.5) {
    issues.push(
      makeIssue(ctx, {
        kind: 'audio_silence',
        severity: 'fail',
        startFrame: 0,
        endFrame: lastFrame,
        durationSeconds,
        message: `音轨整段静音（积分响度 ${formatFixed(integrated, 1)} LUFS，静音累计 ${formatFixed(totalSilence, 2)}s）`,
        metrics: { silence_seconds: round3(totalSilence), integrated_lufs: round3(integrated) },
      }),
    );
  } else {
    for (const s of silences) {
      if (s.durationSeconds < opts.silenceMinSeconds) continue;
      const startFrame = clampFrame(goRound(s.startSeconds * fps), totalFrames);
      const endFrame = clampFrame(Math.max(startFrame, goRound(s.endSeconds * fps) - 1), totalFrames);
      issues.push(
        makeIssue(ctx, {
          kind: 'audio_silence',
          severity: 'warn',
          startFrame,
          endFrame,
          durationSeconds: s.durationSeconds,
          message: `检测到音轨长静音段（第 ${startFrame}–${endFrame} 帧，时长 ${formatFixed(s.durationSeconds, 2)}s）`,
          metrics: { silence_seconds: round3(s.durationSeconds) },
        }),
      );
    }
  }
  return {
    summary: {
      integrated_lufs: round3(integrated),
      true_peak_dbtp: round3(truePeak),
      range_lu: round3(lra),
      silence_seconds: round3(totalSilence),
    },
    issues,
  };
}
