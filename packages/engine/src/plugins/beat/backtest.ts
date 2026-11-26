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

function loadSfxAssetMap(root: string, table: beat.ResolvedAnchorTable, cueSheetPath?: string): Map<string, string> {
  const map = new Map<string, string>();
  const explicit = Boolean(cueSheetPath);
  const target = cueSheetPath
    ? resolveProjectPath(root, cueSheetPath)
    : path.join(root, 'production/audio/cue-sheet.json');
  if (!fs.existsSync(target)) {
    if (explicit) throw new Error(`找不到指定的 cue sheet：${target}`);
    return map;
  }
  let parsed: { cues?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as { cues?: unknown };
  } catch (err) {
    if (explicit) throw new Error(`cue sheet 解析失败：${target}（${(err as Error).message}）`);
    return map;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cues)) {
    if (explicit) throw new Error(`cue sheet 格式无效（缺少 cues 数组）：${target}`);
    return map;
  }
  const bindCue = (cueId: string, absAsset: string, sourceDesc: string) => {
    const prev = map.get(cueId);
    if (prev && prev !== absAsset) {
      throw new Error(`cue sheet 中音效 ${cueId}（${sourceDesc}）绑定了多个不同素材，无法唯一确定`);
    }
    map.set(cueId, absAsset);
  };
  for (let i = 0; i < parsed.cues.length; i++) {
    const raw = parsed.cues[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (explicit) throw new Error(`cue sheet 第 ${i + 1} 条 cue 不是对象`);
      continue;
    }
    const cue = raw as Record<string, unknown>;
    if (cue.kind !== 'sfx') continue;
    if (typeof cue.asset !== 'string' || !cue.asset.trim()) {
      if (explicit) throw new Error(`cue sheet 第 ${i + 1} 条音效缺少有效的 asset 字段`);
      continue;
    }
    const absAsset = resolveProjectPath(root, cue.asset);
    if (!fs.existsSync(absAsset)) {
      if (explicit) throw new Error(`cue sheet 第 ${i + 1} 条音效素材不存在：${absAsset}`);
      continue;
    }
    if (typeof cue.cue_id === 'string' && cue.cue_id) {
      bindCue(cue.cue_id, absAsset, `cue_id=${cue.cue_id}`);
      continue;
    }
    if (typeof cue.anchor_id === 'string' && cue.anchor_id) {
      const anchor = table.by_id[cue.anchor_id];
      if (!anchor) {
        if (explicit) throw new Error(`cue sheet 第 ${i + 1} 条引用了未知锚点：${cue.anchor_id}`);
        continue;
      }
      if (anchor.sfx.length === 1) {
        bindCue(anchor.sfx[0].cue_id, absAsset, `anchor_id=${cue.anchor_id}`);
      } else if (anchor.sfx.length > 1) {
        throw new Error(
          `cue sheet 第 ${i + 1} 条通过 anchor_id=${cue.anchor_id} 绑定，但该锚点有 ${anchor.sfx.length} 条音效，请显式填写 cue_id`,
        );
      }
      continue;
    }
    if (typeof cue.anchor_frame === 'number' && Number.isSafeInteger(cue.anchor_frame)) {
      const matches = table.anchors.filter((a) => a.global_frame === cue.anchor_frame && a.sfx.length > 0);
      const totalCues = matches.reduce((sum, a) => sum + a.sfx.length, 0);
      if (totalCues === 1) {
        bindCue(matches[0].sfx[0].cue_id, absAsset, `anchor_frame=${cue.anchor_frame}`);
      } else if (totalCues > 1) {
        throw new Error(
          `cue sheet 第 ${i + 1} 条通过 anchor_frame=${cue.anchor_frame} 绑定，但该帧有 ${totalCues} 条音效，请显式填写 cue_id`,
        );
      }
    }
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
  const sfxAssets = loadSfxAssetMap(root, resolvedTable, params.cueSheet);

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
