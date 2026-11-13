//
// 整片风格的通用部分：风格来源的接口与登记、风格目录的查找，以及把一种风格装进项目的契约。
//
// am 自身不锁定视觉风格（见制作提示词「视觉方向」）。整片风格是可选项：从某个风格
// 来源里挑一种，装成项目里的一个技能（.agents/skills/am-film-style/），镜头提示词据此
// 把「视觉自由度」换成「遵守整片风格」。
//
// 契约只有三个文件，与来源无关：
//
//	STYLE.md         风格的不变量（渲染器必须遵守）
//	SKILL.md         这套风格在 HyperFrames 镜头里怎么用、技法参考在哪
//	am-film-style.json  来源、风格、版本与内容摘要（ManifestFile）
//
// 其余文件（demo 源码、引擎、模型）由各来源自己决定。镜头渲染与制作提示词只依赖
// 这份契约，不点名任何来源。具体来源由内置插件在 apply 里 ctx.filmStyleSource 登记
// （例如 plugins/lemo-styles），已装的第三方插件清单的 film_styles 由 flow 经 usePluginSources 交进来。
// 新增来源不需要改这里。
//
// 风格来源的数据是前置资源：只由 am setup 经 Source.prepare 下载，其余路径只检查。
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../envutil';
import { compareBytes } from '../gojson';
import { goQuote, goTrimSpace } from '../gofmt';
import type { Writer } from '../hyperframes';
import { pluginFilmStyleSources } from '../plugin/registry';

/** 某个来源风格目录里的一种风格。字段名照抄 Go 的 JSON tag。 */
export interface Style {
  /** 来源 ID；与 slug（来源内的目录名）合起来（styleKey）全局唯一。 */
  source: string;
  slug: string;
  /** 来源内的展示顺序。 */
  order: string;
  cn: string;
  en: string;
  category_cn: string;
  category_en: string;
  uses: string[] | null;
  /** 一句话中文说明（例如来源 demo 片讲了什么）。 */
  summary: string;
  /** 附加标记，例如 three.js（omitempty）。 */
  tags?: string[];
}

/** 全局唯一的风格标识：<来源>/<目录名>（Go 的 Style.Key）。 */
export function styleKey(style: Pick<Style, 'source' | 'slug'>): string {
  return style.source + '/' + style.slug;
}

/** 一行中文说明：中文名、英文名与标识（Go 的 Style.Label）。 */
export function styleLabel(style: Style): string {
  return `${style.cn} ${style.en}（${styleKey(style)}）`;
}

/** Source.prepare 的进度：第 step 步（共 steps 步）在做 stage。 */
export interface PrepareProgress {
  step: number;
  steps: number;
  stage: string;
}

/** 一次前置资源准备（am setup）。 */
export interface PrepareOptions {
  /** 给下载工具用的环境（PATH、HOME、代理、npm 设置）。 */
  env: Record<string, string>;
  output?: Writer;
  progress?: (p: PrepareProgress) => void;
}

/** 一个风格来源。 */
export interface Source {
  /** 来源标识，只用小写字母、数字和连字符，例如 lemo-opuscar。 */
  id(): string;
  /** 给人看的来源名。 */
  name(): string;
  /** 来源的在线图鉴，没有时为空。 */
  gallery(): string;
  /** 来源里的全部风格（source 字段已填），不联网。 */
  catalog(): Style[];
  /** 来源数据在本机的位置，给 am setup 显示。 */
  location(env: Record<string, string>): string;
  /** 判断来源数据是否已就绪，没就绪抛 prereq.MissingError。不联网。 */
  check(env: Record<string, string>): void;
  /** 下载来源数据（只由 am setup 调用），已就绪时直接返回。 */
  prepare(opts: PrepareOptions, signal?: AbortSignal): Promise<void>;
  /** 风格海报的本机路径；没有海报时抛错。 */
  poster(env: Record<string, string>, slug: string): string;
  /**
   * 把风格写进 dir（空的临时目录），至少写出 STYLE.md 与 SKILL.md，返回版本标识
   * （例如上游 commit）。不联网；数据没就绪抛 prereq.MissingError。
   */
  fill(dir: string, style: Style, env: Record<string, string>): string;
}

/** 第三方插件带来的风格来源的 ID 前缀（x-<插件 id>）。 */
export const PluginSourcePrefix = 'x-';

/** 读已装的第三方插件带来的来源（flow/styles.ts 加载时交进来）。内置来源不在这里，在插件登记表里。 */
let pluginSources: () => Source[] = () => [];

/**
 * 交进读第三方插件来源的函数。插件装在用户级，对所有项目与首页都一样；每次 sources() 现读，
 * 装上、去掉插件立即生效。ID 必须以 x- 开头，与内置来源分开。
 */
export function usePluginSources(load: () => Source[]): void {
  pluginSources = load;
}

/**
 * 全部来源，按 ID 排序：内置插件登记的（plugin.PluginContext.filmStyleSource）加已装的第三方插件带来的。
 * ID 重复直接报错。
 */
export function sources(): Source[] {
  const extra = pluginSources();
  for (const source of extra) {
    if (!source.id().startsWith(PluginSourcePrefix)) throw new Error('filmstyle: 插件来源的 ID 要以 x- 开头：' + source.id());
  }
  const all = [...pluginFilmStyleSources().map((o) => o.value), ...extra];
  const seen = new Set<string>();
  for (const source of all) {
    if (seen.has(source.id())) throw new Error('filmstyle: 风格来源重复登记：' + source.id());
    seen.add(source.id());
  }
  // Array.prototype.sort 是稳定排序，对应 sort.SliceStable。
  return all.sort((a, b) => compareBytes(a.id(), b.id()));
}

/** 按 ID 找来源；没有时返回 undefined。 */
export function sourceByID(id: string): Source | undefined {
  return sources().find((source) => source.id() === id);
}

/** 全部来源的风格，按来源、来源内顺序排列。 */
export function catalog(): Style[] {
  const out: Style[] = [];
  for (const source of sources()) out.push(...source.catalog());
  return out;
}

/** 按首次出现的顺序返回某个来源的风格分类（中文名）。 */
export function categories(sourceID: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const style of catalog()) {
    if (style.source === sourceID && !seen.has(style.category_cn)) {
      seen.add(style.category_cn);
      out.push(style.category_cn);
    }
  }
  return out;
}

export interface FindResult {
  style?: Style;
  ok: boolean;
  /** 不带来源的名字在多个来源里都有时的候选。 */
  ambiguous: Style[];
}

/**
 * 按标识（来源/目录名）、目录名、中文名或英文名（不区分大小写）查找风格。
 * 不带来源的名字在多个来源里都有时返回 ambiguous，由调用方要求写全。
 */
export function find(name: string): FindResult {
  const trimmed = goTrimSpace(name);
  const key = trimmed.toLowerCase();
  if (key === '') return { ok: false, ambiguous: [] };
  const matches: Style[] = [];
  for (const candidate of catalog()) {
    if (styleKey(candidate).toLowerCase() === key) return { style: candidate, ok: true, ambiguous: [] };
    if (candidate.slug.toLowerCase() === key || candidate.en.toLowerCase() === key || candidate.cn === trimmed) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) return { ok: false, ambiguous: [] };
  if (matches.length === 1) return { style: matches[0], ok: true, ambiguous: [] };
  return { ok: false, ambiguous: matches };
}

/** 名字里含 name 的风格，供找不到时提示。 */
export function suggest(name: string): Style[] {
  const trimmed = goTrimSpace(name);
  const key = trimmed.toLowerCase();
  if (key === '') return [];
  const out: Style[] = [];
  for (const style of catalog()) {
    if (styleKey(style).toLowerCase().includes(key) || style.en.toLowerCase().includes(key) || style.cn.includes(trimmed)) {
      out.push(style);
    }
  }
  return out.slice(0, 5);
}

/** 与 find 相同，找不到或有歧义时抛出说明清楚的错误。 */
export function lookup(name: string): Style {
  const { style, ok, ambiguous } = find(name);
  if (ok && style) return style;
  const labels = (list: Style[]) => list.map(styleLabel).join('、');
  if (ambiguous.length > 0) {
    throw new Error(`${goQuote(name)} 在多个风格来源里都有：${labels(ambiguous)}。写成「来源/目录名」`);
  }
  let message = `风格目录里没有 ${goQuote(name)}`;
  const candidates = suggest(name);
  if (candidates.length > 0) message += '，相近的有：' + labels(candidates);
  throw new Error(`${message}。用 film_style_list() 查看全部风格`);
}

/** 覆盖全部风格来源数据的根目录。 */
export const RootEnv = 'AM_FILM_STYLES_DIR';

/**
 * 风格来源数据的根目录：RootEnv，否则 <数据目录>/film-styles（envutil.dataDir；环境里什么都没有时按家目录推）。
 * 各来源在它下面以自己的 ID 分目录。
 */
export function rootDir(env: Record<string, string | undefined>): string {
  const dir = env[RootEnv];
  if (dir) return dir;
  return path.join(dataDir(env) || dataDir({ HOME: os.homedir() }), 'film-styles');
}

/** 某个来源的数据目录：<根目录>/<来源 ID>。 */
export function sourceDir(env: Record<string, string | undefined>, sourceID: string): string {
  return path.join(rootDir(env), sourceID);
}
