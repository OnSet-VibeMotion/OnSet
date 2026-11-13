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

/** 站的一段制作提示词。正文在 preset/gen/templates/production/<站>/<id>.md。 */
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

/** 内置流程是 speech / beat；第三方站带来的流程是 x:<站 id>。 */
export type FlowID = string;

export interface Flow {
  id: FlowID;
  name: string;
  /** 路线页上的先后，按站展开各自的站点。 */
  stations: string[];
  /** 顶栏第一步打开哪一页：script、beat，或第三方站自己的页面（x:<站>:<页面>）。 */
  first_page?: string;
}
