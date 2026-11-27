import type { Usage, ViewRequest } from './project';

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
  /** 编排模型；没有是跟随设置。 */
  model?: string;
  /** 编排工具的调用选项（effort=high,fast=on）；没有是跟随设置。 */
  options?: string;
  renderer?: string;
  renderer_model?: string;
  renderer_options?: string;
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
  | 'plan'
  | 'background-tasks'
  | 'context-compaction'
  | 'permission'
  | 'permission-resolved'
  | 'question'
  | 'question-deferred'
  | 'question-resolved';

/** 编排工具的待办清单一项。 */
export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** 逐条建的任务（TaskCreate）的编号；TodoWrite 的清单没有。 */
  id?: string;
}

export interface BackgroundTask {
  id: string;
  description: string;
  activity?: string;
}

export interface SessionEvent {
  seq: number;
  turn_id?: string;
  time: string;
  kind: EventKind;
  text?: string;
  /** 同一轮里同一 text_id 的思考文本按原样拼接。 */
  text_id?: string;
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
  background_tasks?: BackgroundTask[];
  compaction?: {
    state: 'running' | 'completed' | 'ended' | 'failed' | 'cancelled';
    pre_tokens?: number;
    post_tokens?: number;
  };
  queue_id?: string;
  /** view 事件：编排工具请网页切到的页面。 */
  view?: ViewRequest;
  /** permission 事件：编排工具在等用户批准的调用；permission-resolved 带结果。 */
  permission?: PermissionAsk;
  /** question / question-deferred / question-resolved 事件：结构化多题提问与结果。 */
  question?: QuestionEventData;
}

export interface QuestionOption {
  id?: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface QuestionItem {
  id: string;
  header?: string;
  question: string;
  multi_select?: boolean;
  required?: boolean;
  options: QuestionOption[];
  allow_other?: boolean;
  other_placeholder?: string;
}

export interface QuestionAnswerItem {
  question_id: string;
  label: string;
  selected: string[];
  other?: string;
}

export type QuestionResolutionStatus = 'answered' | 'skipped' | 'cancelled' | 'expired';

export interface QuestionAsk {
  id: string;
  title?: string;
  questions: QuestionItem[];
  source?: 'tool' | 'prose';
  deferred?: boolean;
}

export interface QuestionEventData {
  id: string;
  title?: string;
  questions?: QuestionItem[];
  source?: 'tool' | 'prose';
  deferred?: boolean;
  status?: QuestionResolutionStatus;
  answers?: QuestionAnswerItem[];
  answer_map?: Record<string, string | string[]>;
  note?: string;
}

export interface QuestionSubmitPayload {
  status: 'answered' | 'skipped';
  answers?: QuestionAnswerItem[];
  note?: string;
}

/** 编排工具请用户批准的一次调用（后端 studio/permissions.ts 的 PermissionEventData）。 */
export interface PermissionAsk {
  id: string;
  tool_name?: string;
  command?: string;
  description?: string;
  /** 「以后都允许」会记下的命令前缀；没有时只能允许这一次。 */
  suggestion?: string;
  input?: unknown;
  decision?: 'allow' | 'always' | 'deny' | 'expired';
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
