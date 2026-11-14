//
// 风格来源 huashu（花叔的 huashu-art-motion，MIT）。
//
// 上游是一套浏览器 Canvas2D 动画引擎：engine.js 把时间 t 画成一帧（随机数全部带种子），lib/ 是笔刷、
// 绘画、骨架、后期等十几个库，每种艺术风格是 scenes/<id>.js 里注册的一个场景（SCENES[id] = { draw(c, lt, t) }），
// references/风格配方/<id>.md 是这种风格的配方卡：管线、色板、母题动作、踩过的坑。
//
// am 这样接：am setup 按固定 commit 稀疏检出引擎、库、选中风格的场景与配方卡、要用的字体和全风格总览图，
// 从总览图里裁出每种风格的海报（build.ts）；装风格时（fill.ts）把引擎（去掉预览播放器）、库、这种风格要用的
// 字体与接 HyperFrames 的接头写进项目，原场景放进 source/ 只当技法参考。
//
// 只收实做过、与别的来源不重复、不点名具体作品形象的风格（gen/zh.ts）：上游的研究配方（38–55 号）、
// 质量一星的伦勃朗、与 lemo-opuscar / anidoodle 重复的（水墨、8-bit、橡皮管、皮影、当代扁平），以及吉卜力、
// 新海诚、Kirby、Rick & Morty、南方公园、皮克斯都不接。解说动画语法、口播整片、长卷、配乐与花叔的角色帧也不接。
import catalogData from './catalog.json';
import type { Style } from '../../filmstyle';

/** 这个来源的标识。 */
export const SourceID = 'huashu';

/** 上游仓库。 */
export const RepoURL = 'https://github.com/alchaincyf/huashu-art-motion.git';

/** 上游的全风格总览图（35 段样片各取一帧）。 */
export const Gallery = 'https://github.com/alchaincyf/huashu-art-motion/blob/main/assets/%E5%85%A8%E9%A3%8E%E6%A0%BC%E6%80%BB%E8%A7%88.jpg';

/**
 * am 安装的上游版本。
 *
 * 固定 commit 而不跟随 main：引擎、库与场景直接决定成片画面。升级时更新这里，用新 commit 的检出重跑生成器
 * （gen/main.ts 的 generateCatalog），核对 gen/zh.ts 的中文表与总览图格子，并对比新旧 engine.js 的
 * 「预览 UI」段与 lib/fonts.js 的写法（build.ts 的 patchEngine、fontsScript 依赖它们）。
 */
export const PinnedCommit = '1468196505a51728686db118d52561aa27a25124';

/** 该 commit 上 am 接入的风格数。 */
export const PinnedStyleCount = 26;

/**
 * 指定上游检出目录，覆盖默认位置。指向一份已有检出时直接使用；那是用户自己的检出，am 不改它的 git 状态，
 * 海报另放在 am 的数据目录里。
 */
export const LibraryEnv = 'AM_HUASHU_LIBRARY';

/** 引擎在仓库里的位置。 */
export const EngineDir = 'scripts/engine';

/** 配方卡在仓库里的位置。 */
export const RecipesDir = 'references/风格配方';

/** 引擎里随每种风格带上的文件（相对 EngineDir）。 */
export const EngineFiles = ['engine.js', 'transitions.js'];

/** 字体目录（相对 EngineDir）与随字体带上的许可文件。 */
export const FontsDir = 'lib/fonts';
export const FontLicenses = ['LICENSES.md', 'OFL.txt'];

/** 一个字体：family 是代码里 ctx.font 用的名字，file 是 FontsDir 下的文件名。 */
export interface Font {
  family: string;
  file: string;
}

/** catalog.json 里的一种风格。 */
export interface Entry {
  /** am 里的目录名。 */
  slug: string;
  /** 上游的场景 id（例如 02_egypt）。 */
  id: string;
  num: string;
  en: string;
  cn: string;
  category_cn: string;
  category_en: string;
  uses: string[];
  /** 上游风格索引里的定位：材料层（可盖在任何题材上）或时代标本（样片把时代母题做得很突出）。 */
  layer: string;
  /** 上游索引里的质量（★★★ / ★★）与当前短板。 */
  quality: string;
  weakness: string;
  /** 上游索引里的核心渲染器与手法、母题动作（画怎么活）。 */
  technique: string;
  motifs: string;
  /** 场景源码与配方卡（相对仓库根）。 */
  scene: string;
  card: string;
  /** 这种风格要带的字体：场景源码用到的西文字体加一种中文字体，按 family 排序。 */
  fonts: Font[];
  /** 画面里写中文时用的字体 family（fonts 里的一个）。 */
  cjk: string;
  /** 在总览图里的格子（行优先，从 0 数）。 */
  cell: number;
}

/** 总览图与裁海报的几何（像素）：第 n 格左上角是 (x0 + n%cols·pitch_x, y0 + ⌊n/cols⌋·pitch_y)。 */
export interface Sheet {
  path: string;
  sha256: string;
  cols: number;
  x0: number;
  y0: number;
  pitch_x: number;
  pitch_y: number;
  w: number;
  h: number;
}

export interface Catalog {
  commit: string;
  sheet: Sheet;
  /** 引擎的库脚本（相对 EngineDir，按 index.html 里的加载顺序；不含 fonts.js 与 three.min.js）。 */
  libs: string[];
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

/** 全部风格，按上游编号排序。返回副本。 */
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
    category_en: entry.category_en,
    uses: [...entry.uses],
    summary: entry.technique,
  };
}
