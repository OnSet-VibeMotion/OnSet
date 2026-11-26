// FFmpeg 降采样全流自动帧检：单遍扫描黑场、平场/空白帧、单帧闪烁、四边贴边、长静止段，并支持可选音轨削波/静音检测。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { buildVideoIssues, VideoLogParser } from './frame_qc_parse';
import {
  analyzeEdgeFrame,
  DefaultAudioClipPeakDB,
  DefaultBlackMinFrames,
  DefaultBlackPixelThreshold,
  DefaultEdgeBandRatio,
  DefaultFlashDelta,
  DefaultFlashNeighborTolerance,
  DefaultFlatRangeThreshold,
  DefaultFrameQCWidth,
  DefaultFreezeFailMultiplier,
  DefaultFreezeNoise,
  DefaultFreezeSeconds,
  DefaultFreezeWarnMultiplier,
  DefaultMinEdgeFrames,
  DefaultSilenceMinSeconds,
  EdgeFrameBytes,
  type EdgeFrameResult,
  EdgeStripThickness,
  EdgeStripWidth,
  type FrameQCAudioSummary,
  type FrameQCIssue,
  type FrameQCReport,
  type FrameQCScene,
  FrameQCSchemaVersion,
  type FrameQCSummary,
  parseAudioQC,
  summarizeFrameQC,
} from './frame_qc_types';
import { goRound } from './gofmt';
import { videoFPS } from './mediaprobe';
import { commandError, firstLine, runStream } from './run';
import type { Toolchain } from './toolchain';

export type {
  FrameQCAudioSummary,
  FrameQCEdge,
  FrameQCIssue,
  FrameQCKind,
  FrameQCReport,
  FrameQCScene,
  FrameQCSeverity,
  FrameQCSummary,
  FrameQCVerdict,
} from './frame_qc_types';
export {
  DefaultAudioClipPeakDB,
  DefaultBlackMinFrames,
  DefaultBlackPixelThreshold,
  DefaultEdgeBandRatio,
  DefaultFlashDelta,
  DefaultFlashNeighborTolerance,
  DefaultFlatRangeThreshold,
  DefaultFrameQCWidth,
  DefaultFreezeFailMultiplier,
  DefaultFreezeNoise,
  DefaultFreezeSeconds,
  DefaultFreezeWarnMultiplier,
  DefaultMinEdgeFrames,
  DefaultSilenceMinSeconds,
  FrameQCSchemaVersion,
  mapFrameRangeToScenes,
  summarizeFrameQC,
} from './frame_qc_types';

export interface FrameQCOptions {
  video: string;
  fps?: number;
  scenes?: readonly FrameQCScene[];
  /** 降采样扫描宽度（像素），默认 480。 */
  scanWidth?: number;
  /** 静止段基础阈值（秒），默认 1.2s；>=2× 记 warn，>=4× 记 fail。 */
  freezeSeconds?: number;
  freezeWarnMultiplier?: number;
  freezeFailMultiplier?: number;
  freezeNoise?: number;
  /** 黑场最短持续帧数，默认 2 帧。 */
  blackMinFrames?: number;
  blackPixelThreshold?: number;
  /** 单帧闪烁的 YAVG 突变阈值（0–255），默认 45。 */
  flashDelta?: number;
  flashNeighborTolerance?: number;
  /** 平场/空白帧的 YMAX - YMIN 上限，默认 4。 */
  flatRangeThreshold?: number;
  /** 边缘窄带占比（相对降采样后宽高，至少 4px），默认 0.02。 */
  edgeBandRatio?: number;
  /** 连续命中多少帧才上报边缘贴边告警，默认 3。 */
  minEdgeFrames?: number;
  /** 是否执行音轨 EBU R128 削波与静音检测；默认在存在音轨时开启。 */
  checkAudio?: boolean;
  /** 音轨真峰值削波告警阈值（dBFS），默认 -0.1。 */
  audioClipPeakDB?: number;
  /** 音轨局部长静音段告警阈值（秒），默认 3.0。 */
  silenceMinSeconds?: number;
  /** 报告输出路径（如 frame-qc.json）；提供时原子落盘。 */
  outPath?: string;
  signal?: AbortSignal;
}

function buildVideoFilterGraph(opts: {
  scanWidth: number;
  blackMinSec: number;
  blackPixTh: number;
  freezeNoise: number;
  freezeSeconds: number;
  edgeBandRatio: number;
}): string {
  const r = opts.edgeBandRatio;
  const hBand = `max(4,trunc(ih*${r}))`;
  const wBand = `max(4,trunc(iw*${r}))`;
  const w = EdgeStripWidth;
  const t = EdgeStripThickness;
  return [
    `[0:v:0]scale='min(${opts.scanWidth},iw)':-2,split=5[main][top][bot][lft][rgt]`,
    `[main]blackdetect=d=${opts.blackMinSec.toFixed(4)}:pix_th=${opts.blackPixTh},freezedetect=n=${opts.freezeNoise}:d=${opts.freezeSeconds},signalstats,metadata=mode=print[m]`,
    `[top]crop=iw:'${hBand}':0:0,scale=${w}:${t}:flags=area[tc]`,
    `[bot]crop=iw:'${hBand}':0:'ih-${hBand}',scale=${w}:${t}:flags=area[bc]`,
    `[lft]crop='${wBand}':ih:0:0,transpose=1,scale=${w}:${t}:flags=area[lc]`,
    `[rgt]crop='${wBand}':ih:'iw-${wBand}':0,transpose=1,scale=${w}:${t}:flags=area[rc]`,
    `[tc][bc][lc][rc]vstack=inputs=4,format=gray[edges]`,
  ].join(';');
}

function hashFileSha256(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const hash = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** 原子写出 frame-qc.json。 */
export function writeFrameQCReportJSON(report: FrameQCReport, target: string): void {
  atomicWrite(target, Buffer.from(marshalIndent(report) + '\n', 'utf8'), 0o644);
}

/** 读取已落盘的 frame-qc.json 并返回摘要；文件不存在返回 null。 */
export function readFrameQCSummary(file: string): FrameQCSummary | null {
  if (!fs.existsSync(file)) return null;
  let parsed: Partial<FrameQCReport>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<FrameQCReport>;
  } catch {
    return null;
  }
  if (parsed.summary && typeof parsed.summary.verdict === 'string') return parsed.summary;
  if (Array.isArray(parsed.issues)) return summarizeFrameQC(parsed.issues);
  return null;
}

/** 读取 frame-qc.json 并按视频 SHA-256 核对是否与目标视频匹配；不匹配时标记 stale 并忽略旧摘要。 */
export function readFrameQCForVideo(
  file: string,
  videoPath: string,
): { summary: FrameQCSummary | null; stale: boolean } {
  if (!fs.existsSync(file)) return { summary: null, stale: false };
  let parsed: Partial<FrameQCReport>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<FrameQCReport>;
  } catch {
    return { summary: null, stale: false };
  }
  const summary =
    parsed.summary && typeof parsed.summary.verdict === 'string'
      ? parsed.summary
      : Array.isArray(parsed.issues)
        ? summarizeFrameQC(parsed.issues)
        : null;
  if (!summary) return { summary: null, stale: false };
  const actualSha = hashFileSha256(videoPath);
  if (!parsed.video_sha256 || !actualSha || parsed.video_sha256 !== actualSha) {
    return { summary: null, stale: true };
  }
  return { summary, stale: false };
}

/** 对视频执行降采样全流帧检与可选音轨检查，返回结构化报告。 */
export async function runFrameQC(t: Toolchain, opts: FrameQCOptions): Promise<FrameQCReport> {
  const media = t.probe(opts.video);
  if (!media.video) throw new Error(`全流帧检失败：视频没有视频流（${opts.video}）`);
  const fps = opts.fps && opts.fps > 0 ? opts.fps : videoFPS(media.video);
  if (!(fps > 0)) throw new Error(`全流帧检需要有效的帧率，无法从 ${opts.video} 确定`);

  const scanWidth = opts.scanWidth && opts.scanWidth > 0 ? Math.max(64, goRound(opts.scanWidth)) : DefaultFrameQCWidth;
  const freezeSeconds = opts.freezeSeconds && opts.freezeSeconds > 0 ? opts.freezeSeconds : DefaultFreezeSeconds;
  const freezeWarnMultiplier = opts.freezeWarnMultiplier ?? DefaultFreezeWarnMultiplier;
  const freezeFailMultiplier = opts.freezeFailMultiplier ?? DefaultFreezeFailMultiplier;
  const freezeNoise = opts.freezeNoise ?? DefaultFreezeNoise;
  const blackMinFrames = Math.max(1, opts.blackMinFrames ?? DefaultBlackMinFrames);
  const blackPixelThreshold = opts.blackPixelThreshold ?? DefaultBlackPixelThreshold;
  const flashDelta = opts.flashDelta ?? DefaultFlashDelta;
  const flashNeighborTolerance = opts.flashNeighborTolerance ?? DefaultFlashNeighborTolerance;
  const flatRangeThreshold = opts.flatRangeThreshold ?? DefaultFlatRangeThreshold;
  const edgeBandRatio = opts.edgeBandRatio ?? DefaultEdgeBandRatio;
  const minEdgeFrames = Math.max(1, opts.minEdgeFrames ?? DefaultMinEdgeFrames);
  const audioClipPeakDB = opts.audioClipPeakDB ?? DefaultAudioClipPeakDB;
  const silenceMinSeconds = opts.silenceMinSeconds ?? DefaultSilenceMinSeconds;
  const scenes = opts.scenes ?? [];

  // 留出略小于半帧的余量，确保恰好 N 帧的黑场能稳定触发 blackdetect。
  const blackMinSec = Math.max(0.005, (blackMinFrames - 0.25) / fps);
  const filterGraph = buildVideoFilterGraph({
    scanWidth,
    blackMinSec,
    blackPixTh: blackPixelThreshold,
    freezeNoise,
    freezeSeconds,
    edgeBandRatio,
  });

  const parser = new VideoLogParser();
  const edges: EdgeFrameResult[] = [];
  let pendingBytes = Buffer.alloc(0);

  const videoRun = await runStream(
    t.ffmpegPath(),
    [
      '-hide_banner',
      '-nostats',
      '-nostdin',
      '-i',
      opts.video,
      '-filter_complex',
      filterGraph,
      '-map',
      '[m]',
      '-f',
      'null',
      '-',
      '-map',
      '[edges]',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      'pipe:1',
    ],
    t.env,
    {
      signal: opts.signal,
      onStdout: (chunk) => {
        const combined = pendingBytes.length > 0 ? Buffer.concat([pendingBytes, chunk]) : chunk;
        let offset = 0;
        while (offset + EdgeFrameBytes <= combined.length) {
          edges.push(analyzeEdgeFrame(combined, offset));
          offset += EdgeFrameBytes;
        }
        pendingBytes = offset < combined.length ? Buffer.from(combined.subarray(offset)) : Buffer.alloc(0);
      },
      onStderr: (chunk) => parser.feed(chunk.toString('utf8')),
    },
  );
  if (videoRun.error) {
    throw new Error(`全流帧检视频扫描失败：${opts.video}（${firstLine(videoRun.stderrTail || videoRun.error)}）`);
  }

  const totalFrames = Math.max(parser.frames.length, edges.length, media.video.nb_frames);
  const durationSeconds = totalFrames > 0 ? goRound((totalFrames / fps) * 1000) / 1000 : media.video.duration_seconds;
  parser.finish(durationSeconds, freezeSeconds);

  const issues: FrameQCIssue[] = buildVideoIssues({
    fps,
    totalFrames,
    scenes,
    frames: parser.frames,
    blacks: parser.blacks,
    freezes: parser.freezes,
    edges,
    freezeSeconds,
    freezeWarnMultiplier,
    freezeFailMultiplier,
    flashDelta,
    flashNeighborTolerance,
    flatRangeThreshold,
    minEdgeFrames,
  });

  let audioSummary: FrameQCAudioSummary | undefined;
  const shouldCheckAudio = opts.checkAudio !== false && media.audio !== null;
  if (shouldCheckAudio) {
    const audioDur = media.audio!.duration_seconds > 0 ? media.audio!.duration_seconds : durationSeconds;
    const silenceCheckSec = Math.min(silenceMinSeconds, Math.max(0.5, audioDur * 0.8));
    const ran = await t.runAsync(
      t.ffmpegPath(),
      [
        '-hide_banner',
        '-nostats',
        '-nostdin',
        '-i',
        opts.video,
        '-vn',
        '-af',
        `ebur128=peak=true,silencedetect=n=-50dB:d=${silenceCheckSec.toFixed(2)}`,
        '-f',
        'null',
        '-',
      ],
      { signal: opts.signal, captureStderr: true },
    );
    if (ran.error) throw new Error(`全流帧检音轨分析失败：${opts.video}（${commandError(ran)}）`);
    const parsedAudio = parseAudioQC(ran.stderr.toString('utf8'), audioDur, fps, totalFrames, scenes, {
      clipPeakDB: audioClipPeakDB,
      silenceMinSeconds,
    });
    audioSummary = parsedAudio.summary;
    issues.push(...parsedAudio.issues);
  }

  issues.sort((a, b) => a.start_frame - b.start_frame || a.end_frame - b.end_frame || a.kind.localeCompare(b.kind));
  const summary = summarizeFrameQC(issues);
  const videoSha256 = hashFileSha256(opts.video);
  const report: FrameQCReport = {
    schema_version: FrameQCSchemaVersion,
    path: opts.video,
    ...(videoSha256 ? { video_sha256: videoSha256 } : {}),
    fps,
    total_frames: totalFrames,
    duration_seconds: durationSeconds,
    scan_width: scanWidth,
    verdict: summary.verdict,
    summary,
    ...(audioSummary ? { audio: audioSummary } : {}),
    issues,
  };
  if (opts.outPath) writeFrameQCReportJSON(report, opts.outPath);
  return report;
}
