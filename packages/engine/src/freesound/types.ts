/**
 * Freesound API v2 音效检索、下载与安全增益分析类型与常量定义。
 */
import type { Toolchain } from '../mediaprobe';

export const FreesoundApiBaseUrl = 'https://freesound.org/apiv2';
export const FreesoundApiKeyEnv = 'FREESOUND_API_KEY';
export const SfxAssetsRelDir = 'assets/sfx';
export const SfxManifestFile = 'audio-manifest.json';
export const DefaultMaxSfxBytes = 32 * 1024 * 1024;
export const DefaultSearchLimit = 10;
export const MaxSearchLimit = 50;
export const DefaultTargetRmsDB = -16.0;
export const DefaultPeakCeilingDB = -1.0;

/** 注入式 fetch 签名，支持测试环境 100% 离线 mock。 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 缺少或无效的 FREESOUND_API_KEY 错误。 */
export class FreesoundApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreesoundApiKeyError';
  }
}

export type FreesoundSort =
  | 'score'
  | 'duration_desc'
  | 'duration_asc'
  | 'created_desc'
  | 'created_asc'
  | 'downloads_desc'
  | 'rating_desc';

export type FreesoundDownloadQuality = 'preview-hq-mp3' | 'preview-hq-ogg' | 'preview-lq-mp3' | 'original';

export interface FreesoundClientOptions {
  /** 显式传入的 API Key；未传时读取 env.FREESOUND_API_KEY 或 process.env.FREESOUND_API_KEY。 */
  apiKey?: string;
  /** 可选环境变量映射，便于测试与调用方隔离环境。 */
  env?: Record<string, string | undefined>;
  /** 可选 fetch 实现，用于离线测试 mock。 */
  fetch?: FetchLike;
  /** 可选 API 根地址覆盖，默认 https://freesound.org/apiv2。 */
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface FreesoundSearchOptions extends FreesoundClientOptions {
  query: string;
  minDuration?: number;
  maxDuration?: number;
  /** 许可证过滤：支持 'CC0'、'CC-BY'、'CC-BY-NC'、逗号分隔组合（如 'CC0,CC-BY'）或数组。 */
  license?: string | readonly string[];
  limit?: number;
  page?: number;
  sort?: FreesoundSort;
}

export interface FreesoundSoundItem {
  id: number;
  name: string;
  duration: number;
  username: string;
  license: string;
  license_short: string;
  url: string;
  tags: string[];
  description: string;
  type: string;
  filesize: number;
  samplerate: number;
  channels: number;
  avg_rating: number;
  num_downloads: number;
  preview_hq_mp3?: string;
  preview_hq_ogg?: string;
  preview_lq_mp3?: string;
  download_url?: string;
}

export interface FreesoundSearchResult {
  query: string;
  filter: string;
  count: number;
  page: number;
  limit: number;
  results: FreesoundSoundItem[];
}

export interface AudioGainAnalysis {
  measured: boolean;
  /** true 表示真峰值已实测（WAV 4× 过采样或 EBU R128）；false 表示仅回退到样本峰值，不保证满足压缩音频采样间真峰上限。 */
  true_peak_measured?: boolean;
  method: 'wav-pcm' | 'mediaprobe-ffmpeg' | 'unavailable';
  rms_db: number;
  target_rms_db: number;
  suggested_gain_db: number;
  sample_peak_db: number;
  true_peak_dbtp: number;
  ceiling_db: number;
  safe_gain_db: number;
  projected_peak_db: number;
  clamped: boolean;
  clipping_warning?: string;
  note?: string;
}

export interface AudioManifestEntry {
  id: string;
  freesound_id: number;
  name: string;
  file: string;
  bytes: number;
  sha256: string;
  source_url: string;
  download_url: string;
  author: string;
  license: string;
  license_short: string;
  attribution: string;
  duration_seconds: number;
  quality: FreesoundDownloadQuality;
  gain: AudioGainAnalysis;
}

export interface AudioManifest {
  version: 1;
  entries: AudioManifestEntry[];
}

export interface FreesoundDownloadOptions extends FreesoundClientOptions {
  quality?: FreesoundDownloadQuality;
  /** 可选自定义文件名前缀（自动清洗防路径穿越）。 */
  name?: string;
  /** 目标 RMS 电平（dBFS），默认 -16 dB。 */
  targetRmsDb?: number;
  /** 真峰值与样本峰值安全上限（dBFS / dBTP），默认 -1.0 dB。 */
  ceilingDb?: number;
  /** 单文件最大体积字节上限，默认 32 MB。 */
  maxBytes?: number;
  /** 可选已获取的音效元数据，传入时跳过 /sounds/<id>/ 请求。 */
  sound?: FreesoundSoundItem;
  /** 可选 mediaprobe Toolchain，供非 WAV 格式（MP3/OGG）测量响度。 */
  toolchain?: Toolchain;
}

export interface FreesoundDownloadResult {
  entry: AudioManifestEntry;
  file_path: string;
  manifest_path: string;
  deduplicated: boolean;
}
