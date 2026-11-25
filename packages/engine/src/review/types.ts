import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { type FrameQCSummary, type FrameStats, type Media, mediaToJSON, type ProgramLoudness } from '../mediaprobe';
import type { DeliverySpec } from './delivery';

/** Prober 是复查用到的全部媒体操作；mediaprobe.Toolchain 满足它。 */
export interface Prober {
  probe(file: string): Media;
  countFrames(file: string): number;
  frameStats(file: string, atSeconds: number): FrameStats;
  frameDifference(file: string, a: number, b: number): number;
  contactSheet(file: string, atSeconds: number[], columns: number, thumbWidth: number, dest: string): void;
  measureProgramLoudness(file: string): ProgramLoudness;
}

/** LoudnessTarget 是成片混音的响度目标，来自 frame.md 的 audio 块。 */
export interface LoudnessTarget {
  integratedLUFS: number;
  tolerance: number;
  truePeakMax: number;
}

/**
 * SeamFrames 是交界条带在切点两侧各取的帧数：30fps 下前后各 0.2 秒，正好覆盖
 * 一次转场的收尾与起势。只看切点两侧各一帧，判断不了转场是否顺。
 */
export const SeamFrames = 6;

/**
 * Segment 是成片里按顺序首尾相接的一个镜头。handoff 是从上一镜头进入本镜头
 * 时约定的交接手法，空串（或省略）表示没有约定（硬切）；crossChapter 标记章节交界。
 */
export interface Segment {
  id: string;
  frames: number;
  handoff?: string;
  crossChapter?: boolean;
}

// 交界帧差异的判定阈值（meanAbsoluteDifference，0–255）。
//
// 只对声明了交接的交界判：两侧按约定都画同一帧，前一镜末帧与后一镜首帧应当
// 几乎相同。没有约定的交界是有意的硬切，差异再大也不说明什么。
// 阈值取得宽：交接物件挪了几像素、底纹淡了一点都不该拦，拦下的只该是「两张
// 不同的画面」——误判几次，这道门就没人信了。
/** handoffBreakDifference 及以上判为没接上，进 problems。 */
export const handoffBreakDifference = 48.0;
/** handoffLooseDifference 及以上进 hints，让看图的一方确认。 */
export const handoffLooseDifference = 20.0;
/** 约定了交接的交界，两帧差异到这个数就算没接顺：拼接时抹平（concat）、修接缝（scene_seams）都按它挑交界。 */
export const HandoffLooseDifference = handoffLooseDifference;

/** Options 控制一次复查。segments 为空时只做与镜头无关的检查，联系表按固定间隔取帧。 */
export interface Options {
  video: string;
  fps: number;
  /** 同一次操作已精确计数的媒体。只供宿主传入，工具参数不能声明校验结论。 */
  verifiedMedia?: Media;
  segments?: Segment[] | null;
  outDir?: string;
  /** silent 断言成片没有音轨（只拼接未混音的交付），不做音画比对。 */
  silent?: boolean;
  /** loudness 省略时只记录实测值，不做比对。 */
  loudness?: LoudnessTarget | null;
  /** syncTolerance 是音视频流时长允许的差值（秒）。 */
  syncTolerance?: number;
  /** every 是没有镜头信息时联系表的取帧间隔（秒）。 */
  every?: number;
  /** tilesPerSheet 是每张联系表的格子数，超出就分页。 */
  tilesPerSheet?: number;
  thumbWidth?: number;
  /** 可选：显式指定已生成的 frame-qc.json 路径；省略时若 outDir 下存在 frame-qc.json 会自动透出摘要。 */
  frameQCPath?: string;
}

/** Tile 是联系表里的一格。position 是 start / middle / end / sample（交界条带里是 before / after）。scene_id 为空时不写出。 */
export interface Tile {
  scene_id: string;
  position: string;
  frame: number;
  at_seconds: number;
}

/** Sheet 是一张联系表，tiles 按图中从左到右、从上到下的顺序排列。 */
export interface Sheet {
  image: string;
  columns: number;
  tiles: Tile[];
}

/** Cut 是两个镜头的交界：before 是前一镜的末帧，after 是后一镜的首帧。 */
export interface Cut {
  from: string;
  to: string;
  frame: number;
  before: FrameStats;
  after: FrameStats;
  /** handoff 与 difference 只在该交界声明了交接时出现（handoff 为空串、difference 为 null 时不写出）。 */
  handoff: string;
  difference: number | null;
}

/** Report 是复查的机器可读结果。ok 只由 problems 决定。零值字段按 Go 的 omitempty 不写出，见 reportToJSON。 */
export interface Report {
  schema_version: number;
  path: string;
  /** 核对交付规格时读到的影片字节。 */
  video_sha256?: string;
  delivery_spec?: DeliverySpec;
  scene_plan_sha256?: string;
  ok: boolean;
  media: Media;
  expected_frames: number;
  counted_frames: number;
  /** loudness 是解码成片后实测的响度；没有音轨时为 null。 */
  loudness: ProgramLoudness | null;
  problems: string[];
  hints: string[];
  cuts: Cut[];
  sheets: Sheet[];
  /** seams 是每个镜头交界的逐帧条带，切点在第 SeamFrames+1 格。 */
  seams: Sheet[];
  /** 可选：由 frame-qc.json 透出的全流帧检摘要。 */
  frame_qc?: FrameQCSummary;
}

/** ReportSchemaVersion 是 Report 的结构版本。 */
export const ReportSchemaVersion = 1;

function frameStatsJSON(f: FrameStats): unknown {
  return { at_seconds: f.at_seconds, mean: f.mean, stddev: f.stddev };
}

function sheetJSON(s: Sheet): unknown {
  return {
    image: s.image,
    columns: s.columns,
    tiles: s.tiles.map((t) => ({
      scene_id: t.scene_id || undefined,
      position: t.position,
      frame: t.frame,
      at_seconds: t.at_seconds,
    })),
  };
}

/** 按 Go 的字段顺序与 omitempty 构造 review.json 的 JSON 值。 */
export function reportToJSON(r: Report): unknown {
  return {
    schema_version: r.schema_version,
    path: r.path,
    video_sha256: r.video_sha256,
    delivery_spec: r.delivery_spec,
    scene_plan_sha256: r.scene_plan_sha256,
    ok: r.ok,
    media: mediaToJSON(r.media),
    expected_frames: r.expected_frames || undefined,
    counted_frames: r.counted_frames || undefined,
    loudness: r.loudness
      ? {
          integrated_lufs: r.loudness.integrated_lufs,
          true_peak_dbtp: r.loudness.true_peak_dbtp,
          range_lu: r.loudness.range_lu,
        }
      : undefined,
    problems: r.problems,
    hints: r.hints.length > 0 ? r.hints : undefined,
    cuts:
      r.cuts.length > 0
        ? r.cuts.map((c) => ({
            from: c.from,
            to: c.to,
            frame: c.frame,
            before: frameStatsJSON(c.before),
            after: frameStatsJSON(c.after),
            handoff: c.handoff || undefined,
            difference: c.difference ?? undefined,
          }))
        : undefined,
    sheets: r.sheets.map(sheetJSON),
    seams: r.seams.length > 0 ? r.seams.map(sheetJSON) : undefined,
    frame_qc: r.frame_qc,
  };
}

/** WriteJSON 原子写出报告。 */
export function writeReportJSON(r: Report, target: string): void {
  atomicWrite(target, Buffer.from(marshalIndent(reportToJSON(r)) + '\n', 'utf8'), 0o644);
}

// 缺省值。DefaultTilesPerSheet 取 3 的倍数，按镜头排版时一行正好是一个镜头的首、中、末。
export const DefaultSyncTolerance = 0.1;
export const DefaultEvery = 5.0;
export const DefaultTilesPerSheet = 18;
export const DefaultThumbWidth = 360;

export interface Resolved {
  video: string;
  fps: number;
  segments: Segment[];
  outDir: string;
  silent: boolean;
  loudness: LoudnessTarget | null;
  syncTolerance: number;
  every: number;
  tilesPerSheet: number;
  thumbWidth: number;
}

export function withDefaults(o: Options): Resolved {
  const positive = (v: number | undefined, fallback: number): number => (v !== undefined && v > 0 ? v : fallback);
  return {
    video: o.video,
    fps: o.fps,
    segments: o.segments ?? [],
    outDir: o.outDir ?? '',
    silent: o.silent ?? false,
    loudness: o.loudness ?? null,
    syncTolerance: positive(o.syncTolerance, DefaultSyncTolerance),
    every: positive(o.every, DefaultEvery),
    tilesPerSheet: positive(o.tilesPerSheet, DefaultTilesPerSheet),
    thumbWidth: positive(o.thumbWidth, DefaultThumbWidth),
  };
}

export function frameTime(frame: number, fps: number): number {
  return frame / fps;
}

/** HandoffBroken 报告这个交界是否约定了交接却没接上（与 problems 里的判定一致）。 */
export function handoffBroken(cut: Pick<Cut, 'handoff' | 'difference'>): boolean {
  return (
    (cut.handoff ?? '') !== '' &&
    cut.difference !== null &&
    cut.difference !== undefined &&
    cut.difference >= handoffBreakDifference
  );
}
