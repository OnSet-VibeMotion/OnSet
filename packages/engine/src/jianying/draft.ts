/**
 * 剪映通用草稿骨架生成器（draft_content.json + draft_meta_info.json）。
 *
 * 按通用剪映草稿结构生成 materials（videos / audios / texts）与三条轨道（video / audio / text），
 * 微秒级时间码严格与 shots.json、audio.json、subtitles.srt 及视频总时长自洽。
 * 如实注明未绑定特定剪映宿主版本。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goRound } from '../gofmt';
import { marshalIndent } from '../gojson';
import type * as srt from '../srt';
import type { AudioManifest, JianyingDraftResult, ShotsManifest } from './types';

export const DraftCompatibilityNote =
  '按通用剪映草稿 JSON 结构生成，未绑定特定剪映宿主版本；如目标客户端版本存在字段差异，请按 README.md 直接导入 clips/、audio/ 与 subtitles.srt 拼回时间轴。';

/** 从稳定种子生成大写 UUID 格式 ID，确保草稿可复现且引用严格一一对应。 */
function stableUUID(seed: string): string {
  const hex = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function dbToLinear(gainDB: number): number {
  const linear = 10 ** (gainDB / 20);
  return Math.round(Math.min(4, Math.max(0, linear)) * 10000) / 10000;
}

export interface BuildDraftInput {
  /** 最终落盘目录（用于写入 draft 内素材绝对路径）。 */
  finalDir: string;
  /** 当前写入目录（staging 目录或 finalDir）。 */
  writeDir: string;
  name: string;
  shots: ShotsManifest;
  audio: AudioManifest;
  subtitles: readonly srt.Cue[];
}

/** 生成结构自洽的 draft_content.json 与 draft_meta_info.json。 */
export function buildJianyingDraft(input: BuildDraftInput): JianyingDraftResult {
  const { finalDir, writeDir, name, shots, audio, subtitles } = input;
  const draftId = stableUUID(`draft:${name}:${shots.total_frames}:${shots.fps}`);
  const totalUs = shots.total_duration_us;
  const nowUs = Date.now() * 1000;

  const videoMaterials: Array<Record<string, unknown>> = [];
  const videoSegments: Array<Record<string, unknown>> = [];

  for (const shot of shots.shots) {
    const matId = stableUUID(`video-mat:${shot.index}:${shot.scene_id}`);
    const segId = stableUUID(`video-seg:${shot.index}:${shot.scene_id}`);
    videoMaterials.push({
      id: matId,
      type: 'video',
      material_name: path.basename(shot.clip),
      path: path.join(finalDir, ...shot.clip.split('/')),
      relative_path: shot.clip,
      width: shot.width_px,
      height: shot.height_px,
      duration: shot.duration_us,
      has_audio: false,
      scene_id: shot.scene_id,
    });
    videoSegments.push({
      id: segId,
      material_id: matId,
      source_timerange: { start: 0, duration: shot.duration_us },
      target_timerange: { start: shot.start_us, duration: shot.duration_us },
      speed: 1,
      volume: 0,
      visible: true,
    });
  }

  const audioMaterials: Array<Record<string, unknown>> = [];
  const audioSegments: Array<Record<string, unknown>> = [];

  for (let i = 0; i < audio.tracks.length; i++) {
    const track = audio.tracks[i];
    const matId = stableUUID(`audio-mat:${i}:${track.id}`);
    const segId = stableUUID(`audio-seg:${i}:${track.id}`);
    const clampedStart = Math.max(0, Math.min(totalUs, track.offset_us));
    const clampedDuration = Math.max(0, Math.min(totalUs - clampedStart, track.duration_us));
    audioMaterials.push({
      id: matId,
      type: track.role === 'bgm' ? 'music' : 'sound',
      role: track.role,
      name: path.basename(track.file),
      path: path.join(finalDir, ...track.file.split('/')),
      relative_path: track.file,
      duration: clampedDuration,
    });
    audioSegments.push({
      id: segId,
      material_id: matId,
      role: track.role,
      source_timerange: { start: 0, duration: clampedDuration },
      target_timerange: { start: clampedStart, duration: clampedDuration },
      speed: 1,
      volume: dbToLinear(track.gain_db),
      visible: true,
    });
  }

  const textMaterials: Array<Record<string, unknown>> = [];
  const textSegments: Array<Record<string, unknown>> = [];

  for (const cue of subtitles) {
    const startUs = Math.max(0, Math.min(totalUs, goRound(cue.start_seconds * 1_000_000)));
    const endUs = Math.max(startUs, Math.min(totalUs, goRound(cue.end_seconds * 1_000_000)));
    const durationUs = endUs - startUs;
    if (durationUs <= 0) continue;
    const matId = stableUUID(`text-mat:${cue.index}:${startUs}:${endUs}`);
    const segId = stableUUID(`text-seg:${cue.index}:${startUs}:${endUs}`);
    textMaterials.push({
      id: matId,
      type: 'subtitle',
      plain_text: cue.text,
      content: JSON.stringify({
        text: cue.text,
        styles: [{ fill: { content: { solid: { color: [1, 1, 1] } } }, size: 8, range: [0, cue.text.length] }],
      }),
    });
    textSegments.push({
      id: segId,
      material_id: matId,
      source_timerange: { start: 0, duration: durationUs },
      target_timerange: { start: startUs, duration: durationUs },
      visible: true,
    });
  }

  const draftContent = {
    id: draftId,
    version: 360000,
    new_version: '110.0.0',
    platform: { app_id: 3704, app_source: 'lv', os: 'generic' },
    compatibility_note: DraftCompatibilityNote,
    canvas_config: {
      width: shots.width_px,
      height: shots.height_px,
      ratio: 'original',
    },
    fps: shots.fps,
    duration: totalUs,
    materials: {
      videos: videoMaterials,
      audios: audioMaterials,
      texts: textMaterials,
    },
    tracks: [
      {
        id: stableUUID(`track:video:${name}`),
        type: 'video',
        attribute: 0,
        flag: 0,
        segments: videoSegments,
      },
      {
        id: stableUUID(`track:audio:${name}`),
        type: 'audio',
        attribute: 0,
        flag: 0,
        segments: audioSegments,
      },
      {
        id: stableUUID(`track:text:${name}`),
        type: 'text',
        attribute: 0,
        flag: 0,
        segments: textSegments,
      },
    ],
  };

  const draftMeta = {
    draft_id: draftId,
    draft_name: name,
    draft_fold_path: finalDir,
    draft_root_path: path.dirname(finalDir),
    tm_duration: totalUs,
    tm_draft_create: nowUs,
    tm_draft_modified: nowUs,
    compatibility_note: DraftCompatibilityNote,
    draft_materials: [
      { type: 0, value: videoMaterials.map((m) => ({ id: m.id, file_Path: m.path, duration: m.duration })) },
      { type: 1, value: audioMaterials.map((m) => ({ id: m.id, file_Path: m.path, duration: m.duration })) },
      { type: 2, value: textMaterials.map((m) => ({ id: m.id, text: m.plain_text })) },
    ],
  };

  atomicWrite(path.join(writeDir, 'draft_content.json'), marshalIndent(draftContent, '  ', false) + '\n', 0o644);
  atomicWrite(path.join(writeDir, 'draft_meta_info.json'), marshalIndent(draftMeta, '  ', false) + '\n', 0o644);

  return {
    draft_id: draftId,
    draft_content: 'draft_content.json',
    draft_meta_info: 'draft_meta_info.json',
    duration_us: totalUs,
    video_segments: videoSegments.length,
    audio_segments: audioSegments.length,
    text_segments: textSegments.length,
    compatibility_note: DraftCompatibilityNote,
  };
}
