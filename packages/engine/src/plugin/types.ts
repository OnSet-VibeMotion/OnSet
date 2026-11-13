/**
 * 内置插件的进程内入口（apply）能登记的东西。设计见 docs/superpowers/specs/2026-11-11-流程插件-design.md 第二节：
 * 第三方站只能声明（am-station.json），内置插件随客户端下发、与宿主同进程，在 apply(ctx) 里登记代码。
 *
 * 这一层在依赖的最底下：只 import flow 的类型（不 import 运行时代码），不依赖 studio 与 cli。
 * 各层从登记表里取自己要的东西：
 *
 * | 登记的 | 谁来用 |
 * |---|---|
 * | 站（站点、提示词段落、判断函数） | flow（路线、文件归站、关卡、制作提示词）与 studio/progress.ts（判断函数） |
 * | 流程（片型：路线与提示词段落顺序） | flow（allFlows、flowPrompt、运行期组合） |
 * | 操作 | cli 的操作表（plugin_ops.ts 订阅后 defineOp），工具服务与客户端后端随之都有 |
 * | 页面 | studioview（studio_show 能切的页面、专门页面）与客户端后端（这个项目用不上的页面） |
 * | 接口 | studio.ts 的路由表 |
 * | 校验器 | 客户端后端的「检查」命令（/api/commands/<id>.check） |
 * | 网页命令 | 客户端后端的 /api/commands/<id>（界面按钮直接触发的写任务） |
 * | 前置资源 | prereqs.items（am setup、客户端安装页） |
 * | 子进程环境变量 | config.childEnvironment 与工具服务（tools.amToolsServer）的放行表 |
 * | 顶栏步骤 | studioview.stepIDs（studio_step 能标的步骤、顶栏的步骤） |
 * | 整片风格来源 | filmstyle 的来源表（风格目录、装进项目、风格选择器） |
 */
import type { Source as FilmStyleSource } from '../filmstyle/filmstyle';
import type { FlowExcludes, FlowMarker, RouteNode } from '../flow/types';
import type { Item as PrereqItem } from '../prereqs';
import type { SceneBlock } from '../scene/block';
import type { Scene } from '../scene/scene';
import type { SkillDescriptor } from '../scene/skills';

/** 判断函数拿到的项目状态。字段是 studio/progress.ts 的 Ctx 的子集，那边的 Ctx 可以直接传进来。 */
export interface JudgeContext {
  root: string;
  scenes: readonly { directory: string; output?: string; exists: boolean; stale: boolean }[];
  gates: Readonly<Record<string, { at: string; files: Record<string, string> }>>;
}

/** 一个站点做没做的判断（与 studio/progress.ts 的内置判断同一种写法）。 */
export interface NodeJudge<C extends JudgeContext = JudgeContext> {
  /** 产物的修改时间（毫秒）；0 表示没做。关卡不用写。 */
  output?: (c: C) => number;
  /** 上游产物比这一站的产物新：要重做。 */
  stale?: (c: C, out: number) => boolean;
  detail?: (c: C) => string | undefined;
  /** 关卡的状态不经 gates.json 时自己判断。 */
  gateState?: (c: C) => { status: 'confirmed' | 'changed' | 'todo'; at?: number | string };
  /** 这一站是「现在在这」时在等谁；不写（或返回 undefined）就按缺省：关卡等用户，其余等 AI。 */
  waiting?: (c: C) => 'user' | 'ai' | undefined;
  /**
   * 客户端「接下来」卡片的说法（界面 guide.ts 先查自己的表，再用这里的）：ai 是 AI 在做时，user 是等你时；
   * page 给一个「去看」按钮（页面 id）。
   */
  guide?: PluginGuide;
  /** 说法随项目状态变时用它（有它就不看 guide）。 */
  guideFor?: (c: C) => PluginGuide | undefined;
  /** 进行中：还没做完，但已经开了头——后面的站做了也不算「跳过」。 */
  inProgress?: (c: C) => boolean;
}

/** 「接下来」卡片上的一个按钮：开一页、把一句话发给 AI、填进输入框、确认关卡（同界面 guide.ts 的 GuideAction）。 */
export type PluginGuideAction =
  | { kind: 'page'; label: string; page: string }
  | { kind: 'say'; label: string; text: string }
  | { kind: 'draft'; label: string; text: string }
  | { kind: 'gate'; label: string; gate: string }
  /** 请用户确认后执行一个第三方站的操作（只限 trigger: user、没有必填参数的）。 */
  | { kind: 'op'; label: string; station: string; op: string; summary: string };

export interface PluginGuide {
  ai?: string;
  user?: string;
  page?: string;
  pageLabel?: string;
  /** 等你时的按钮；不写时按 page 给一个「去看」。 */
  actions?: PluginGuideAction[];
  /** 关卡：用户在界面上点「确认」时发给 AI 的那句话（不写就没有确认按钮）。 */
  confirm?: string;
}

/**
 * 一段制作提示词。正文是插件目录里的文件（相对插件目录）。它进哪些流程的提示词、排在哪：
 *
 * - after：在 flows 里每个流程的提示词中跟在哪一段后面（`站/段`，可以是宿主的段，也可以是先登记的插件段）。
 * - append：接在 flows 里每个流程的提示词最后（与上一段之间空一行，正文去掉首尾空白）。
 * - 两样都不写：只由插件自己登记的流程（PluginFlow.prompt）点名使用。
 *
 * flows 不写时用站的 flows。开启一个阶段时写 stage 与 title（「## 第N阶段：<标题>」冒号后面那段）。
 */
export interface PluginSection {
  id: string;
  file: string;
  after?: string;
  append?: boolean;
  flows?: readonly string[];
  stage?: string;
  title?: string;
}

/**
 * 插件带来的一整套流程（片型）。路线：stations，或者 base（沿用那个流程的路线，含插件排进去的站）。
 * 提示词：prompt 是段落顺序（「站/段」，可以点名宿主与插件的段落）。
 */
export interface PluginFlow {
  id: string;
  name: string;
  base?: string;
  stations?: string[];
  prompt: string[];
  first_page: string;
  land_first?: boolean;
  stage_aliases?: Record<string, string>;
  marker?: FlowMarker;
  excludes?: FlowExcludes;
  /** 开工组合提示词前核对项目里这个流程自己的配置；有问题直接抛错（flow.Flow.check）。 */
  check?: (root: string) => void;
}

/** 插件带来的站。flows 是它出现在哪些内置流程里，after 是在这些流程里跟在哪个站后面（找不到时接在最后）。 */
export interface PluginStation {
  id: string;
  name: string;
  nodes: RouteNode[];
  flows: readonly string[];
  after: string;
  sections?: PluginSection[];
  /** 站点的判断函数，键是站点 id。普通站点必须有（漏了 progress.ts 直接报错）。 */
  judges?: Record<string, NodeJudge>;
}

/** 操作的参数，字段与 cli 的 ops/op.ts 的 ParamSpec 相同。 */
export interface PluginParamSpec {
  type: 'string' | 'boolean' | 'integer' | 'number' | 'strings' | 'duration';
  description: string;
  default?: string | number | boolean | string[];
  required?: boolean;
  positional?: number | 'rest';
  flag?: string;
  shorthand?: string;
  cliOnly?: boolean;
}

export interface PluginOpContext {
  out: { write(text: string): void };
  err: { write(text: string): void };
  signal: AbortSignal;
  unsafe: boolean;
}

/** 一条 am 操作，字段与 cli 的 ops/op.ts 的 Op 相同；cli 订阅登记表后照旧 defineOp。 */
export interface PluginOp {
  name: string;
  cli: string[];
  summary: string;
  description?: string;
  examples?: string[];
  params: Record<string, PluginParamSpec>;
  scopes?: ('orchestrator' | 'renderer' | 'cli')[];
  /** 对话里显示这次调用时的说法（一个动词短语，例如「校验发布信息」）；不写按工具名显示。 */
  verb?: string;
  /** 插件页面不能申请调它（flow.pageCallableOp）：要用户本人确认的动作，例如节拍网格的确认。 */
  noPageCall?: boolean;
  run(params: Record<string, unknown>, ctx: PluginOpContext): void | { data?: unknown } | Promise<void | { data?: unknown }>;
}

/**
 * 客户端里的一页（页面组件仍在界面里，按 id 对上）。after 是它在页面表（studioview.ViewPages）里排在哪一页后面；
 * files 是有专门页面的项目文件：编排工具要用户看它们时切到这一页，不开文件页。
 */
export interface PluginPage {
  id: string;
  label: string;
  target: '' | 'scene' | 'scene?' | 'file';
  after: string;
  files?: string[];
  /** 第三方插件能把页面嵌进这一页（清单 slots 的 at）。 */
  slot?: boolean;
}

/** 客户端后端交给插件接口的宿主（studio 的 Server 满足它）。 */
export interface ApiHost {
  projectOr404(): { path: string } | Response;
}

/** 客户端后端的一条接口。pattern 照 studio.ts 路由表的写法：精确路径，或以 / 结尾的子树。 */
export interface PluginRoute {
  pattern: string;
  handle(host: ApiHost, request: Request, rest: string): Response | Promise<Response>;
}

/**
 * 校验项目里的一个文件：客户端后端据此提供 `/api/commands/<id>.check`（写任务，跑 op，参数是 file 与 project_root）。
 * 文件不在时回 400 `<id>_missing`。
 */
export interface PluginValidator {
  id: string;
  label: string;
  file: string;
  op: string;
}

/**
 * 叙事模式（am init --narration、新建对话框）。单口播（solo）是宿主自己的缺省，不登记；
 * 插件登记的模式选中时由 init 写出它的初始文件（目标目录里已有同名文件且内容不同时要报错，不静默覆盖）。
 * 选了这个模式就算在用登记它的插件（流程的 excludes.plugins 据此判断）。
 */
export interface PluginNarration {
  id: string;
  name: string;
  /** 新建对话框里的一句话说明。 */
  hint: string;
  init(target: string): void;
}

/** 新建对话框里的一张卡片：讲解形式（流程）加叙事模式的一种组合，id 唯一。 */
export interface PluginPreset {
  id: string;
  label: string;
  hint: string;
  delivery: string;
  narration: string;
  /** 首页「从例子开始」：缺省画幅与一句示例。 */
  canvas?: string;
  example?: string;
}

/**
 * 整批检查：scene_run_all 渲染之前、concat 拼接之前，按项目做插件自己的核对（例如歌曲时间轴是否覆盖全部镜头）。
 * params 是 scene_run_all 多收的参数（插件自己的输入），值原样交给 beforeRender。
 */
export interface PluginRenderCheck {
  params?: Record<string, PluginParamSpec>;
  beforeRender?(root: string, scenes: readonly Scene[], params: Record<string, unknown>): void;
  beforeConcat?(root: string, scenes: readonly Scene[]): void;
}

/** 开发用命令行的命令组（`am song` 这一层）的说明。 */
export interface PluginOpGroup {
  path: string[];
  summary: string;
  description?: string;
}

/**
 * 一项前置资源（要联网准备的东西，见 prereqs）。字段与 prereqs.Item 相同；later 是客户端安装页「以后可能用到」里
 * 的一组（体积大、用到才装）：同一 group 的几项合成一张卡片，icon 是界面图标名（不认识时用缺省图标）。
 */
export interface PluginPrereq extends PrereqItem {
  later?: { title: string; desc: string; icon?: string };
}

/**
 * 要显式传给子进程（编排工具、渲染器、工具服务）的环境变量：默认值由 value 从当前环境算出，子进程环境的白名单里
 * 没有它所依赖的变量（例如 XDG_DATA_HOME）时，子进程会算出另一个目录。取值顺序同其他配置：环境变量 > 项目 .env > 默认值。
 */
export interface PluginChildEnv {
  key: string;
  value: (env: Record<string, string>) => string;
}

/**
 * 顶栏的一个步骤（studio_step 能标的步骤）。before 是排在宿主哪一步前面（不写或找不到时接在最后）；
 * hint 是写给编排工具的一句说明（「节拍：故事、音乐、节拍网格、分镜计划」），flow 是只有哪个流程用得上（说明里注明）。
 */
export interface PluginStep {
  id: string;
  label: string;
  hint: string;
  before?: string;
  flow?: string;
}

/**
 * 网页上直接触发的一条确定性命令（/api/commands/<id>）：跑一条 am 操作，作为写任务。params 从请求体与项目根算出
 * 操作参数，请求不合格时返回 { error }（回 400，code 是 error.code）。
 */
export interface PluginCommand {
  id: string;
  label: string;
  op: string;
  params(body: Record<string, unknown>, root: string): { params: Record<string, unknown>; label?: string } | { error: { code: string; message: string } };
}

export interface PluginContext {
  /** 插件 id，与 assets/plugins/<id>/am-station.json 的 id 相同（名字、说明都在那份清单里）。 */
  readonly id: string;
  /** 插件目录（缺省 assets/plugins/<id>/），提示词段落的 file 相对它。 */
  readonly dir: string;
  station(s: PluginStation): void;
  flow(f: PluginFlow): void;
  op(op: PluginOp): void;
  page(p: PluginPage): void;
  route(r: PluginRoute): void;
  validator(v: PluginValidator): void;
  /** 渲染技能：技能目录要在内置资产树里（skilltree 门禁查）。每个镜头都带。 */
  skill(desc: SkillDescriptor): void;
  /** 镜头扩展块（scene.json 里功能自己的字段）。 */
  sceneBlock<T>(block: SceneBlock<T>): void;
  narration(n: PluginNarration): void;
  /** 新建对话框的选项卡片。 */
  preset(p: PluginPreset): void;
  /** 项目在用这个插件的凭据（项目里的相对路径）；没在用为空串。新建项目时的互斥（Flow.excludes.plugins）据此判断目标目录。 */
  inUse(judge: (root: string) => string): void;
  renderCheck(c: PluginRenderCheck): void;
  opGroup(g: PluginOpGroup): void;
  prereq(p: PluginPrereq): void;
  childEnv(e: PluginChildEnv): void;
  step(s: PluginStep): void;
  command(c: PluginCommand): void;
  /**
   * 整片风格来源（filmstyle.Source）：进 filmstyle 的来源表，所有项目都看得到。来源要联网准备的数据另登记前置资源
   * （prereq，id 写 styles:<来源 id>），数据目录的覆盖变量另登记 childEnv。来源 id 不能以 x- 开头（那是第三方插件的）。
   */
  filmStyleSource(source: FilmStyleSource): void;
}

export interface BuiltinPlugin {
  id: string;
  /** 插件目录；不写是 assets/plugins/<id>/。 */
  dir?: string;
  apply(ctx: PluginContext): void;
}
