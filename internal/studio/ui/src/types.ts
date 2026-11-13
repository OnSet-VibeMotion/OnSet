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
  scene_id?: string;
  path?: string;
  seconds?: number;
  region?: Box;
  selector?: string;
  source?: string;
  note?: string;
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

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type EventKind =
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
  | 'turn-reverted';

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

export interface MemoryState {
  enabled: boolean;
  dir: string;
  pinned: number;
  budget: number;
  renderer: string;
  status: {
    snapshot: number;
    counts: Record<string, number>;
    drift: string[];
    weak: MemoryWeak[];
    retest: { name: string; renderer: string; examined_models: string[]; current_model: string }[];
    episodes: number;
    pending_failures: number;
  };
  memories: MemoryRow[];
  timeline: MemoryEvent[];
  exams: ExamResult[];
  snapshots: number[];
  runs: RunSummary[];
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
}

export interface RecallResponse {
  recall: { snapshot: number; renderer: string; model?: string; features: string[]; budget: number; used: number; items: RecallItem[]; omitted?: RecallItem[] };
  reasons: string[];
  section: string;
}
