import catalogData from './catalog.json';
//
// 风格来源 lemo-opuscar（LemoLab 的风格库，MIT + demo CC BY 4.0）。
//
// 它实现 filmstyle.Source：风格目录随程序下发（catalog.json），风格库本体由 am setup
// 下载到 <风格根目录>/lemo-opuscar/<commit>（prepareLibrary），装风格时把 STYLE.md、demo
// 源码、core/ 工具与 demo 实际用到的 three.js 模块、模型写进项目（fill），SKILL.md 说明
// lemo 的页面契约（window.render(t)）怎么换成 HyperFrames 的 hf-seek。
//
// 只接画面。风格库的配乐工具（core/audio/ 的采样乐器、拨弦建模）是 Python 写的，
// 要一套 Python 环境和约 1.4 GB 采样库，刻意没有接：配乐仍按制作流程选授权素材，
// STYLE.md 的 Sound palette 只作为配乐方向的参考。
import type { Style } from '../filmstyle';

/** 这个来源的标识。 */
export const SourceID = 'lemo-opuscar';

/** 风格库的上游仓库。 */
export const RepoURL = 'https://github.com/lemomo-ai/lemo-opuscar.git';

/** 上游图鉴，每种风格都有 demo 片可看。 */
export const Gallery = 'https://lemomo-ai.github.io/lemo-opuscar/';

/**
 * am 安装的风格库版本。
 *
 * 固定 commit 而不跟随 main：STYLE.md 与 demo 引擎的变化会直接改变成片画面，
 * 跟随 main 的话同一个项目两次安装可能拿到不同的风格。升级时更新这里、
 * 用新 commit 的检出重跑生成器（gen/main.ts 的 generateCatalog），
 * 并对比新旧 core/lib.js 与页面契约（core/README.md「The page contract」）。
 */
export const PinnedCommit = 'bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00';

/** 该 commit 上的风格数（不含 _template）。 */
export const PinnedStyleCount = 66;

/**
 * 指定风格库目录，覆盖默认位置。指向一份已有检出时直接使用；
 * 那是用户自己的检出，am 不改它的 git 状态。
 */
export const LibraryEnv = 'AM_LEMO_OPUSCAR_LIBRARY';

/** catalog.json 里的一项，字段取自上游 styles/<slug>/style.json。字段名照抄 Go 的 JSON tag。 */
export interface Entry {
  slug: string;
  num: string;
  en: string;
  cn: string;
  category_en: string;
  category_cn: string;
  film: string;
  line: string;
  line_cn: string;
  uses: string[] | null;
  demo_seconds: number;
  /** demo 用 three.js：安装时要把 three 一起带进技能目录。 */
  three_js: boolean;
}

/** 一行中文说明。 */
export function entryLabel(entry: Entry): string {
  return `${entry.cn} ${entry.en}（${SourceID}/${entry.slug}）`;
}

/** 转成通用的风格条目。 */
export function entryStyle(entry: Entry): Style {
  const style: Style = {
    source: SourceID,
    slug: entry.slug,
    order: entry.num,
    cn: entry.cn,
    en: entry.en,
    category_cn: entry.category_cn,
    category_en: entry.category_en,
    uses: entry.uses,
    summary: 'demo：' + entry.line_cn,
  };
  if (entry.three_js) style.tags = ['three.js'];
  return style;
}

/**
 * 风格目录随程序下发（Go 版用 go:embed）：静态导入，打包时内联进代码。不能按 import.meta.url 去读文件——
 * 客户端与命令行都被打成单个 CJS 文件，那里既没有 import.meta.url，也没有这份 json 的原路径。
 */
const catalogEntries: Entry[] = catalogData as Entry[];

/** 固定 commit 上的全部风格，按上游编号排序。返回副本。 */
export function catalog(): Entry[] {
  return catalogEntries.map((entry) => ({ ...entry, uses: entry.uses ? [...entry.uses] : entry.uses }));
}

/** 按目录名找条目。 */
export function find(slug: string): Entry | undefined {
  const entry = catalogEntries.find((e) => e.slug === slug);
  return entry ? { ...entry } : undefined;
}
