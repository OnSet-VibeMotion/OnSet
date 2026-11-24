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
  /** 其中属于片场自己的文件（这次操作因此算失败）。 */
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
  /** false：不需要项目（登录、管理账号这类插件自己的配置），没打开项目也能点。 */
  project: boolean;
  /** 返回列表（账号卡片这类）：设置里自动执行、画成卡片。 */
  list: boolean;
  /** false：设置里不给它出按钮表单。 */
  form: boolean;
  params: StationParam[];
  last_run?: StationRun;
}

export interface StationInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 随片场下发的内置插件。 */
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
  browser?: { origins: string[] };
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
  browser?: { origins: string[] };
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
  update?: {
    id: string;
    old_version: string;
    new_version: string;
    new_permissions: string[];
    new_experimental: string[];
    experimental: string[];
    changed: boolean;
    commit_before: string;
    commit_after: string;
  };
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
