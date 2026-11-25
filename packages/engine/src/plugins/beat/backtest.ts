/**
 * beat_av_backtest 操作的核心执行辅助：解析项目中的成片、源音乐、锚点表与可选 SFX 分轨/cue-sheet，
 * 交给 mediaprobe.runAVBacktest 完成真实 FFmpeg 成片音画回测并落盘 av-backtest.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as beat from '../../beat';
import { formatFixed } from '../../gofmt';
import {
  type AVBacktestAnchor,
  type AVBacktestReport,
  DefaultAVToleranceFrames,
  DefaultAVVisualWindowFrames,
  newToolchain,
  runAVBacktest,
  videoFPS,
} from '../../mediaprobe';
import * as scene from '../../scene';

export interface RunBeatAVBacktestParams {
  root: string;
  video?: string;
  sourceMusic?: string;
  anchors?: string;
  sfxStem?: string;
  cueSheet?: string;
  out?: string;
  fps?: number;
  toleranceFrames?: number;
  windowFrames?: number;
  env: Record<string, string>;
  signal?: AbortSignal;
}

function resolveProjectPath(root: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function loadSfxAssetMap(root: string, cueSheetPath?: string): Map<string, string> {
  const map = new Map<string, string>();
  const target = cueSheetPath
    ? resolveProjectPath(root, cueSheetPath)
    : path.join(root, 'production/audio/cue-sheet.json');
  if (!fs.existsSync(target)) return map;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as { cues?: Array<Record<string, unknown>> };
    for (const cue of parsed.cues ?? []) {
      if (cue.kind !== 'sfx' || typeof cue.asset !== 'string' || !cue.asset) continue;
      const absAsset = resolveProjectPath(root, cue.asset);
      if (!fs.existsSync(absAsset)) continue;
      if (typeof cue.cue_id === 'string' && cue.cue_id) map.set(cue.cue_id, absAsset);
    }
  } catch {
    // 非法或无关的默认 cue-sheet 不阻塞回测，显式传入时后续照常处理。
  }
  return map;
}

export async function runBeatAVBacktest(
  params: RunBeatAVBacktestParams,
): Promise<{ report: AVBacktestReport; reportPath: string }> {
  const root = path.resolve(params.root);
  const toolchain = newToolchain(params.env);
  const video = params.video
    ? resolveProjectPath(root, params.video)
    : path.join(root, 'production/audio/candidate.mp4');
  if (!fs.existsSync(video)) throw new Error(`找不到要回测的成片视频：${video}`);

  let sourceMusic = params.sourceMusic ? resolveProjectPath(root, params.sourceMusic) : '';
  if (!sourceMusic) {
    const track = beat.loadTrack(root);
    sourceMusic = beat.trackAudioPath(track, root);
  }
  if (!fs.existsSync(sourceMusic)) throw new Error(`找不到源音乐文件：${sourceMusic}`);

  let fps = params.fps && params.fps > 0 ? params.fps : 0;
  if (!(fps > 0) && fs.existsSync(path.join(root, 'frame.md'))) {
    try {
      fps = scene.canvasOf(root, 'frame.md').fps;
    } catch {
      // 退回由视频流探测帧率
    }
  }
  const media = toolchain.probe(video);
  if (!(fps > 0) && media.video) fps = videoFPS(media.video);
  if (!(fps > 0)) throw new Error(`无法确定成片帧率：${video}`);
  const totalFrames = media.video && media.video.nb_frames > 0 ? media.video.nb_frames : toolchain.countFrames(video);

  const anchorsPath = params.anchors ? resolveProjectPath(root, params.anchors) : path.join(root, beat.AnchorsFile);
  const rawAnchors = beat.readAnchorsFile(anchorsPath);
  let resolvedTable: beat.ResolvedAnchorTable;
  if (beat.enabled(root) && fs.existsSync(path.join(root, beat.GridFile))) {
    const grid = beat.loadGrid(root);
    const segments = fs.existsSync(path.join(root, beat.PlanFile))
      ? beat.layout(grid, beat.loadPlan(root), fps)
      : undefined;
    resolvedTable = beat.resolveAnchors(rawAnchors, { grid, segments, fps, totalFrames });
  } else {
    resolvedTable = beat.resolveAnchors(rawAnchors, { fps, totalFrames });
  }

  let sfxStem = params.sfxStem ? resolveProjectPath(root, params.sfxStem) : undefined;
  if (!sfxStem) {
    const defaultStem = path.join(root, 'production/audio/sfx.wav');
    if (fs.existsSync(defaultStem)) sfxStem = defaultStem;
  }
  const sfxAssets = loadSfxAssetMap(root, params.cueSheet);

  const backtestAnchors: AVBacktestAnchor[] = resolvedTable.anchors.map((a) => ({
    id: a.id,
    type: a.type,
    music_seconds: a.music_seconds,
    planned_frame: a.global_frame,
    ...(a.scene ? { scene: a.scene } : {}),
    ...(a.visual ? { visual: a.visual } : {}),
    ...(a.sfx.length > 0
      ? {
          sfx: a.sfx.map((s) => ({
            cue_id: s.cue_id,
            peak_seconds: s.peak_seconds,
            ...(sfxAssets.has(s.cue_id) ? { asset: sfxAssets.get(s.cue_id) } : {}),
          })),
        }
      : {}),
  }));

  let reportPath: string;
  if (!params.out) {
    reportPath = path.join(path.dirname(video), 'av-backtest.json');
  } else {
    const target = resolveProjectPath(root, params.out);
    reportPath = target.endsWith('.json') ? target : path.join(target, 'av-backtest.json');
  }

  const report = await runAVBacktest(toolchain, {
    video,
    sourceMusic,
    anchors: backtestAnchors,
    sfxStem,
    fps,
    toleranceFrames: params.toleranceFrames ?? DefaultAVToleranceFrames,
    windowFrames: params.windowFrames ?? DefaultAVVisualWindowFrames,
    outPath: reportPath,
    signal: params.signal,
  });
  return { report, reportPath };
}

export function formatAVBacktestSummary(report: AVBacktestReport, reportPath: string): string {
  const lines = [
    `成片音画回测完成：verdict=${report.verdict}（pass ${report.summary.pass} / fail ${report.summary.fail} / unverified ${report.summary.unverified}，容差 ±${report.tolerance_frames} 帧）`,
  ];
  if (report.measured_output_offset_seconds !== null) {
    lines.push(
      `建议输出校准值 measured_output_offset_seconds=${formatFixed(report.measured_output_offset_seconds, 4)} 秒（可靠音乐匹配 ${report.summary.reliable_music_matches} 个）`,
    );
  }
  for (const a of report.anchors) {
    const err = a.visual_error_frames !== undefined ? ` 画面误差 ${a.visual_error_frames} 帧` : '';
    const detail = a.reasons.length > 0 ? `（${a.reasons.join('；')}）` : '';
    lines.push(`  - [${a.status}] ${a.id}（计划第 ${a.planned_frame} 帧）${err}${detail}`);
  }
  lines.push(`报告：${reportPath}`);
  return lines.join('\n') + '\n';
}
