import type { PlanItem } from './chat';
import type { PageGate, Usage } from './project';

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
  kind: 'tool' | 'thinking' | 'text' | 'error';
  tool?: string;
  input?: unknown;
  /** running / done / failed，只有工具调用有。 */
  state?: string;
  output?: string;
  text?: string;
  /** 思考的全文字数（text 只是开头一段）。 */
  chars?: number;
  text_id?: string;
}

/** GET /api/scenes/{id}/activity：渲染器此刻在做什么，或最近一次渲染做了什么。 */
export interface SceneActivity {
  scene_id: string;
  rendering: boolean;
  /** Windows 后端是否提供 Codex MCP 的开始/结束事件。 */
  tool_lifecycle?: string;
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

export interface ElementEdit {
  selector: string;
  dx?: number;
  dy?: number;
  scaleX?: number;
  scaleY?: number;
  rotate?: number;
  opacity?: number;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  text?: string;
  hidden?: boolean;
}

export interface SceneEdits {
  schema: 1;
  elements: Record<string, ElementEdit>;
}

export interface SceneEditsResponse {
  has_html: boolean;
  edits: SceneEdits;
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
  /** 画面描述检查的结果（还没采用或丢掉的草稿）。 */
  prompt_check?: PromptCheck;
}

export type PromptCheckDimension = 'intent' | 'concreteness' | 'pacing' | 'continuity' | 'ambiguity';

/** 一次画面描述检查（后端 promptopt.PromptCheck 加上 outdated）。 */
export interface PromptCheck {
  scene: string;
  dir: string;
  base_sha256: string;
  checked_at: string;
  tool: string;
  model: string;
  scores: Record<PromptCheckDimension, number>;
  issues: string[];
  decision: 'skip' | 'minor' | 'rewrite';
  /** 改写稿；不用改或没通过核对时没有。 */
  prompt?: string;
  /** 改写稿为什么没有采用。 */
  rejected?: string[];
  /** 检查之后 prompt.md 又改过。 */
  outdated: boolean;
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
