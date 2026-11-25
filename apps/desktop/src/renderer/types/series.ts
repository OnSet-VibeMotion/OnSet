export interface SeriesDefaults {
  canvas?: string;
  delivery?: string;
  narration?: string;
  film_style?: string;
  extra_film_styles?: string[];
  tts_voice?: string;
  brand_kit_id?: string;
  orchestrator?: string;
  renderer?: string;
}

export interface SeriesItem {
  schema: 1;
  id: string;
  name: string;
  description?: string;
  accent?: string;
  parent_dir?: string;
  naming_pattern?: string;
  next_episode: number;
  defaults: SeriesDefaults;
  brief: string;
  publish_template?: SeriesPublishTemplate;
  project_count: number;
  created_at: string;
  updated_at: string;
}

export type SeriesAssistMode = 'draft' | 'refine' | 'polish_brief';

export interface SeriesPublishTemplateDraft {
  title_pattern?: string;
  default_hashtags?: string[];
  description_footer?: string;
  cover_guidelines?: string;
  credits_lines?: string[];
}

export interface SeriesAssistDraft {
  name?: string;
  description?: string;
  naming_pattern?: string;
  defaults?: SeriesDefaults;
  brief?: string;
  publish_template?: SeriesPublishTemplateDraft;
}

export interface SeriesAssistResponse {
  mode: SeriesAssistMode;
  name?: string;
  description?: string;
  naming_pattern?: string;
  defaults: SeriesDefaults;
  brief: string;
  publish_template?: SeriesPublishTemplateDraft;
  rationale: string;
  followups: string[];
  warnings: string[];
  tool?: string;
  model?: string;
}

export interface SeriesListResponse {
  dir: string;
  series: SeriesItem[];
}

export type SeriesAssetKind = 'shared' | 'cast' | 'bumper' | 'audio' | 'cover' | 'directions' | 'publish_template';
export type SeriesSyncState = 'missing' | 'synced' | 'update_available' | 'local_modified' | 'conflict';

export interface SeriesPublishTemplate {
  schema: 1;
  title_pattern?: string;
  default_hashtags?: string[];
  description_footer?: string;
  cover_guidelines?: string;
  credits_lines?: string[];
  updated_at: string;
}

export interface SeriesAssetEntry {
  key: string;
  kind: SeriesAssetKind;
  name: string;
  target_path: string;
  digest: string;
  files: number;
  bytes: number;
  bumper_mode?: 'video' | 'template';
}

export interface AssetSyncStatus extends SeriesAssetEntry {
  status: SeriesSyncState;
  local_digest: string;
  synced_digest: string;
}

export interface ProjectAssetCandidate {
  kind: 'shared' | 'cast' | 'bumper' | 'audio' | 'cover';
  name: string;
  from: string;
}

export interface SeriesAssetsResponse {
  series_id: string;
  assets: SeriesAssetEntry[];
  publish_template: SeriesPublishTemplate | null;
  current_project_bound: boolean;
  sync_status: AssetSyncStatus[];
  project_candidates: ProjectAssetCandidate[];
}
