// 与 internal/studio 的 JSON 结构一一对应。改后端字段时同步改这里。

export interface Project {
  id: string;
  path: string;
  name: string;
  last_opened_at?: string;
  series_id?: string;
  episode?: number;
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

/** 渲染用量，口径见 internal/tools.Usage：输入含缓存，输出含推理。 */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cost_usd?: number;
  /** 按额度计费的工具（qoder）报的额度；这类工具不报 token。 */
  credits?: number;
  turns?: number;
  partial?: boolean;
  source?: string;
}

/** 整个项目花掉的 token：渲染（各镜头全部尝试）加编排（onset run 与 Studio 对话的账本）。 */
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

export interface DirectoryListing {
  path: string;
  parent: string;
  root: string;
  entries: DirectoryEntry[];
  /** 只有 Windows 返回盘符；其他平台保留原来的目录浏览方式。 */
  drives?: { name: string; path: string }[];
}

/** 一页上的「确认」按钮记到哪个关卡（后端按当前流程路线上这一页的审核关卡给出）。 */
export interface PageGate {
  id: string;
  /** 内置插件登记的确认时发给 AI 的话；宿主的关卡为空，查 gateMessages。 */
  confirm?: string;
}

/** 编排工具经 onset studio show 请网页切到的页面。 */
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
