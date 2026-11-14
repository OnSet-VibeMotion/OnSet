//
// 风格来源 anidoodle（Alex Greenshpun 的代码绘画技能，Apache-2.0）。
//
// 上游不是「风格目录 + demo」的风格库，而是一套 Canvas2D 绘图引擎：每种风格是一个纯函数
// draw(ctx, frame, env) 写成的示范画（TypeScript），多数另有一个笔触工具模块（<风格>Kit.ts），
// references/styles/<风格>.md 写着介质、笔触、边缘、顺序、色板与禁忌。
//
// onset 这样接：onset setup 按固定 commit 稀疏检出风格说明与每种风格用到的模块（catalog.json 的
// modules），在本机用 onset 自己的 Node 运行时把 TypeScript 转成浏览器能直接 import 的 ES 模块
// （build.ts），并从上游图鉴里裁出每种风格的海报；装风格时（fill.ts）把说明、转好的模块、
// TypeScript 原文与接 HyperFrames 的接头（runtime.js.tmpl）写进项目。
//
// 只接画面：上游的配乐、旁白、音效、采样包、发布片模板、Remotion / playwright 工具与 3D（three-core）都没有接。
import catalogData from './catalog.json';
import type { Style } from '../../filmstyle';

/** 这个来源的标识。 */
export const SourceID = 'anidoodle';

/** 上游仓库。 */
export const RepoURL = 'https://github.com/alexgreensh/anidoodle.git';

/** 上游的风格图鉴（一张 32 格的总图）。 */
export const Gallery = 'https://github.com/alexgreensh/anidoodle/blob/main/skills/anidoodle/assets/styles.jpg';

/**
 * onset 安装的上游版本。
 *
 * 固定 commit 而不跟随 main：示范画与笔触模块直接决定成片画面。升级时更新这里，用新 commit 的检出重跑
 * 生成器（gen/main.ts 的 generateCatalog），核对 gen/zh.ts 的中文表与图鉴格子，并对比新旧 core.ts / film.ts
 * 的 Env 与 renderFrame（接头 runtime.js.tmpl 依赖它们）。
 */
export const PinnedCommit = '4ae27d2c281fcfd01bce87ab13dc5ad4df81a795';

/** 该 commit 上的风格数。 */
export const PinnedStyleCount = 32;

/**
 * 指定上游检出目录，覆盖默认位置。指向一份已有检出时直接使用；那是用户自己的检出，onset 不改它的 git 状态，
 * 转好的模块与海报另放在 onset 的数据目录里。
 */
export const LibraryEnv = 'ONSET_ANIDOODLE_LIBRARY';

/** 上游技能在仓库里的位置。 */
export const SkillRoot = 'skills/anidoodle';

/** 引擎源码在仓库里的位置；catalog 的 modules 相对于它。 */
export const EngineSrc = SkillRoot + '/engine/src';

/** 每种风格都要带的引擎模块（帧的契约）。 */
export const CoreModules = ['canvas-core/core.ts', 'canvas-core/film.ts'];

/** catalog.json 里的一种风格。 */
export interface Entry {
  /** onset 里的目录名（上游 id 转成小写连字符）。 */
  slug: string;
  /** 上游的风格 id（camelCase）。 */
  id: string;
  num: string;
  en: string;
  cn: string;
  family: string;
  category_cn: string;
  /** 上游对介质的一句话描述。 */
  medium: string;
  hero: string;
  hero_cn: string;
  uses: string[];
  /** 风格说明在仓库里的路径（references/styles/<x>.md）；上游没写的为空。 */
  doc: string;
  /** 示范画模块与「画出来」的影片模块（相对 EngineSrc）。 */
  module: string;
  draw_film: string;
  /** 这种风格要带的全部模块（相对 EngineSrc，含 CoreModules），按路径排序。 */
  modules: string[];
  /** 图鉴里的格子（行优先）。 */
  cell: number;
}

/** 上游图鉴与裁海报的几何（像素）。 */
export interface Sheet {
  path: string;
  sha256: string;
  cols: number;
  pitch_x: number;
  pitch_y: number;
  inset: number;
  size: number;
}

export interface Catalog {
  commit: string;
  sheet: Sheet;
  /** 随每种风格带上的通用说明（相对仓库根）。 */
  references: string[];
  styles: Entry[];
}

/**
 * 风格目录随程序下发：静态导入，打包时内联进代码（客户端与命令行都是单个 CJS 文件，不能按路径读）。
 */
const data = catalogData as Catalog;

/** 整份目录（副本）。 */
export function catalogFile(): Catalog {
  return JSON.parse(JSON.stringify(data)) as Catalog;
}

/** 固定 commit 上的全部风格，按上游编号排序。返回副本。 */
export function catalog(): Entry[] {
  return catalogFile().styles;
}

/** 按目录名找条目。 */
export function find(slug: string): Entry | undefined {
  return catalog().find((e) => e.slug === slug);
}

/** 一行中文说明。 */
export function entryLabel(entry: Entry): string {
  return `${entry.cn} ${entry.en}（${SourceID}/${entry.slug}）`;
}

/** 转成通用的风格条目。 */
export function entryStyle(entry: Entry): Style {
  return {
    source: SourceID,
    slug: entry.slug,
    order: entry.num,
    cn: entry.cn,
    en: entry.en,
    category_cn: entry.category_cn,
    category_en: entry.family,
    uses: [...entry.uses],
    summary: '示范画：' + entry.hero_cn,
  };
}

/** 上游 id（camelCase）转成 onset 的目录名。 */
export function slugOf(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
