/**
 * 内置插件「LemoLab 风格库」（lemo-styles）：登记整片风格来源 lemo-opuscar（LemoLab，MIT + demo CC BY 4.0）、
 * 它的前置资源（风格库下载，am setup 与安装页「以后可能用到」里的「整片风格库」）与风格库目录的覆盖变量。
 *
 * 实现都在这个目录里：固定 commit 与目录清单（lemo.ts、catalog.json）、分段续传的下载（library.ts、prepare.ts）、
 * 装进项目时只挑实际用到的 three.js 模块与素材（select.ts）、SKILL.md 模板（skill.md.tmpl）。
 * filmstyle 的通用部分与内核不 import 这里。
 */
import type { BuiltinPlugin } from '../../plugin/types';
import { filmStyleSourceItem } from '../../prereqs';
import { LibraryEnv } from './lemo';
import { lemoSource } from './source';

export * from './lemo';
export * from './library';
export * from './prepare';
export { copyPath, fill, renderSkill } from './fill';
export { referencedAssets, sourceTexts, threeClosure } from './select';
export { lemoSource } from './source';

export const lemoStyles: BuiltinPlugin = {
  id: 'lemo-styles',
  apply(ctx) {
    ctx.filmStyleSource(lemoSource);
    // 只有选了整片风格才要；安装页把它放进「以后可能用到」。
    ctx.prereq({ ...filmStyleSourceItem(lemoSource), later: { title: '整片风格库', desc: '给整部片子套一种现成画风', icon: 'styles' } });
    // 用户自己的检出（AM_LEMO_OPUSCAR_LIBRARY）设了才传；默认目录在风格根目录下，根目录由 config 显式传。
    ctx.childEnv({ key: LibraryEnv, value: () => '' });
  },
};
