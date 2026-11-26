// 成片音画回测（FFmpeg 真实解码）：逐锚点定位音乐、画面与音效真实帧误差及输出偏移估算。
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import {
  computeMeasuredOutputOffset,
  DefaultAudioSampleRate,
  DefaultAudioSearchWindowSeconds,
  DefaultMaxOffsetSpreadSeconds,
  DefaultMinAudioCorrelation,
  DefaultMinReliableMatchesForOffset,
  DefaultMinVisualDelta,
  DefaultTemplateHalfSeconds,
  detectVisualPeak,
  locateEnergyPeakInStem,
  matchAudioTemplate,
  round2,
  round4,
} from './av_backtest_signal';
import {
  type AVBacktestAnchorReport,
  type AVBacktestOptions,
  type AVBacktestReport,
  type AVBacktestROI,
  AVBacktestSchemaVersion,
  type AVBacktestSfxResult,
  type AVBacktestVerdict,
  DefaultAVToleranceFrames,
  DefaultAVVisualWindowFrames,
  MaxAVToleranceFrames,
} from './av_backtest_types';
import { goRound } from './gofmt';
import { videoFPS } from './mediaprobe';
import { commandError } from './run';
import type { Toolchain } from './toolchain';

export type {
  AVBacktestAnchor,
  AVBacktestAnchorReport,
  AVBacktestOptions,
  AVBacktestReport,
  AVBacktestROI,
  AVBacktestSfxRef,
  AVBacktestSfxResult,
  AVBacktestSummary,
  AVBacktestVerdict,
} from './av_backtest_types';
export {
  AVBacktestSchemaVersion,
  DefaultAVToleranceFrames,
  DefaultAVVisualWindowFrames,
  MaxAVToleranceFrames,
} from './av_backtest_types';

const roiSampleSize = 64;

/** 原子写出 av-backtest.json。 */
export function writeAVBacktestReportJSON(report: AVBacktestReport, target: string): void {
  atomicWrite(target, Buffer.from(marshalIndent(report) + '\n', 'utf8'), 0o644);
}

/** 将媒体音轨完整解码为单声道 float32 PCM；alignTimeline=true 时按成片时间轴从 PTS=0 补齐起始偏移。 */
async function decodeMonoFloat32(
  t: Toolchain,
  file: string,
  sampleRate: number,
  signal?: AbortSignal,
  alignTimeline = false,
): Promise<Float32Array> {
  const ran = await t.runAsync(
    t.ffmpegPath(),
    [
      '-hide_banner',
      '-v',
      'error',
      '-nostdin',
      '-i',
      file,
      '-vn',
      ...(alignTimeline ? ['-af', 'aresample=async=1:first_pts=0'] : []),
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      'f32le',
      'pipe:1',
    ],
    { signal, captureStdout: true, captureStderr: true },
  );
  if (ran.error) throw new Error(`解码音频失败：${file}（${commandError(ran)}）`);
  const len = Math.floor(ran.stdout.byteLength / 4);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = ran.stdout.readFloatLE(i * 4);
  return out;
}

function roiToCropFilter(roi: AVBacktestROI | undefined, width: number, height: number): string {
  if (!roi) return '';
  const normalized = roi.x <= 1 && roi.y <= 1 && roi.w <= 1 && roi.h <= 1;
  const px = Math.round(normalized ? roi.x * width : roi.x);
  const py = Math.round(normalized ? roi.y * height : roi.y);
  const pw = Math.round(normalized ? roi.w * width : roi.w);
  const ph = Math.round(normalized ? roi.h * height : roi.h);
  const cx = Math.max(0, Math.min(width - 1, px));
  const cy = Math.max(0, Math.min(height - 1, py));
  const cw = Math.max(1, Math.min(width - cx, pw));
  const ch = Math.max(1, Math.min(height - cy, ph));
  return `crop=${cw}:${ch}:${cx}:${cy}:exact=1,`;
}

/** 精确解码成片第 [decodeStart, winEnd] 帧的 ROI 灰度小图（64×64）。 */
async function decodeROIWindowFrames(
  t: Toolchain,
  video: string,
  width: number,
  height: number,
  roi: AVBacktestROI | undefined,
  decodeStart: number,
  winEnd: number,
  signal?: AbortSignal,
): Promise<Uint8Array[]> {
  const count = winEnd - decodeStart + 1;
  if (count <= 0) return [];
  const crop = roiToCropFilter(roi, width, height);
  const filter = `trim=start_frame=${decodeStart}:end_frame=${winEnd + 1},setpts=PTS-STARTPTS,${crop}scale=${roiSampleSize}:${roiSampleSize}:flags=area,format=gray`;
  const ran = await t.runAsync(
    t.ffmpegPath(),
    [
      '-hide_banner',
      '-v',
      'error',
      '-nostdin',
      '-i',
      video,
      '-an',
      '-vf',
      filter,
      '-frames:v',
      String(count),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      'pipe:1',
    ],
    { signal, captureStdout: true, captureStderr: true },
  );
  if (ran.error) throw new Error(`解码成片画面窗口失败：${video}（${commandError(ran)}）`);
  const frameBytes = roiSampleSize * roiSampleSize;
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset + frameBytes <= ran.stdout.length; offset += frameBytes) {
    frames.push(new Uint8Array(ran.stdout.subarray(offset, offset + frameBytes)));
  }
  return frames;
}

/** 对成片执行逐锚点音画回测并返回结构化报告。 */
export async function runAVBacktest(t: Toolchain, opts: AVBacktestOptions): Promise<AVBacktestReport> {
  const toleranceFrames = opts.toleranceFrames ?? DefaultAVToleranceFrames;
  if (!Number.isSafeInteger(toleranceFrames) || toleranceFrames < 0 || toleranceFrames > MaxAVToleranceFrames) {
    throw new Error(`toleranceFrames 必须是 0..${MaxAVToleranceFrames} 的整数，收到 ${toleranceFrames}`);
  }
  const windowFrames = opts.windowFrames ?? DefaultAVVisualWindowFrames;
  if (!Number.isSafeInteger(windowFrames) || windowFrames < 1 || windowFrames > 30) {
    throw new Error(`windowFrames 必须是 1..30 的整数，收到 ${windowFrames}`);
  }

  const videoMedia = t.probe(opts.video);
  if (!videoMedia.video) throw new Error(`成片音画回测失败：视频没有视频流（${opts.video}）`);
  if (!videoMedia.audio) throw new Error(`成片音画回测失败：视频没有音轨（${opts.video}）`);
  const actualVideoFps = videoFPS(videoMedia.video);
  const fps = opts.fps && opts.fps > 0 ? opts.fps : actualVideoFps;
  if (!(fps > 0)) throw new Error(`成片音画回测需要有效帧率，无法从 ${opts.video} 确定`);
  const videoFps = actualVideoFps > 0 ? actualVideoFps : fps;

  const countedFrames = videoMedia.video.nb_frames > 0 ? videoMedia.video.nb_frames : t.countFrames(opts.video);
  const { width_px: width, height_px: height } = videoMedia.video;
  const sampleRate = DefaultAudioSampleRate;
  const searchWindowSeconds = opts.audioSearchWindowSeconds ?? DefaultAudioSearchWindowSeconds;
  const minAudioCorrelation = opts.minAudioCorrelation ?? DefaultMinAudioCorrelation;
  const minVisualDelta = opts.minVisualDelta ?? DefaultMinVisualDelta;

  const [sourcePCM, videoPCM] = await Promise.all([
    decodeMonoFloat32(t, opts.sourceMusic, sampleRate, opts.signal),
    decodeMonoFloat32(t, opts.video, sampleRate, opts.signal, true),
  ]);
  const sfxStemPCM = opts.sfxStem ? await decodeMonoFloat32(t, opts.sfxStem, sampleRate, opts.signal, true) : null;
  const sfxAssetCache = new Map<string, Float32Array>();
  const musicMatchCache = new Map<number, ReturnType<typeof matchAudioTemplate>>();
  const allSfxMoments = opts.anchors.flatMap((a) => (a.sfx ?? []).map(() => round4(a.planned_frame / fps)));

  const anchorReports: AVBacktestAnchorReport[] = [];
  const reliableOffsets: number[] = [];

  for (const anchor of opts.anchors) {
    opts.signal?.throwIfAborted();
    const plannedSeconds = round4(anchor.planned_frame / fps);
    const musicKey = round4(anchor.music_seconds);
    let music = musicMatchCache.get(musicKey);
    if (!music) {
      music = matchAudioTemplate(sourcePCM, videoPCM, {
        sampleRate,
        nominalSeconds: anchor.music_seconds,
        expectedTargetSeconds: anchor.music_seconds,
        templateHalfSeconds: DefaultTemplateHalfSeconds,
        searchWindowSeconds,
        minCorrelation: minAudioCorrelation,
      });
      musicMatchCache.set(musicKey, music);
      if (music.verified && music.offset_seconds !== undefined) reliableOffsets.push(music.offset_seconds);
    }

    const metric = anchor.visual?.metric ?? 'change';
    const roi = anchor.visual?.roi;
    const centerVideoFrame = videoFps === fps ? anchor.planned_frame : goRound(plannedSeconds * videoFps);
    const videoWindowFrames = videoFps === fps ? windowFrames : Math.max(1, goRound((windowFrames / fps) * videoFps));
    const winStart = Math.max(0, centerVideoFrame - videoWindowFrames);
    const winEnd = Math.min(countedFrames - 1, centerVideoFrame + videoWindowFrames);
    const decodeStart = Math.max(0, winStart - 1);
    const decodedFrames = await decodeROIWindowFrames(
      t,
      opts.video,
      width,
      height,
      roi,
      decodeStart,
      winEnd,
      opts.signal,
    );
    const visualBase = detectVisualPeak({
      frames: decodedFrames,
      decodeStart,
      winStart,
      winEnd,
      fps: videoFps,
      metric,
      minDelta: minVisualDelta,
    });
    const visual = roi ? { ...visualBase, roi } : visualBase;

    const reasons: string[] = [];
    if (!music.verified && music.reason) reasons.push(`音乐：${music.reason}`);
    if (!visual.verified && visual.reason) reasons.push(`画面：${visual.reason}`);

    let visualErrorSeconds: number | undefined;
    let visualErrorFrames: number | undefined;
    let visualStatus: AVBacktestVerdict = 'unverified';
    if (music.verified && visual.verified && music.actual_seconds !== undefined && visual.peak_seconds !== undefined) {
      visualErrorSeconds = round4(visual.peak_seconds - music.actual_seconds);
      visualErrorFrames = round2(visualErrorSeconds * fps);
      if (Math.abs(goRound(visualErrorFrames)) <= toleranceFrames) {
        visualStatus = 'pass';
      } else {
        visualStatus = 'fail';
        reasons.push(`画面相对音乐误差 ${visualErrorFrames} 帧，超过 ±${toleranceFrames} 帧容差`);
      }
    }

    const sfxResults: AVBacktestSfxResult[] = [];
    const sfxInWindow = allSfxMoments.filter((sec) => Math.abs(sec - plannedSeconds) <= searchWindowSeconds * 2).length;
    const anchorSfxList = anchor.sfx ?? [];
    for (const ref of anchorSfxList) {
      let sfxActual: number | undefined;
      let sfxCorr: number | undefined;
      let sfxReason: string | undefined;
      let sfxVerified = false;
      if (ref.asset) {
        // 检查同一锚点或重叠搜索窗内是否存在同源素材且相同 peak_seconds 的多条不可区分 cue，防止单次音效被重复判通过。
        const normAsset = path.resolve(ref.asset);
        const indistinguishable = opts.anchors.some(
          (other) =>
            Math.abs(other.planned_frame / fps - plannedSeconds) <= searchWindowSeconds * 2 &&
            (other.sfx ?? []).some(
              (o) =>
                o !== ref &&
                o.asset &&
                path.resolve(o.asset) === normAsset &&
                Math.abs(o.peak_seconds - ref.peak_seconds) < 1e-3,
            ),
        );
        if (indistinguishable) {
          sfxReason = '搜索窗口内存在多条同素材同峰值的音效 cue，无法独立归属单次匹配';
        } else {
          let assetPCM = sfxAssetCache.get(ref.asset);
          if (!assetPCM) {
            assetPCM = await decodeMonoFloat32(t, ref.asset, sampleRate, opts.signal);
            sfxAssetCache.set(ref.asset, assetPCM);
          }
          const matched = matchAudioTemplate(assetPCM, sfxStemPCM ?? videoPCM, {
            sampleRate,
            nominalSeconds: ref.peak_seconds,
            expectedTargetSeconds: plannedSeconds,
            templateHalfSeconds: 0.08,
            searchWindowSeconds,
            minCorrelation: minAudioCorrelation,
          });
          sfxVerified = matched.verified;
          sfxActual = matched.actual_seconds;
          sfxCorr = matched.correlation;
          sfxReason = matched.reason;
        }
      } else if (sfxStemPCM && sfxInWindow === 1) {
        const peak = locateEnergyPeakInStem(sfxStemPCM, sampleRate, plannedSeconds, searchWindowSeconds);
        sfxVerified = peak.verified;
        sfxActual = peak.actual_seconds;
        sfxReason = peak.reason;
      } else if (sfxStemPCM) {
        sfxReason = '窗口内存在多条音效 cue 且缺少源素材，分轨能量峰无法唯一归属';
      } else {
        sfxReason = '未提供 sfx.wav 或音效素材，无法独立定位音效峰值';
      }

      if (sfxVerified && music.verified && sfxActual !== undefined && music.actual_seconds !== undefined) {
        const errSec = round4(sfxActual - music.actual_seconds);
        const errFrames = round2(errSec * fps);
        const ok = Math.abs(goRound(errFrames)) <= toleranceFrames;
        if (!ok) reasons.push(`音效 ${ref.cue_id} 相对音乐误差 ${errFrames} 帧，超过 ±${toleranceFrames} 帧容差`);
        sfxResults.push({
          cue_id: ref.cue_id,
          peak_seconds: ref.peak_seconds,
          status: ok ? 'pass' : 'fail',
          verified: true,
          actual_seconds: sfxActual,
          sfx_error_seconds: errSec,
          sfx_error_frames: errFrames,
          ...(sfxCorr !== undefined ? { correlation: sfxCorr } : {}),
        });
      } else {
        if (sfxReason) reasons.push(`音效 ${ref.cue_id}：${sfxReason}`);
        sfxResults.push({
          cue_id: ref.cue_id,
          peak_seconds: ref.peak_seconds,
          status: 'unverified',
          verified: false,
          ...(sfxCorr !== undefined ? { correlation: sfxCorr } : {}),
          ...(sfxReason ? { reason: sfxReason } : {}),
        });
      }
    }

    const status: AVBacktestVerdict =
      visualStatus === 'fail' || sfxResults.some((s) => s.status === 'fail')
        ? 'fail'
        : visualStatus === 'unverified' || sfxResults.some((s) => s.status === 'unverified')
          ? 'unverified'
          : 'pass';

    anchorReports.push({
      id: anchor.id,
      type: anchor.type,
      ...(anchor.scene ? { scene: anchor.scene } : {}),
      music_seconds: anchor.music_seconds,
      planned_frame: anchor.planned_frame,
      planned_seconds: plannedSeconds,
      status,
      music,
      visual,
      ...(visualErrorSeconds !== undefined ? { visual_error_seconds: visualErrorSeconds } : {}),
      ...(visualErrorFrames !== undefined ? { visual_error_frames: visualErrorFrames } : {}),
      sfx: sfxResults,
      reasons,
    });
  }

  const pass = anchorReports.filter((a) => a.status === 'pass').length;
  const fail = anchorReports.filter((a) => a.status === 'fail').length;
  const unverified = anchorReports.filter((a) => a.status === 'unverified').length;
  const verdict: AVBacktestVerdict =
    anchorReports.length === 0 ? 'unverified' : fail > 0 ? 'fail' : unverified > 0 ? 'unverified' : 'pass';
  const { measured_output_offset_seconds, spread_seconds } = computeMeasuredOutputOffset(
    reliableOffsets,
    DefaultMinReliableMatchesForOffset,
    DefaultMaxOffsetSpreadSeconds,
  );

  const report: AVBacktestReport = {
    schema_version: AVBacktestSchemaVersion,
    video: opts.video,
    source_music: opts.sourceMusic,
    fps,
    total_frames: countedFrames,
    tolerance_frames: toleranceFrames,
    window_frames: windowFrames,
    verdict,
    measured_output_offset_seconds,
    summary: {
      total: anchorReports.length,
      pass,
      fail,
      unverified,
      reliable_music_matches: reliableOffsets.length,
      music_offset_spread_seconds: spread_seconds,
    },
    anchors: anchorReports,
  };
  if (opts.outPath) writeAVBacktestReportJSON(report, opts.outPath);
  return report;
}
