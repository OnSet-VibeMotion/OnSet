import type { SceneActivity } from './scene';

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
  revised_by?: { name: string; description: string; status: MemoryStatus }[];
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
  preview_video?: { url: string; source_project: string };
  preview_audio?: {
    path?: string;
    url?: string;
    start_seconds: number;
    duration_seconds: number;
    label: string;
    source_project?: string;
  };
  audio_unavailable?: string;
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
  incomplete?: boolean;
  error?: string;
  recalled?: string[];
  output?: string;
  /** 这一格查出的问题原文，取自它的考试经历。 */
  problem_texts?: string[];
}

export interface ExamQuestion {
  id: string;
  /** 这个镜头的口播，取自考试经历。 */
  text?: string;
  episode?: string;
  holdout: boolean;
  scene_id: string;
}

export interface ExamResult {
  human_acceptance?: {
    id: string;
    name: string;
    description: string;
    question_ids: string[];
    accepted_at: string;
    note: string;
    user_statement: string;
  };
  original_verdict?: ExamResult['verdict'];
  id: string;
  created_at: string;
  trials: string[];
  renderers: string[];
  questions: ExamQuestion[];
  cells: ExamCell[];
  verdict: {
    pass: boolean;
    invalid: boolean;
    needs_human: boolean;
    control_score: number;
    trial_score: number;
    reasons: string[];
  };
  applied: 'promoted' | 'rejected' | 'retest-passed' | 'retest-failed' | 'none';
  snapshot?: number;
  evaluation_note?: string;
}

export interface ExamProgress {
  id: string;
  created_at: string;
  updated_at: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  trials: { name: string; description: string; checks: string[] }[];
  questions: (ExamQuestion & { text: string })[];
  cells: {
    question: string;
    renderer: string;
    arm: string;
    repeat: number;
    status: 'queued' | 'running' | 'completed' | 'cancelled';
    result?: ExamCell;
    activity?: SceneActivity;
    started_at?: string;
    finished_at?: string;
  }[];
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
  exam_progress?: ExamProgress[];
  enabled: boolean;
  dir: string;
  /** 当前项目名，用来筛时间线。 */
  project?: string;
  /** 当前项目所属专栏（如有），偏好支持设成专栏范围。 */
  series_id?: string;
  series_name?: string;
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
  /** 所有项目最近的渲染批次，进化页挑两批来比。 */
  runs_all?: RunSummary[];
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
  recall: {
    snapshot: number;
    renderer: string;
    model?: string;
    features: string[];
    budget: number;
    used: number;
    max_lessons: number;
    items: RecallItem[];
    omitted?: RecallItem[];
  };
  reasons: string[];
  section: string;
}
