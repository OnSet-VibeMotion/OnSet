// 与 internal/studio 的 JSON 结构一一对应。改后端字段时同步改这里。

export interface Project {
  id: string;
  path: string;
  name: string;
  last_opened_at?: string;
}

export interface ProjectState {
  project: Project;
  stage: 'setup' | 'plan' | 'render' | 'assemble' | 'review' | 'publish' | string;
  metadata: Record<string, string>;
  media: { audio: boolean; final: boolean; publish: boolean };
  scenes: { total: number; completed: number; stale: number };
  issues: unknown[];
}

export interface Scene {
  id: string;
  directory: string;
  duration_seconds?: number;
  output?: string;
  exists: boolean;
  stale: boolean;
  /** 全部渲染尝试（含归档）的次数与用量合计。 */
  attempts: number;
  usage?: Usage;
  /** 此刻正在渲染（渲染日志最近还在写）。 */
  rendering?: boolean;
}

/** 渲染用量，口径见 internal/tools.Usage：输入含缓存，输出含推理。 */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cost_usd?: number;
  turns?: number;
  partial?: boolean;
  source?: string;
}

/** 整个项目花掉的 token：渲染（各镜头全部尝试）加编排（am run 与 Studio 对话的账本）。 */
export interface ProjectUsage {
  renders: Usage;
  attempts: number;
  orchestrator: { calls: number; total: Usage; by_source: Record<string, Usage>; by_model: Record<string, Usage> };
  total: Usage;
}

export interface TreeFile {
  path: string;
  size: number;
  mtime: number;
}

export interface Task {
  task_id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Attachment {
  /** 用户上传的文件（path 在 production/studio/uploads/ 下）。 */
  upload?: boolean;
  name?: string;
  size?: number;
  scene_id?: string;
  path?: string;
  seconds?: number;
  region?: Box;
  selector?: string;
  source?: string;
  note?: string;
  /** 右键「引用到对话」的文字与出处（label 给人看，source 是项目内路径）。 */
  quote?: string;
  label?: string;
  /** 只指给编排工具看的镜头（scene_id）或文件（source）。 */
  ref?: boolean;
}

export interface SessionMeta {
  session_id: string;
  title: string;
  kind: 'chat' | 'production';
  tool: string;
  renderer?: string;
  cli_session_id?: string;
  created_at: string;
  updated_at: string;
  turns: string[];
  running_turn?: string;
}

export interface FileChange {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  revertable: boolean;
}

export type EventKind =
  | 'view'
  | 'session'
  | 'text'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'usage'
  | 'error'
  | 'done'
  | 'user'
  | 'turn-start'
  | 'turn-end'
  | 'files-changed'
  | 'notice'
  | 'turn-reverted'
  | 'queued'
  | 'unqueued'
  | 'plan';

/** 编排工具的待办清单一项。 */
export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SessionEvent {
  seq: number;
  turn_id?: string;
  time: string;
  kind: EventKind;
  text?: string;
  tool?: string;
  call_id?: string;
  input?: unknown;
  is_error?: boolean;
  session_id?: string;
  usage?: Usage;
  status?: string;
  files?: string[];
  changes?: FileChange[];
  plan?: PlanItem[];
  queue_id?: string;
  /** view 事件：编排工具请网页切到的页面。 */
  view?: ViewRequest;
}

export interface Turn {
  turn_id: string;
  session_id: string;
  kind: string;
  message: string;
  status: string;
  error?: string;
  started_at: string;
  ended_at?: string;
  changes: FileChange[];
}

export interface TurnFile {
  path: string;
  change: string;
  text: boolean;
  before: string;
  after: string;
}

export interface CanvasOption {
  id: string;
  label: string;
  width: number;
  height: number;
  orientation: string;
}

export interface StyleOption {
  id: string;
  name: string;
  label: string;
}

export interface StylesResponse {
  canvases: CanvasOption[];
  styles: StyleOption[];
  custom: StyleOption;
  archetypes: string[];
  default_canvas: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  is_project: boolean;
}

export interface BeatState {
  enabled: boolean;
  draft: boolean;
  click: boolean;
  confirmed: boolean;
  click_path: string;
}

export interface AgentInfo {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  path?: string;
}

export interface AgentsResponse {
  agents: AgentInfo[];
  orchestrator: string;
  renderer: string;
  config_error?: string;
}

/** 一个会话用的编排工具与渲染工具。 */
export interface AgentChoice {
  tool: string;
  renderer: string;
}

// ---- 渲染记忆（internal/memory 与 internal/studio/memory.go 的 JSON） ----

export type MemoryStatus = 'trial' | 'active' | 'rejected' | 'dormant';

export interface MemoryStat {
  recalled: number;
  passed_first_try: number;
}

export interface MemoryRow {
  name: string;
  description: string;
  status: MemoryStatus;
  kind: 'lesson' | 'preference';
  applies_when: { features?: string[]; keywords?: string[]; renderers?: string[]; models?: string[] };
  checked_by: string[];
  scope?: string;
  from_episodes?: string[];
  verified_by?: string[];
  revises?: string;
  rejected_reason?: string;
  body: string;
  stats?: Record<string, MemoryStat>;
  examinable: boolean;
}

export interface RunStats {
  scenes: number;
  passed_first_try: number;
  pass_rate: number;
  retries: number;
  problems: number;
  check_problems: number;
  seconds: number;
  input_tokens: number;
  output_tokens: number;
  recalled: number;
  snapshots: number[];
}

export interface RunSummary extends RunStats {
  run: string;
  started_at: string;
  project?: string;
  by_model: Record<string, RunStats>;
}

export interface MemoryEvent {
  time: string;
  type: string;
  snapshot?: number;
  summary: string;
  /** 经历与导入事件所属的项目；记忆库级事件（整理、考试、快照）为空。 */
  project?: string;
  detail?: Record<string, unknown>;
}

export interface ExamCell {
  question: string;
  holdout: boolean;
  renderer: string;
  model?: string;
  arm: 'control' | 'trial';
  repeat: number;
  outcome: string;
  passed: boolean;
  problems: number;
  checks?: string[];
  seconds: number;
  invalid?: boolean;
  error?: string;
  recalled?: string[];
  output?: string;
}

export interface ExamQuestion {
  id: string;
  episode?: string;
  holdout: boolean;
  scene_id: string;
}

export interface ExamResult {
  id: string;
  created_at: string;
  trials: string[];
  renderers: string[];
  questions: ExamQuestion[];
  cells: ExamCell[];
  verdict: { pass: boolean; invalid: boolean; needs_human: boolean; control_score: number; trial_score: number; reasons: string[] };
  applied: 'promoted' | 'rejected' | 'none';
  snapshot?: number;
}

export interface MemoryWeak {
  name: string;
  renderer: string;
  rate: number;
  baseline: number;
  recalled: number;
}

export interface MemorySuspect {
  name: string;
  renderer: string;
  recalled: number;
  harmful: number;
  checks: string[];
}

export interface MemoryState {
  enabled: boolean;
  dir: string;
  /** 当前项目名，用来筛时间线。 */
  project?: string;
  pinned: number;
  budget: number;
  renderer: string;
  status: {
    snapshot: number;
    counts: Record<string, number>;
    drift: string[];
    weak: MemoryWeak[];
    suspect?: MemorySuspect[];
    retest: { name: string; renderer: string; examined_models: string[]; current_model: string }[];
    episodes: number;
    pending_failures: number;
  };
  memories: MemoryRow[];
  timeline: MemoryEvent[];
  exams: ExamResult[];
  snapshots: number[];
  runs: RunSummary[];
  /** 上次整理之后还没整理的问题，按校验器归组（human 表示用户回退或说不满意）。 */
  pending?: { check: string; count: number; scenes: { project: string; scene: string }[] }[];
  /** 校验器、事件类型、镜头特征的大白话说法（internal/memory/labels.go）。 */
  labels?: { checks: Record<string, string>; events: Record<string, string>; features: Record<string, string> };
}

export interface RecallItem {
  name: string;
  kind: 'lesson' | 'preference';
  description: string;
  score: number;
  global?: boolean;
  renderers?: string[];
  models?: string[];
  matched_features?: string[];
  matched_keywords?: string[];
  chars: number;
  omit_reason?: 'budget' | 'limit';
}

export interface RecallResponse {
  recall: { snapshot: number; renderer: string; model?: string; features: string[]; budget: number; used: number; max_lessons: number; items: RecallItem[]; omitted?: RecallItem[] };
  reasons: string[];
  section: string;
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

/** 一个风格来源。ready 为 false 时来源数据还没由 am setup 准备好。 */
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

/** 本项目的整片风格（/api/film-style）。 */
export interface ProjectFilmStyle {
  installed: boolean;
  manifest?: FilmStyleManifest;
  style?: FilmStyle;
  style_file?: string;
}

/** 一项前置资源（/api/setup）。 */
export interface PrereqStatus {
  id: string;
  group: string;
  name: string;
  version?: string;
  /** 做片必需（技能与 CLI）；整片风格来源只有选了风格才要。 */
  required: boolean;
  ready: boolean;
  location: string;
}

export interface SetupStatus {
  /** 做片必需的项都已就绪。 */
  ready: boolean;
  items: PrereqStatus[];
  command: string;
}

/** /api/script：口播稿。final 为 false 时是原稿，只有 content。 */
export interface ScriptNode {
  kind: 'text' | 'alt' | 'phrase';
  text?: string;
  spoken?: string;
  id?: string;
  children?: ScriptNode[];
}

export interface ScriptBlock {
  kind: 'heading' | 'para';
  level?: number;
  text?: string;
  nodes?: ScriptNode[];
}

export interface ScriptResponse {
  path: string;
  content: string;
  final: boolean;
  updated_at?: string;
  blocks?: ScriptBlock[];
  stats?: { units: number; paragraphs: number; phrases: number };
  parse_error?: string;
  estimate_seconds?: number;
  voice?: { path: string; seconds: number };
  change_log?: { path: string; content: string };
}

/** 编排工具经 am studio show 请网页切到的页面。 */
export interface ViewRequest {
  page: string;
  target?: string;
  note?: string;
}

/** 用户此刻在看的页面，随消息发给编排工具。 */
export interface ViewState {
  page: string;
  scene?: string;
  file?: string;
}
