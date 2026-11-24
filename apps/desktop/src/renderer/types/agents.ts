export interface AgentInfo {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  path?: string;
  /** 能不能当渲染工具。 */
  renderer: boolean;
  /** 不能用时的一句说明（制作人还没填模型服务密钥）。 */
  hint?: string;
  /** 官方安装说明页（制作人没有）。 */
  install_url?: string;
  /** 这家能调的选项（后端 tools/options.ts 的 AgentOptionSpec）。 */
  option_specs?: AgentOptionSpec[];
}

/** 一家工具的一项调用选项：推理强度、快速模式、上下文长度……（后端 tools/options.ts）。 */
export interface AgentOptionSpec {
  key: string;
  label: string;
  hint: string;
  kind: 'choice' | 'toggle' | 'number';
  choices?: { value: string; label: string }[];
  presets?: { value: string; label: string }[];
  /** 要先选了模型才有用（opencode 的变体）。 */
  requiresModel?: boolean;
  /** 可选档位随模型变：按模型列表里那个模型的 efforts 收窄。 */
  perModel?: boolean;
  rendererOnly?: boolean;
}

export interface AgentsResponse {
  agents: AgentInfo[];
  orchestrator: string;
  renderer: string;
  /** 设置里给上面两家选的模型；空是那家工具自己的默认。 */
  orchestrator_model: string;
  renderer_model: string;
  /** 设置里给上面两家选的调用选项（effort=high,fast=on）；空是那家工具自己的默认。 */
  orchestrator_options?: string;
  renderer_options?: string;
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
  /** 两家各自的调用选项，逐项盖在设置上；空串是跟随设置。 */
  options?: string;
  renderer_options?: string;
}

/** GET /api/agents/{工具}/models。 */
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  /** 这个模型能选的推理强度（codex、qoder）；没有时按 option_specs 列，空数组是这个模型不推理。 */
  efforts?: string[];
  /** 这个模型有没有快速档位（codex）；没有时不确定。 */
  fast?: boolean;
  /** 工具内部的模型键（qoder 的 smodel 之类）。 */
  key?: string;
  /** 额度倍率（qoder，8 表示 8.00x）。 */
  credit?: number;
  /** 打折前的倍率，比 credit 高时划掉显示。 */
  creditBefore?: number;
  /** 免费（含限时免费）。 */
  free?: boolean;
  /** 正在进行的活动（「错峰2折」）。 */
  promotion?: string;
  /** 不指定模型时工具用的就是它。 */
  isDefault?: boolean;
  /** 不选推理强度时这个模型用哪一档。 */
  defaultEffort?: string;
  /** 这个模型能选的上下文长度（token），从小到大。 */
  contextWindows?: number[];
  /** 不选上下文长度时用多大。 */
  defaultContextWindow?: number;
}

export interface ModelsResponse {
  tool: string;
  models: ModelOption[];
  error?: string;
}

/** 制作人的模型服务协议：OpenAI 兼容（Chat Completions）或 Anthropic（Messages）。 */
export type AgentProtocol = 'openai' | 'anthropic';

/** GET /api/agent-services 的预设：只用来预填表单。 */
export interface AgentServicePreset {
  id: string;
  label: string;
  protocol: AgentProtocol;
  base_url: string;
  model: string;
  /** 推荐模型能不能读图（看画面）。 */
  vision: boolean;
  key_url: string;
}

/** 存下的一套模型服务（后端 studio/agentservices.ts），不回传 key，只说填没填。 */
export interface AgentService {
  id: string;
  name: string;
  /** 从哪个预设填的；手填的为空。 */
  preset: string;
  protocol: AgentProtocol;
  base_url: string;
  model: string;
  vision: boolean;
  has_key: boolean;
}

export interface AgentServicesResponse {
  presets: AgentServicePreset[];
  services: AgentService[];
  /** 在用的那套的 id；没有服务时为空。 */
  active: string;
  /** key 在磁盘上是否加密（safeStorage）；没加密时 note 是给用户的一句说明。 */
  storage?: { encrypted: boolean; note?: string };
}

/** GET /api/agent-services/vision：制作人这一轮会用的模型、哪套服务、能不能看图（没有服务时 null）。 */
export interface AgentVision {
  model: string;
  service: string;
  vision: boolean | null;
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
  /** 没有可量的进度时，这一步到现在落到磁盘的字节数：显示下了多少、多快。 */
  bytes?: number;
  /** 子进程最近吐出的一行输出。 */
  activity?: string;
  /** 开始这一步的时间（毫秒时间戳）。 */
  started_at?: number;
  /** 进行中的项多少秒没有动静了（后端在 GET 时算）。 */
  quiet?: number;
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

/** POST /api/setup/render-check：试渲染一个小镜头的结果。 */
export interface RenderCheckResult {
  ok: boolean;
  seconds: number;
  /** lent：借用客户端自带的浏览器；own：用户自己指定的；downloaded：HyperFrames 自己下载的。 */
  browser: 'lent' | 'own' | 'downloaded';
  /** 借用时走的是不是引导脚本接管的路（Windows 上是）。 */
  hooked: boolean;
  frame?: string;
  error?: string;
  log_tail?: string[];
}

export interface SetupStatus {
  /** 做片必需的项都已就绪。 */
  ready: boolean;
  items: PrereqStatus[];
  command: string;
  task?: SetupTask;
}

/** /api/settings 的一项：全局值、这个项目的值、现在实际用的值与它的来历。 */
export interface SettingRow {
  key: string;
  label: string;
  hint: string;
  options: { value: string; label: string }[];
  /** 模型项：跟着哪一项工具（ORCHESTRATOR / RENDERER），可选值按那家工具去取。 */
  model_of?: string;
  /** 调用选项项：跟着哪一项工具，可调的项按那家工具的 option_specs 画。 */
  options_of?: string;
  /** 全局也没设时用的内置默认。 */
  default: string;
  /** 全局设置里写的值；没写为空。 */
  global: string;
  /** 这个项目单独设的值；跟随全局为空。 */
  project: string;
  effective: string;
  source: 'env' | 'dotenv' | 'project' | 'global' | 'default';
}

/** 只属于这台电脑的一项（设置页「网络与更新」）：config.MachineKeys。 */
export interface MachineSetting {
  key: 'NETWORK_PROXY' | 'PLUGIN_CATALOG_URL' | 'UPDATE_FEED_URL';
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  /** 同名环境变量盖住了设置。 */
  overridden: boolean;
}

export interface SettingsResponse {
  file: string;
  has_project: boolean;
  machine: MachineSetting[];
  rows: SettingRow[];
}

/** 客户端更新的状态（main/updatestate.ts 的 UpdateState，两边一起改）。 */
export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  version: string;
  notes: string;
  released_at: string;
  percent: number;
  transferred: number;
  total: number;
  bytes_per_second: number;
  error: string;
  disabled_reason: string;
  checked_at: string;
  release_url: string;
}
