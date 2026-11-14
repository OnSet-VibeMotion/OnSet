/**
 * 第三方站的清单 onset-station.json：类型、字段分级与兼容性。设计见 docs/superpowers/specs/2026-11-11-流程插件-design.md，
 * 写给插件作者的说明见 docs/plugin-authoring.md（字段与这里的 ManifestFields 一一对应，有单测核对）。
 *
 * 一个第三方站是一个目录，根上一份 onset-station.json（Manifest）。它只能声明：提示词文本、路线上的站点
 * （声明式判断）、会写的文件、子进程执行的操作。代码不进 onset 的进程，操作在子进程里跑（run.ts）。
 */
import { compatVersion } from '../version';
import type { DeclaredGuide, DeclaredState, PathRule } from './types';

export const ManifestFile = 'onset-station.json';

/** 这一版 onset 读得懂的清单格式版本。清单不写 manifest_version 时按 1 读。 */
export const ManifestVersion = 1;

export type ParamType = 'string' | 'boolean' | 'integer' | 'number' | 'strings';

export interface ManifestParam {
  type: ParamType;
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface ManifestOp {
  name: string;
  summary: string;
  description?: string;
  examples?: string[];
  /** 第一个元素带 `/` 时是站目录里的相对路径，否则按 PATH 找（如 node、python3）。其余参数原样传。 */
  command: string[];
  params: Record<string, ManifestParam>;
  /** agent：编排工具能调（登记成 x_<站>_<操作> 工具）；user：只有用户在界面上点按钮才执行（发布这类对外动作）。 */
  trigger: 'agent' | 'user';
}

export interface ManifestNode {
  id: string;
  label: string;
  step: string;
  gate?: boolean;
  page?: string;
  outputs: string[];
  stale_after: string[];
  gate_files: string[];
  /** 按项目文件里的一个字段定这一站的状态、说明与在等谁（实验性）。 */
  state?: DeclaredState;
  /** 「接下来」卡片的说法与按钮（实验性）。 */
  guide?: DeclaredGuide;
}

/**
 * 插件自己的页面：站目录里的一个 HTML（entry），在客户端的画面面板里以沙箱 iframe 打开（studio/stations.ts）。
 * 页面碰不到 onset 的接口，也连不了网，只能经宿主转交：读 reads 里声明的项目文件（以及站自己声明会写的文件）、
 * 请用户确认后执行本站的操作、把一段话填进对话框。
 */
export interface ManifestPage {
  id: string;
  label: string;
  entry: string;
  /** 页面能读的项目文件：以 `/` 结尾是目录前缀，否则是整条路径。 */
  reads: string[];
}

/** 插件的一项设置：设置页按它出表单；secret 类只交给插件自己的子进程，页面与接口都看不到值。 */
export interface ManifestSetting {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'secret';
  description: string;
  options: string[];
  default?: string | number | boolean;
}

/** 插件要的权限，添加时与设置页里给用户看。 */
export interface ManifestPermissions {
  /** 页面能拿到项目摘要（镜头、制作路线、发布信息、画幅、风格）。 */
  project: boolean;
  /** 页面能连的地址（https://域名[:端口]）。不写就完全不能连网。 */
  network: string[];
  /** 页面能请用户确认后调用的 onset 操作（只限编排工具本来就能用的那些，见 pageCallableOp）。 */
  uses: string[];
}

/** 事件钩子：事件发生时自动跑本站的一条操作（只限 trigger 为 agent 的操作）。 */
export const HookEvents = ['turn.finished', 'task.finished', 'gate.confirmed', 'film.approved'] as const;
export type HookEvent = (typeof HookEvents)[number];

/** 插件页面能嵌进的自带页面。 */
/** 嵌小窗的页面 id：取值见 studioview.slotPages()（页面表里标了 slot 的页）。 */
export type SlotPage = string;

export interface ManifestSlot {
  at: SlotPage;
  page: string;
  /** iframe 高度（像素），缺省 240。 */
  height: number;
}

/** 第三方站带来的流程。stations 里写内置站的 id 与本站自己的 id（本站的站点排在那里）。 */
export interface ManifestFlow {
  name: string;
  stations: string[];
  /** 顶栏第一步：script、beat，或本站页面的 id。 */
  first_page: string;
  /** 这套流程的制作提示词（替换内置流程的各阶段，onset 的公共约定照旧在前）。 */
  prompt: string;
}

/** 对话输入框的斜杠命令：打开本站的页面，或把一段话填进输入框。 */
export interface ManifestCommand {
  name: string;
  description: string;
  page: string;
  prompt: string;
}

export interface Manifest {
  /** 清单格式版本（缺省 1）。 */
  manifest_version: number;
  /** 对 onset 的要求：onset 是最低版本（x.y.z），空是不限。 */
  requires: { onset: string };
  id: string;
  version: string;
  name: string;
  /** 一句话说明它做什么（设置页显示）。 */
  description: string;
  after: string;
  replaces: string;
  prompt: string;
  nodes: ManifestNode[];
  produces: PathRule[];
  ops: ManifestOp[];
  pages: ManifestPage[];
  settings: ManifestSetting[];
  permissions: ManifestPermissions;
  hooks: { on: HookEvent; op: string }[];
  /** 定时：客户端开着、项目打开着时，每隔 every_minutes 分钟跑一次本站的操作（只限 agent 操作）。 */
  schedules: { every_minutes: number; op: string }[];
  /** 插进制作提示词某个阶段末尾的说明（stage 是阶段名，见 flow.stageTitles）。 */
  inserts: { stage: string; file: string }[];
  /** 整套流程（新片型）：项目在设置页选用它后，制作路线、顶栏第一步与制作提示词都换成它的。 */
  flow: ManifestFlow | null;
  /** 这个站提供的配音、对齐工具：项目把 TTS_PROVIDER / ALIGN_PROVIDER 设成 x:<站 id> 时，编排工具用这条操作。 */
  provides: { tts?: { name: string; op: string; timestamps: 'none' | 'sentence' | 'word' }; align?: { name: string; op: string } };
  /**
   * 给渲染器的技能（站目录里含 SKILL.md 的目录）。scenes 为 all 时每个镜头都带上——加上它，已渲染的镜头
   * 会标成要重渲染（渲染输入变了）；opt-in 时只有 scene.json 的 plugin_skills 点名的镜头带上。
   */
  renderer_skills: { name: string; dir: string; summary: string; scenes: 'all' | 'opt-in' }[];
  /**
   * 整片风格库：dir 下每个子目录是一种风格（STYLE.md 必需，SKILL.md、poster.jpg、style.json 可选）。
   * only_referenced 为真时装进项目只带用到的素材与 three.js 模块（filmstyle.DirectorySource 的 onlyReferenced）。
   */
  film_styles: { name: string; dir: string; only_referenced?: boolean } | null;
  /** 界面皮肤：插件目录里的皮肤 JSON（每份一个皮肤，格式见 skin.parseSkin）。 */
  skins: string[];
  slots: ManifestSlot[];
  commands: ManifestCommand[];
}

// ---------------------------------------------------------------------------
// 字段分级

/**
 * 字段分级：stable 是承诺兼容的；experimental 以后的版本可能调整（设置页、station_add 会照实告诉用户）。
 * 内置插件与第三方站用同一份字段：内置插件带来的代码在进程内登记（apply），不经清单。
 */
export type FieldTier = 'stable' | 'experimental';

/**
 * 清单顶层字段的唯一来源：解析器只认这里列出的字段，作者文档（docs/plugin-authoring.md）也按它核对。
 * used 判断一份解析好的清单是否真的用到了这个字段（给实验性字段报告用）。
 */
export const ManifestFields: readonly { name: string; tier: FieldTier; parent?: 'nodes'; used?: (m: Manifest) => boolean }[] = [
  { name: 'manifest_version', tier: 'stable' },
  { name: 'requires', tier: 'stable' },
  { name: 'id', tier: 'stable' },
  { name: 'version', tier: 'stable' },
  { name: 'name', tier: 'stable' },
  { name: 'description', tier: 'stable' },
  { name: 'after', tier: 'stable' },
  { name: 'replaces', tier: 'stable' },
  { name: 'prompt', tier: 'stable' },
  { name: 'nodes', tier: 'stable' },
  { name: 'produces', tier: 'stable' },
  { name: 'ops', tier: 'stable' },
  { name: 'pages', tier: 'stable' },
  { name: 'settings', tier: 'stable' },
  { name: 'permissions', tier: 'stable' },
  { name: 'hooks', tier: 'experimental', used: (m) => m.hooks.length > 0 },
  { name: 'schedules', tier: 'experimental', used: (m) => m.schedules.length > 0 },
  { name: 'slots', tier: 'experimental', used: (m) => m.slots.length > 0 },
  { name: 'commands', tier: 'experimental', used: (m) => m.commands.length > 0 },
  { name: 'inserts', tier: 'experimental', used: (m) => m.inserts.length > 0 },
  { name: 'flow', tier: 'experimental', used: (m) => m.flow !== null },
  { name: 'provides', tier: 'experimental', used: (m) => m.provides.tts !== undefined || m.provides.align !== undefined },
  { name: 'renderer_skills', tier: 'experimental', used: (m) => m.renderer_skills.length > 0 },
  { name: 'film_styles', tier: 'experimental', used: (m) => m.film_styles !== null },
  { name: 'skins', tier: 'experimental', used: (m) => m.skins.length > 0 },
  // 站点（nodes[]）里的字段：基本的几项是稳定的，按文件内容定状态与「接下来」是实验性的。
  ...['id', 'label', 'step', 'gate', 'page', 'outputs', 'stale_after', 'gate_files'].map((name) => ({ name: `nodes.${name}`, tier: 'stable' as const, parent: 'nodes' as const })),
  { name: 'nodes.state', tier: 'experimental', parent: 'nodes', used: (m) => m.nodes.some((n) => n.state !== undefined) },
  { name: 'nodes.guide', tier: 'experimental', parent: 'nodes', used: (m) => m.nodes.some((n) => n.guide !== undefined) },
];

/** 解析器认的顶层字段名。 */
export function manifestFieldNames(): string[] {
  return ManifestFields.filter((f) => !f.parent).map((f) => f.name);
}

/** 解析器认的站点（nodes[]）字段名，不带 `nodes.` 前缀。 */
export function nodeFieldNames(): string[] {
  return ManifestFields.filter((f) => f.parent === 'nodes').map((f) => f.name.slice('nodes.'.length));
}

/** 这份清单用到了哪些实验性字段（按 ManifestFields 的顺序）。 */
export function experimentalFields(m: Manifest): string[] {
  return ManifestFields.filter((f) => f.tier === 'experimental' && f.used?.(m) === true).map((f) => f.name);
}

// ---------------------------------------------------------------------------
// 兼容性

/**
 * 兼容检查用的 onset 版本（version.compatVersion）：客户端里是客户端的版本号（主进程用 app.getVersion() 设的宿主版本），
 * 命令行里是 `onset --version` 的版本号（与渲染指纹同一个来源）。
 */
export function onsetVersion(): string {
  return compatVersion();
}

const semverPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 版本号是否合法（x.y.z，可带 -预发布与 +构建）。 */
export function validSemver(v: string): boolean {
  return semverPattern.test(v.trim());
}

/** 比较两个 semver：a < b 为负、相等为 0、a > b 为正。预发布版低于同号的正式版。 */
export function compareSemver(a: string, b: string): number {
  const pa = semverPattern.exec(a.trim());
  const pb = semverPattern.exec(b.trim());
  if (!pa || !pb) throw new Error(`不是合法的版本号：${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const ra = pa[4] ?? '';
  const rb = pb[4] ?? '';
  if (ra === rb) return 0;
  if (ra === '') return 1;
  if (rb === '') return -1;
  const xa = ra.split('.');
  const xb = rb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb) {
      const d = Number(xa[i]) - Number(xb[i]);
      if (d !== 0) return d;
    } else if (na !== nb) return na ? -1 : 1;
    else if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 这一版 onset 能不能用这份清单。onset 的版本号不是 x.y.z（本地构建是 dev）时不查最低版本：开发版就是最新的代码。
 */
export function checkCompatible(m: Pick<Manifest, 'id' | 'manifest_version' | 'requires'>, current = onsetVersion()): void {
  if (m.manifest_version > ManifestVersion) {
    throw new Error(`这个插件（${m.id}）的清单格式是第 ${m.manifest_version} 版，要更新的片场才能用（这一版只认到第 ${ManifestVersion} 版）`);
  }
  if (m.requires.onset !== '' && validSemver(current) && compareSemver(current, m.requires.onset) < 0) {
    throw new Error(`这个插件（${m.id}）要片场 ${m.requires.onset} 或更新的版本，现在是 ${current}，请先更新片场`);
  }
}
