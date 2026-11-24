/** 插件中心里一个插件与这台电脑的关系（flow/market.ts 的 MarketState）。 */
export type MarketState =
  | 'available'
  | 'incompatible'
  | 'installed'
  | 'update'
  | 'other_source'
  | 'builtin'
  | 'unavailable';

export interface MarketVersion {
  version: string;
  ref: string;
  commit: string;
  requires_onset: string;
  /** 内容摘要：有它时不用 git 也能装。 */
  digest: string;
  /** 撤回的原因，空是没撤回。 */
  yanked: string;
}

/** GET /api/market 的一项（studio/market.ts）。 */
export interface MarketItem {
  id: string;
  name: string;
  description: string;
  author: { name: string; url: string };
  license: string;
  tags: string[];
  homepage: string;
  source: string;
  /** 后端代取的图标地址（/api/market/images/…），没有为空。 */
  icon: string;
  screenshots: string[];
  state: MarketState;
  /** 能装的最新一版；每一版都要更新的片场时为 null。 */
  latest: MarketVersion | null;
  /** 装不上时，最新一版要的片场版本。 */
  requires_onset: string;
  installed_version: string;
  installed_commit: string;
  /** 装着的那一版被撤回了：原因。 */
  installed_yanked: string;
  /** 不再维护的原因，空是还在维护。 */
  deprecated: string;
  maintainers: string[];
}

export interface MarketResponse {
  catalog_url: string;
  /** 设置里填了自己的目录地址。 */
  custom_url: boolean;
  /** 缓存的目录是什么时候取的；从没取到为空。 */
  fetched_at: string;
  refreshing: boolean;
  /** 最近一次刷新失败的原因。 */
  error: string;
  installed_error: string;
  onset_version: string;
  items: MarketItem[];
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
  /** 上游改过时是哪儿改了（例如分镜写好之后才定了整片风格）；没有就用通用说法。 */
  stale_note?: string;
  detail?: string;
  at?: string;
  /** 关卡是在对话里确认的：用户的原话。 */
  said?: string;
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
