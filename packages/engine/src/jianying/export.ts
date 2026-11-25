/**
 * 剪映可二次编辑素材包导出：
 * - clips/shot-01.mp4 ...：按时间轴精确重编码切镜（libx264 crf 18 + yuv420p + bt709 + 首帧关键帧，绝不 -c copy），无声纯画面轨；
 * - audio/：分轨音频 voice.wav、bgm.wav（如有）、sfx.wav（如有），48kHz 立体声 PCM16 与视频时间轴严格对齐；
 * - subtitles.srt：如工程有字幕时间轴则同步导出；
 * - shots.json & audio.json：镜序、进出点、帧号、微秒时间码与每轨偏移/增益/淡入淡出；
 * - README.md：剪映一键拼回与二次精修指南；
 * - includeDraft=true 时额外生成通用剪映草稿骨架 draft_content.json 与 draft_meta_info.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '../envutil';
import { atomicWrite, removeTree } from '../fsutil';
import { goRound } from '../gofmt';
import { marshalIndent } from '../gojson';
import { newToolchain, videoFPS } from '../mediaprobe';
import { collectProjectSources, type DiscoveredAudioStem, resolveExportDir, sanitizeBundleName } from './collect';
import { buildJianyingDraft } from './draft';
import {
  buildCueMetas,
  buildReadme,
  encodeShotClip,
  exportAlignedStemFile,
  exportCueSynthesizedStem,
  framesToUs,
  roundSeconds,
} from './media';
import {
  type AudioManifest,
  type AudioTrackEntry,
  type ExportJianyingOptions,
  type ExportJianyingResult,
  JianyingAudioChannels,
  JianyingAudioSampleRate,
  JianyingManifestSchema,
  type ShotEntry,
  type ShotsManifest,
} from './types';

/** 将片场工程一键导出为剪映可二次编辑分镜分轨素材包。 */
export async function exportJianying(
  projectRoot: string,
  opts: ExportJianyingOptions = {},
): Promise<ExportJianyingResult> {
  const sources = collectProjectSources(projectRoot);
  const name = sanitizeBundleName(opts.name?.trim() || path.basename(sources.root));
  const finalDir = resolveExportDir(sources.root, opts.dest, name, Boolean(opts.overwrite));
  const toolchain = newToolchain(opts.env ?? envMap());

  // 从首个视频源补齐画幅与帧率（若 frame.md 缺失）。
  const firstProbe = toolchain.probe(sources.shots[0].sourceFile);
  if (!firstProbe.video) throw new Error(`源视频缺少视频流：${sources.shots[0].sourceRel}`);
  const fps = sources.fps ?? (videoFPS(firstProbe.video) || 30);
  const widthPx = sources.widthPx ?? firstProbe.video.width_px;
  const heightPx = sources.heightPx ?? firstProbe.video.height_px;

  fs.mkdirSync(path.dirname(finalDir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(finalDir), '.onset-jianying-'));
  try {
    const padWidth = sources.shots.length >= 100 ? 3 : 2;
    const shotEntries: ShotEntry[] = [];
    const clipPaths: string[] = [];
    let cumulativeFrames = 0;

    for (let i = 0; i < sources.shots.length; i++) {
      opts.signal?.throwIfAborted();
      const s = sources.shots[i];
      const clipRel = `clips/shot-${String(i + 1).padStart(padWidth, '0')}.mp4`;
      const clipDest = path.join(staging, ...clipRel.split('/'));
      const trim =
        s.trimStartFrame !== undefined && s.trimEndFrame !== undefined
          ? { startFrame: s.trimStartFrame, endFrame: s.trimEndFrame }
          : undefined;
      await encodeShotClip(toolchain, s.sourceFile, clipDest, fps, trim, opts.signal);

      const probed = toolchain.probe(clipDest);
      const actualFrames = toolchain.countFrames(clipDest);
      if (!probed.video) throw new Error(`导出的分镜缺少视频流：${clipRel}`);

      const startFrame = cumulativeFrames;
      const endFrame = startFrame + actualFrames;
      const startUs = framesToUs(startFrame, fps);
      const endUs = framesToUs(endFrame, fps);
      cumulativeFrames = endFrame;

      shotEntries.push({
        index: i + 1,
        scene_id: s.sceneId,
        clip: clipRel,
        source: s.sourceRel,
        start_frame: startFrame,
        end_frame_exclusive: endFrame,
        frames: actualFrames,
        start_seconds: roundSeconds(startFrame / fps),
        end_seconds: roundSeconds(endFrame / fps),
        duration_seconds: roundSeconds(actualFrames / fps),
        start_us: startUs,
        duration_us: endUs - startUs,
        width_px: probed.video.width_px,
        height_px: probed.video.height_px,
        fps: Math.round(videoFPS(probed.video) * 1000) / 1000 || fps,
        codec: probed.video.codec,
        pixel_format: probed.video.pixel_format,
        color_space: 'bt709',
        ...(s.chapter ? { chapter: s.chapter } : {}),
      });
      clipPaths.push(clipRel);
    }

    const totalFrames = cumulativeFrames;
    const totalDurationUs = framesToUs(totalFrames, fps);
    const totalDurationSeconds = roundSeconds(totalFrames / fps);
    const totalSamples = goRound((totalFrames / fps) * JianyingAudioSampleRate);

    const shotsManifest: ShotsManifest = {
      schema: JianyingManifestSchema,
      generator: 'onset-jianying-export',
      project: name,
      width_px: widthPx,
      height_px: heightPx,
      fps,
      total_frames: totalFrames,
      total_duration_seconds: totalDurationSeconds,
      total_duration_us: totalDurationUs,
      shots: shotEntries,
    };

    const audioTracks: AudioTrackEntry[] = [];
    const audioFiles: string[] = [];
    const exportStem = async (stem: DiscoveredAudioStem): Promise<void> => {
      opts.signal?.throwIfAborted();
      const rel = `audio/${stem.role}.wav`;
      const dest = path.join(staging, ...rel.split('/'));
      if (stem.file) {
        await exportAlignedStemFile(toolchain, stem.file, dest, totalSamples, opts.signal);
      } else if (stem.cues.length > 0) {
        await exportCueSynthesizedStem(toolchain, stem.cues, dest, fps, totalSamples, opts.signal);
      } else {
        return;
      }
      const cueMetas = buildCueMetas(stem.cues, fps);
      const firstCue = cueMetas[0];
      audioTracks.push({
        id: stem.role,
        role: stem.role,
        file: rel,
        source: stem.sourceRel,
        offset_seconds: 0,
        offset_us: 0,
        duration_seconds: totalDurationSeconds,
        duration_us: totalDurationUs,
        gain_db: stem.file ? 0 : (firstCue?.gain_db ?? 0),
        fade_in_seconds: stem.file ? 0 : (firstCue?.fade_in_seconds ?? 0),
        fade_out_seconds: stem.file ? 0 : (firstCue?.fade_out_seconds ?? 0),
        ...(cueMetas.length > 0 ? { cues: cueMetas } : {}),
      });
      audioFiles.push(rel);
    };

    for (const stem of sources.audio) {
      await exportStem(stem);
    }

    const audioManifest: AudioManifest = {
      schema: JianyingManifestSchema,
      sample_rate: JianyingAudioSampleRate,
      channels: JianyingAudioChannels,
      fps,
      total_frames: totalFrames,
      total_duration_seconds: totalDurationSeconds,
      total_duration_us: totalDurationUs,
      tracks: audioTracks,
    };

    let subtitlesRel: string | null = null;
    if (sources.subtitleFile) {
      const srtText = fs.readFileSync(sources.subtitleFile, 'utf8');
      atomicWrite(path.join(staging, 'subtitles.srt'), srtText, 0o644);
      subtitlesRel = 'subtitles.srt';
    }

    atomicWrite(path.join(staging, 'shots.json'), marshalIndent(shotsManifest, '  ', false) + '\n', 0o644);
    atomicWrite(path.join(staging, 'audio.json'), marshalIndent(audioManifest, '  ', false) + '\n', 0o644);

    let draftResult = null;
    if (opts.includeDraft) {
      draftResult = buildJianyingDraft({
        finalDir,
        writeDir: staging,
        name,
        shots: shotsManifest,
        audio: audioManifest,
        subtitles: sources.subtitles,
      });
    }

    const readmeBody = buildReadme(
      name,
      shotsManifest,
      audioManifest,
      subtitlesRel !== null,
      Boolean(opts.includeDraft),
    );
    atomicWrite(path.join(staging, 'README.md'), readmeBody, 0o644);

    opts.signal?.throwIfAborted();
    if (fs.existsSync(finalDir)) removeTree(finalDir);
    fs.renameSync(staging, finalDir);

    return {
      output_dir: finalDir,
      name,
      clips: clipPaths,
      audio_tracks: audioFiles,
      subtitles: subtitlesRel,
      shots_manifest: 'shots.json',
      audio_manifest: 'audio.json',
      readme: 'README.md',
      total_frames: totalFrames,
      total_duration_seconds: totalDurationSeconds,
      total_duration_us: totalDurationUs,
      fps,
      width_px: widthPx,
      height_px: heightPx,
      draft: draftResult,
    };
  } catch (err) {
    removeTree(staging);
    throw err;
  }
}
