/**
 * 流程插件的基本类型。设计见 docs/superpowers/specs/2026-11-11-流程插件-design.md（本地设计稿）。
 *
 * 站（Station）是流程里的一步：一段或几段制作提示词、制作路线页上的一个或几个站点（含审核关卡）、
 * 它会写的项目文件。流程（Flow）是站的有序组合，口播与卡点是两个内置流程。
 *
 * 这里只有声明：站点做没做的判断函数在客户端后端（studio/progress.ts）按「站/站点」登记，
 * 引擎这一层不依赖 studio。
 */

/** 项目里的一条路径归哪个站点。三种写法，越具体越优先：整条路径 > 前缀加文件名 > 只有前缀。 */
export interface PathRule {
  /** 整条路径（项目根下的相对路径，`/` 分隔）。 */
  path?: string;
  /** 路径前缀，按字符串比较（`production/scene-plan` 也算 `production/scene-plan.json` 的前缀）。 */
  prefix?: string;
  /** 与 prefix 同用：文件名（最后一段）还要匹配它。 */
  base?: RegExp;
}

/** 制作路线页上的一站。字段与 studio/progress.ts 的 Station 同名。 */
export interface RouteNode {
  id: string;
  label: string;
  /** 归在顶栏哪一步下（studioview.StepIDs 之一）。 */
  step: string;
  gate?: boolean;
  /** 可选的站：不做也不挡路，不会成为「现在在这」。 */
  optional?: boolean;
  page?: string;
  file?: string;
  /** 审核关卡绑定的文件：确认后它们变了，确认就不算数。只有经界面按钮确认的关卡才有。 */
  gateFiles?: string[];
  /** 这一站会写的文件，改过的文件据此归站。 */
  produces?: PathRule[];
  /**
   * 第三方站的声明式判断（内置站的判断函数在 studio/progress.ts）：outputs 里最新的修改时间就是这一站的产物时间，
   * stale_after 里的站点产物比它新时要重做。
   */
  declared?: { outputs: string[]; stale_after: string[] };
}

/** 站的一段制作提示词。宿主的段落正文在 assets/prompts/<站>/<id>.md（运行期也读得到），内置插件的在它的目录里。 */
export interface PromptSection {
  id: string;
  /**
   * 这一段开启一个「阶段」时写阶段名。正文里用 `{{STAGE:<阶段名>}}` 写「第六阶段」，
   * `{{STAGE_N:<阶段名>}}` 只写数字「六」，按阶段在提示词里的先后编号。
   */
  stage?: string;
}

export interface Station {
  id: string;
  name: string;
  nodes: RouteNode[];
  prompt: PromptSection[];
}

/**
 * 加进项目的第三方站，放进路线的位置：replaces 顶替同 id 的内置站（站点整组换掉），
 * 否则接在 after 这个站点后面；after 不在这个流程里时接在最后。
 */
export interface ExtraStation {
  station: Station;
  after: string;
  replaces: string;
  /** 这个站带来的整套流程（新片型）；项目选用它时 FlowID 是 x:<站 id>。 */
  flow?: Flow;
}

/** 内置流程是 speech / beat，内置插件带来的有 song；第三方站带来的流程是 x:<站 id>。 */
export type FlowID = string;

export interface Flow {
  id: FlowID;
  name: string;
  /** 路线页上的先后，按站展开各自的站点。 */
  stations: string[];
  /**
   * 这个流程的制作提示词：段落的先后（「站/段」）。路线与提示词是同一个流程的两面，写在一处；
   * 提示词里可以有路线上没有站点的站的段落（例如公共约定 host）。内置插件的段落按各自的 after 并进来（flowPrompt）。
   * 第三方站带来的流程没有它（提示词由 compose.ts 按 stations 现组合）。
   */
  prompt?: string[];
  /**
   * 段落里引用了这个流程没有的阶段时改指哪个阶段（`{{STAGE:script}}` → 卡点的 beat 阶段）。
   * 只给「意思对得上」的引用用；对不上的引用直接报错。
   */
  stage_aliases?: Record<string, string>;
  /** 顶栏第一步打开哪一页：script、beat，或第三方站自己的页面（x:<站>:<页面>）。 */
  first_page?: string;
  /** 还没有镜头时打开项目先落在第一步那一页（卡点：节拍、分镜都在节拍页上做）。 */
  land_first?: boolean;
  /** 片型自己的配置文件：新建项目时写出（body 是缺省内容）。它不决定流程，流程只看锁文件里的记录。 */
  marker?: FlowMarker;
  /** 新建项目时不能与它同时用的东西。 */
  excludes?: FlowExcludes;
}

export interface FlowMarker {
  file: string;
  body: string;
}

/**
 * plugins：内置插件（新建时选了它——叙事模式 cast 就是多角色对话插件——或项目里已有它的 in_use 文件）；
 * flows：别的片型（项目里已有它们的标记文件）。命中任一项就以 message 拒绝。
 */
export interface FlowExcludes {
  plugins?: string[];
  flows?: string[];
  message: string;
}
