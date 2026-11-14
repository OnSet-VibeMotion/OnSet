// 与 internal/studio 的 JSON 结构一一对应。改后端字段时同步改这里。

export interface Project {
  id: string;
  path: string;
  name: string;
  last_opened_at?: string;
}

export interface ProjectState {
  project: Project;
  metadata: Record<string, string>;
  scenes: { total: number; completed: number; stale: number };
  /** 整片制作现在在哪一步（beat / script / storyboard / scene / final / publish）。 */
  step?: string;
  /** step 是编排工具用 studio_step 标的；否则是按产物推的。 */
  step_marked?: boolean;
  /** 项目的流程（片型）：顶栏的步骤、第一步、用不上的页面都按它（studio/progress.ts 的 flowView）。 */
  flow?: FlowView;
  /** 没有流程记录（不是这一版新建的项目）时的说明；这时没有 flow 与 step。 */
  flow_error?: string;
  /** 客户端有哪些页（宿主的加上内置插件登记的，studioview.viewPages）：界面只列这里有的。 */
  pages?: { id: string; label: string }[];
}

export interface FlowView {
  /** speech、beat、song，或第三方流程 x:<站>。 */
  id: string;
  name: string;
  first_page: string;
  /** 顶栏的步骤（页面 id），第一步是 first_page。 */
  steps: string[];
  /** 这个项目用不上的别的流程的第一步页。 */
  hidden_pages: string[];
  /** 编排工具标的这几个步骤都算第一步。 */
  first_steps: string[];
  /** 还没有镜头时打开项目先落在这一页；空是不落。 */
  land_page: string;
}

export interface Scene {
  id: string;
  directory: string;
  duration_seconds?: number;
  output?: string;
  exists: boolean;
  /** 产物文件的修改时间与大小；镜头视频按它刷新，别的文件变了不重新加载。 */
  output_stamp?: string;
  stale: boolean;
  /** 全部渲染尝试（含归档）的次数与用量合计。 */
  attempts: number;
  usage?: Usage;
  /** 此刻正在渲染（进行中标记里的进程还在）。 */
  rendering?: boolean;
  /** 正在渲染时，这次从什么时候开始。 */
  rendering_since?: string;
}

/** 渲染器的一步（后端 studio/activity.ts 的 ActivityStep）。 */
export interface ActivityStep {
  kind: 'tool' | 'text' | 'error';
  tool?: string;
  input?: unknown;
  /** running / done / failed，只有工具调用有。 */
  state?: string;
  output?: string;
  text?: string;
}

/** GET /api/scenes/{id}/activity：渲染器此刻在做什么，或最近一次渲染做了什么。 */
export interface SceneActivity {
  scene_id: string;
  rendering: boolean;
  renderer?: string;
  model?: string;
  started_at?: string;
  updated_at?: string;
  /** 全部步数；steps 只带最近的一段。 */
  step_count: number;
  steps: ActivityStep[];
  plan?: PlanItem[];
  /** 不在渲染时：最近一次的结果。 */
  outcome?: string;
  error?: string;
  ended_at?: string;
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
  /** 跑完了但要用户留意的事（第三方插件写了它没声明的文件）。 */
  warning?: string;
  /** 跑完后的结构化结果（取回插件时是 {staged, preview}）。 */
  result?: unknown;
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
  /** 编排模型；没有是跟随设置。 */
  model?: string;
  renderer?: string;
  renderer_model?: string;
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
  | 'permission'
  | 'permission-resolved';

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
  /** permission 事件：编排工具在等用户批准的调用；permission-resolved 带结果。 */
  permission?: PermissionAsk;
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

export interface CanvasOption {
  id: string;
  label: string;
  width: number;
  height: number;
  orientation: string;
}

/** 新建对话框的一种做法（projectinit.presets）：讲解形式加叙事模式。canvas、example 给首页模板。 */
export interface ModeOption {
  id: string;
  label: string;
  hint: string;
  delivery: string;
  narration: string;
  canvas?: string;
  example?: string;
  /** 第三方插件带来的做法：插件名。 */
  plugin?: string;
}

export interface StylesResponse {
  canvases: CanvasOption[];
  default_canvas: string;
  modes: ModeOption[];
}

export interface DirectoryEntry {
  name: string;
  path: string;
  is_project: boolean;
}

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
  /** 节拍分析环境：没就绪时 command 是要在终端里跑的 am setup --only beat。 */
  analyzer?: { ready: boolean; location: string; command?: string };
}

export interface AgentInfo {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  path?: string;
  /** 能不能当渲染工具；导演暂时只做编排。 */
  renderer: boolean;
  /** 不能用时的一句说明（导演还没填模型服务密钥）。 */
  hint?: string;
  /** 官方安装说明页（导演没有）。 */
  install_url?: string;
}

export interface AgentsResponse {
  agents: AgentInfo[];
  orchestrator: string;
  renderer: string;
  /** 设置里给上面两家选的模型；空是那家工具自己的默认。 */
  orchestrator_model: string;
  renderer_model: string;
  /** 不看项目时的渲染工具（环境变量 > 全局设置 > 默认）：新建的项目跟着它。 */
  global_renderer: string;
  config_error?: string;
}

/** 一个会话用的编排工具与渲染工具，以及各自的模型（空串是跟随设置）。 */
export interface AgentChoice {
  tool: string;
  renderer: string;
  model?: string;
  renderer_model?: string;
}

/** GET /api/agents/{工具}/models。 */
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
}

export interface ModelsResponse {
  tool: string;
  models: ModelOption[];
  error?: string;
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

/** 一项前置资源（/api/setup）。 */
export interface PrereqStatus {
  id: string;
  group: string;
  name: string;
  version?: string;
  /** 做片必需（技能、CLI、浏览器、ffmpeg）；配音与对齐工具、节拍分析环境、整片风格来源按需。 */
  required: boolean;
  ready: boolean;
  location: string;
  /** 内置插件登记的项：安装页「以后可能用到」里的那一组（同一 group 合成一张卡片）。 */
  later?: { title: string; desc: string; icon?: string };
}

/** 一项在这次安装里的进展（/api/setup 的 task.items）。 */
export interface SetupItemProgress {
  state: 'pending' | 'running' | 'done' | 'failed';
  stage: string;
  /** 0–100；没有可量的进度时省略。 */
  percent?: number;
  error?: string;
}

/** 客户端里的一次安装（/api/setup/run 启动）。 */
export interface SetupTask {
  running: boolean;
  started: string;
  finished?: string;
  items: Record<string, SetupItemProgress>;
  error?: string;
  /** 失败时日志最后几行。 */
  log_tail?: string[];
  log: string;
}

export interface SetupStatus {
  /** 做片必需的项都已就绪。 */
  ready: boolean;
  items: PrereqStatus[];
  command: string;
  task?: SetupTask;
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

/** 一页上的「确认」按钮记到哪个关卡（后端按当前流程路线上这一页的审核关卡给出）。 */
export interface PageGate {
  id: string;
  /** 内置插件登记的确认时发给 AI 的话；宿主的关卡为空，查 gateMessages。 */
  confirm?: string;
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
  voice?: { path: string; seconds: number };
  change_log?: { path: string; content: string };
}

/** 编排工具经 am studio show 请网页切到的页面。 */
export interface ViewRequest {
  /** 只标制作步骤时为空。 */
  page: string;
  target?: string;
  note?: string;
  step?: string;
}

/** 用户此刻在看的页面，随消息发给编排工具。 */
export interface ViewState {
  page: string;
  scene?: string;
  file?: string;
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

/** /api/settings 的一项：全局值、这个项目的值、现在实际用的值与它的来历。 */
export interface SettingRow {
  key: string;
  label: string;
  hint: string;
  options: { value: string; label: string }[];
  /** 模型项：跟着哪一项工具（ORCHESTRATOR / RENDERER），可选值按那家工具去取。 */
  model_of?: string;
  /** 全局也没设时用的内置默认。 */
  default: string;
  /** 全局设置里写的值；没写为空。 */
  global: string;
  /** 这个项目单独设的值；跟随全局为空。 */
  project: string;
  effective: string;
  source: 'env' | 'dotenv' | 'project' | 'global' | 'default';
}

export interface SettingsResponse {
  file: string;
  has_project: boolean;
  rows: SettingRow[];
}

/** GET /api/agent-keys（后端 studio/agentkeys.ts）：导演的模型服务密钥，只说填没填、不回传 key。 */
export interface AgentKeyProvider {
  id: string;
  label: string;
  key_url: string;
  default_model: string;
  /** 推荐模型能不能读图（看画面）。 */
  vision: boolean;
  configured: boolean;
}

/** GET /api/agent-keys/vision：导演实际会用的模型与它能不能读图（false 看不了，null 不知道）。 */
export interface AgentVision {
  model: string;
  vision: boolean | null;
}

export interface AgentKeysResponse {
  providers: AgentKeyProvider[];
  others: string[];
  /** key 在磁盘上是否加密（safeStorage）；没加密时 note 是给用户的一句说明。 */
  storage?: { encrypted: boolean; note?: string };
}

/** GET /api/storyboard（后端 studio/storyboard.ts）：分镜页。 */
export interface StoryboardHandoff {
  device: string;
  device_label: string;
  bridge: string;
  style_shift?: string;
  style_shift_label?: string;
}

/** 镜头实际用的画风（后端 studio/storyboard.ts 的 StoryboardStyle）。 */
export interface StoryboardStyle {
  /** 实际用的「来源/目录名」；不用整片风格时为空。相邻镜头不同就是风格交界。 */
  key: string;
  kind: 'default' | 'named' | 'none' | 'free';
  cn: string;
  category_cn?: string;
  missing?: boolean;
}

export interface StoryboardScene {
  id: string;
  dir: string;
  chapter?: string;
  visual_role?: string;
  summary?: string;
  /** 分镜计划里写的 film_style 原值：空是默认风格，none 是不用整片风格。 */
  film_style?: string;
  style: StoryboardStyle;
  anchor?: string;
  handoff?: StoryboardHandoff;
  text?: string;
  seconds?: number;
  prompt?: { path: string; content: string };
  created: boolean;
  rendered: boolean;
}

export interface StoryboardResponse {
  /** 这一页的确认按钮记到的关卡（口播 gate-storyboard，卡点 gate-beat-storyboard）；路线上没有为 null。 */
  gate?: PageGate | null;
  plan_path: string;
  updated_at?: string;
  parse_error?: string;
  look?: { background?: string; surface?: string; ink?: string; accent?: string; accent_2?: string };
  default_style?: { key: string; cn: string; category_cn?: string };
  installed_styles: string[];
  treatment?: { path: string; content: string };
  doc_path?: string;
  scenes: StoryboardScene[];
}

/** /api/progress：制作路线（studio/progress.ts）。 */
export interface ProgressTurn {
  turn_id: string;
  session_id: string;
  message: string;
  status: string;
  at: string;
  files: number;
  paths: string[];
}

export interface ProgressStation {
  id: string;
  label: string;
  /** 归在顶栏哪一步下（页面 id）。 */
  step: string;
  gate?: boolean;
  optional?: boolean;
  status: 'done' | 'skipped' | 'stale' | 'todo' | 'confirmed' | 'passed' | 'changed';
  detail?: string;
  at?: string;
  page?: string;
  file?: string;
  turns: ProgressTurn[];
  /** 内置插件给这一站写的「接下来」说法，第三方站清单里声明的（nodes[].guide、state 里落到的那一项）也在这里。 */
  guide?: {
    ai?: string;
    user?: string;
    page?: string;
    page_label?: string;
    /** 等你时的按钮（内置插件登记的）。 */
    actions?: (
      | { kind: 'page'; label: string; page: string }
      | { kind: 'say' | 'draft'; label: string; text: string }
      | { kind: 'gate'; label: string; gate: string }
      | { kind: 'op'; label: string; station: string; op: string; summary: string }
    )[];
    /** 关卡：点「确认」时发给 AI 的话。 */
    confirm?: string;
  };
}

export interface ProgressState {
  /** 流程 id（speech、beat、song 或 x:<站>）。 */
  mode: string;
  stations: ProgressStation[];
  current: string;
  waiting_on: '' | 'user' | 'ai';
  turns: Record<string, string[]>;
}

/** /api/stations 里的一个插件（studio/stations.ts）。 */
export interface StationParam {
  key: string;
  type: 'string' | 'boolean' | 'integer' | 'number' | 'strings';
  description: string;
  required: boolean;
  default?: unknown;
}

export interface StationRun {
  task_id: string;
  at: string;
  ok: boolean;
  text: string;
  data?: unknown;
  /** 写了它没声明会写的项目文件（最多 20 条）；没有越界时不出现。 */
  out_of_scope?: string[];
  out_of_scope_more?: number;
  /** 其中属于 ArticleToMotion 自己的文件（这次操作因此算失败）。 */
  reserved?: string[];
}

export interface BuiltinContents {
  /** 制作路线上的站点（名字）。 */
  nodes: string[];
  /** AI 能用的工具；verb 是对话里显示的说法。 */
  ops: { name: string; summary: string; verb: string }[];
  /** 给渲染器的技能。 */
  skills: string[];
  /** scene.json 里它的块。 */
  blocks: string[];
  pages: string[];
  flows: string[];
  /** 它带来的整片风格库（名字）。 */
  film_styles: string[];
  skins: string[];
}

export interface StationOp {
  name: string;
  /** 编排工具用的工具名；只能由用户触发的操作为空。 */
  tool: string;
  summary: string;
  description: string;
  trigger: 'agent' | 'user';
  params: StationParam[];
  last_run?: StationRun;
}

export interface StationInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 随 ArticleToMotion 下发的内置插件。 */
  builtin: boolean;
  /** 内置插件在 apply 里登记的东西（第三方站为 null）：设置页「详情」照实列出。 */
  contents: BuiltinContents | null;
  source: string;
  commit: string;
  linked: boolean;
  /** 第三方站用到的实验性字段（以后的版本可能调整）；内置插件为空。 */
  experimental: string[];
  replaces: string;
  after: string;
  prompt: string;
  nodes: { id: string; label: string; step: string; gate: boolean }[];
  pages: StationPageInfo[];
  ops: StationOp[];
  settings: StationSetting[];
  permissions: { project: boolean; network: string[]; uses: string[] };
  hooks: { on: string; op: string }[];
  schedules: { every_minutes: number; op: string }[];
  /** 往制作提示词哪几个阶段里插了说明。 */
  inserts: string[];
  /** 提供的配音、对齐工具名（没有为空）。 */
  provides: { tts: string; align: string };
  renderer_skills: { name: string; summary: string; scenes: 'all' | 'opt-in' }[];
  /** 带来的整片风格库名（没有为空）。 */
  film_styles: string;
  /** 带来的界面皮肤名。 */
  skins: string[];
  /** 带来的整套流程（新片型）。 */
  flow: { name: string; stations: string[]; first_tab: string } | null;
  slots: StationSlot[];
  commands: StationCommand[];
}

export interface StationSetting {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'secret';
  description: string;
  options: string[];
  default?: string | number | boolean;
  /** 普通设置的当前值。 */
  value?: string | number | boolean;
  /** 密钥填没填（值从不回传）。 */
  set?: boolean;
}

/** 插件页面嵌进自带页面的位置。 */
export interface StationSlot {
  at: string;
  page: string;
  height: number;
  tab: string;
  url: string;
}

export interface StationCommand {
  name: string;
  description: string;
  page: string;
  prompt: string;
  tab: string;
}

/** 插件自己的页面：tab 是客户端里的页面 id（x:<站>:<页面>），url 是沙箱 iframe 的地址。 */
export interface StationPageInfo {
  id: string;
  label: string;
  tab: string;
  url: string;
  reads: string[];
  /** 被皮肤拿去当桌宠的页面：插件菜单不列。 */
  pet?: boolean;
}

/** 取回、还没装上的插件给你看的实情（flow.StationPreview）。 */
export interface StationPreview {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  commit: string;
  linked: boolean;
  ops: { name: string; summary: string; trigger: 'agent' | 'user'; tool: string }[];
  ops_trust: string;
  page_permissions: string[];
  permissions: { project: boolean; network: string[]; uses: string[] };
  reads: string[];
  pages: string[];
  experimental: string[];
  hooks: { on: string; label: string; op: string; summary: string }[];
  schedules: { every_minutes: number; op: string; summary: string }[];
  renderer_skills: { name: string; summary: string; scenes: 'all' | 'opt-in' }[];
  rerender_all: boolean;
  flow: string;
  film_styles: string;
  /** 带来的皮肤文件。 */
  skins: string[];
  provides: { tts: string; align: string };
  replaces: string;
  after: string;
  nodes: string[];
  inserts: string[];
  update?: { id: string; old_version: string; new_version: string; new_permissions: string[]; new_experimental: string[]; experimental: string[]; changed: boolean; commit_before: string; commit_after: string };
}

/** 装了却读不出来的插件（本机没有、内容被改过、清单写坏）。 */
export interface StationProblem {
  id: string;
  message: string;
  /** 来自本机目录（不能「更新」）。 */
  linked: boolean;
}

/** /api/stations：全部插件（内置与这台电脑上装的第三方插件），对所有项目一样。 */
export interface StationsResponse {
  stations: StationInfo[];
  problems: StationProblem[];
}

/** 一套界面皮肤（后端 studio/skins.ts 的 skinJSON）：变量名不带 `--`。 */
export interface SkinView {
  id: string;
  name: string;
  description: string;
  scheme: 'dark' | 'light';
  origin: 'host' | 'builtin' | 'plugin';
  plugin: string;
  tokens: Record<string, string>;
  fonts: Record<string, string>;
  radius: number | null;
  swatch: [string, string, string, string];
  pet: {
    materials: Record<string, [string, string, string]>;
    crew: Record<string, Record<string, string>>;
    room: Record<string, string>;
    filter: { hue?: number; saturate?: number; brightness?: number; contrast?: number };
    page_url: string;
  };
}

export interface SkinsResponse {
  current: string;
  skins: SkinView[];
  problems: { plugin: string; file: string; message: string }[];
}

