import type { PageGate } from './project';

export interface BeatGrid {
  /** draft：还没确认（或与正式网格不同）的草稿；confirmed：正式网格。 */
  kind: 'draft' | 'confirmed';
  source: string;
  duration_seconds: number;
  beats: number[];
  downbeats: number[];
}

export interface BeatPlanSegment {
  id: string;
  first_bar: number;
  bars: number;
  start_seconds: number;
  end_seconds: number;
}

export interface BeatState {
  enabled: boolean;
  draft: boolean;
  click: boolean;
  confirmed: boolean;
  click_path: string;
  music_path?: string;
  track?: { source: string; duration_seconds: number };
  draft_pending?: boolean;
  fps?: number;
  grid?: BeatGrid;
  grid_error?: string;
  problems?: string[];
  plan?: BeatPlanSegment[];
  plan_error?: string;
  /** 故事与文案：production/beat/story.md。 */
  story?: { path: string; content: string; mtime: number };
  /** 节拍分析环境：没就绪时 command 是要在终端里跑的 onset setup --only beat。 */
  analyzer?: { ready: boolean; location: string; command?: string };
}

/** 某个风格来源里的一种风格（/api/film-styles）。key 是「来源/目录名」。 */
export interface FilmStyle {
  source: string;
  slug: string;
  order: string;
  cn: string;
  en: string;
  category_cn: string;
  category_en: string;
  uses: string[];
  summary: string;
  tags?: string[];
}

/** 一个风格来源。ready 为 false 时来源数据还没由 onset setup 准备好。 */
export interface FilmStyleSource {
  id: string;
  name: string;
  gallery?: string;
  categories: string[];
  ready: boolean;
  problem?: string;
}

export interface FilmStylesResponse {
  sources: FilmStyleSource[];
  styles: FilmStyle[];
}

export interface FilmStyleManifest {
  source: string;
  slug: string;
  cn: string;
  en: string;
  version: string;
  digest: string;
  installed_at: string;
}

/** 项目里装的一种风格（默认或额外）。 */
export interface InstalledFilmStyle {
  manifest: FilmStyleManifest;
  style?: FilmStyle;
  /** STYLE.md 在项目里的相对路径。 */
  style_file: string;
  /** 用这种风格的镜头 id。 */
  scenes: string[];
}

/** 本项目的风格（/api/film-style）：默认风格的字段沿用只有一种风格时的写法。 */
export interface ProjectFilmStyle {
  installed: boolean;
  manifest?: FilmStyleManifest;
  style?: FilmStyle;
  style_file?: string;
  /** 用默认风格的镜头（不写 film_style 或点名默认风格）。 */
  default_scenes?: string[];
  /** 个别镜头点名用的额外风格。 */
  extras?: InstalledFilmStyle[];
  /** 每个镜头 scene.json 的 film_style：没有表示默认风格，none 表示不用整片风格。 */
  scenes?: Array<{ id: string; film_style?: string }>;
  /** 点名了却没装进项目的风格，渲染会失败。 */
  missing?: Array<{ scene: string; style: string }>;
}

/** /api/script：口播稿。final 为 false 时是原稿，只有 content。 */
export interface ScriptNode {
  kind: 'text' | 'alt' | 'phrase';
  text?: string;
  spoken?: string;
  id?: string;
  children?: ScriptNode[];
  timings?: ({ start: number; end: number } | null)[];
}

export interface ScriptBlock {
  kind: 'heading' | 'para';
  level?: number;
  text?: string;
  nodes?: ScriptNode[];
  speaker?: string;
  time?: { start: number; end: number };
}

export interface ScriptResponse {
  /** 这一页的确认按钮记到的关卡；这个流程的路线上没有为 null。 */
  gate?: PageGate | null;
  path: string;
  content: string;
  final: boolean;
  updated_at?: string;
  blocks?: ScriptBlock[];
  stats?: { units: number; paragraphs: number; phrases: number };
  parse_error?: string;
  estimate_seconds?: number;
  voice?: {
    path: string;
    name: string;
    version: number;
    seconds: number;
    timing: 'aligned' | 'subtitled' | 'segmented' | 'estimated' | 'dialogue';
  };
  audio_options?: { path: string; name: string; version: number }[];
  dialogue?: {
    provider: string;
    roles: { id: string; name: string; voice_id?: string }[];
    warning?: string;
  };
  can_convert_to_dialogue?: boolean;
  change_log?: { path: string; content: string };
}

/** /api/voices 里的一个音色（音色库在用户级目录，所有项目共用）。 */
export interface VoiceEntry {
  name: string;
  /** 参考音频里说的话，逐字一致。 */
  text: string;
  source: 'designed' | 'recorded' | 'uploaded';
  instruction: string;
  duration_seconds: number;
  created: string;
  is_default: boolean;
}

export interface VoiceLibrary {
  dir: string;
  default: string;
  voices: VoiceEntry[];
  /** 录音与设计试听默认念的那段文字。 */
  sample_text: string;
  /** 这台机器能不能按描述设计音色（本机 Breeze TTS 2）。 */
  design: {
    ready: boolean;
    supported: boolean;
    problem: string;
    /** 安装页里 Breeze 那一项的 id：/api/setup/run 的 only。 */
    install_id: string;
  };
}

/** /api/voice-design 生成的一段试听。 */
export interface VoiceDraft {
  id: string;
  instruction: string;
  text: string;
}
