/**
 * 剪映可二次编辑素材包导出的公共类型定义。
 */

export const JianyingManifestSchema = 1;
export const JianyingAudioSampleRate = 48_000;
export const JianyingAudioChannels = 2;

export interface ExportJianyingOptions {
  /** 输出目录；留空时默认导出到 <project>/exports/jianying-<name>/。相对路径须落在项目根内。 */
  dest?: string;
  /** 素材包名称（用于默认目录名与草稿标题）；留空时取项目目录名。 */
  name?: string;
  /** 为 true 时额外生成通用剪映草稿骨架 draft_content.json 与 draft_meta_info.json（默认 false）。 */
  includeDraft?: boolean;
  /** 目标目录已存在且非空时是否允许覆盖（默认 false）。 */
  overwrite?: boolean;
  /** 外部命令查找环境（默认当前进程 envMap）。 */
  env?: Record<string, string>;
  /** 取消信号。 */
  signal?: AbortSignal;
}

export interface ShotEntry {
  index: number;
  scene_id: string;
  clip: string;
  source: string;
  start_frame: number;
  end_frame_exclusive: number;
  frames: number;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  start_us: number;
  duration_us: number;
  width_px: number;
  height_px: number;
  fps: number;
  codec: string;
  pixel_format: string;
  color_space: string;
  chapter?: string;
}

export interface ShotsManifest {
  schema: typeof JianyingManifestSchema;
  generator: 'onset-jianying-export';
  project: string;
  width_px: number;
  height_px: number;
  fps: number;
  total_frames: number;
  total_duration_seconds: number;
  total_duration_us: number;
  shots: ShotEntry[];
}

export interface AudioCueMeta {
  asset: string;
  start_frame: number;
  duration_frames: number;
  offset_seconds: number;
  duration_seconds: number;
  offset_us: number;
  duration_us: number;
  gain_db: number;
  fade_in_seconds: number;
  fade_out_seconds: number;
}

export interface AudioTrackEntry {
  id: string;
  role: 'voice' | 'bgm' | 'sfx';
  file: string;
  source: string;
  offset_seconds: number;
  offset_us: number;
  duration_seconds: number;
  duration_us: number;
  gain_db: number;
  fade_in_seconds: number;
  fade_out_seconds: number;
  cues?: AudioCueMeta[];
}

export interface AudioManifest {
  schema: typeof JianyingManifestSchema;
  sample_rate: number;
  channels: number;
  fps: number;
  total_frames: number;
  total_duration_seconds: number;
  total_duration_us: number;
  tracks: AudioTrackEntry[];
}

export interface JianyingDraftResult {
  draft_id: string;
  draft_content: string;
  draft_meta_info: string;
  duration_us: number;
  video_segments: number;
  audio_segments: number;
  text_segments: number;
  compatibility_note: string;
}

export interface ExportJianyingResult {
  output_dir: string;
  name: string;
  clips: string[];
  audio_tracks: string[];
  subtitles: string | null;
  shots_manifest: string;
  audio_manifest: string;
  readme: string;
  total_frames: number;
  total_duration_seconds: number;
  total_duration_us: number;
  fps: number;
  width_px: number;
  height_px: number;
  draft: JianyingDraftResult | null;
}
