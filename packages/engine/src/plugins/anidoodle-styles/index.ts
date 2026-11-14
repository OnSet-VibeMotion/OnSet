/**
 * 内置插件「anidoodle 代码绘画」（anidoodle-styles）：登记整片风格来源 anidoodle（Alex Greenshpun，Apache-2.0）、
 * 它的前置资源（下载、把 TypeScript 转成浏览器模块、裁海报；am setup 与安装页「以后可能用到」里的「整片风格库」）
 * 与检出目录的覆盖变量。
 *
 * 实现都在这个目录里：固定 commit 与目录（anidoodle.ts、catalog.json、gen/）、下载（library.ts）、构建（build.ts）、
 * 装进项目（fill.ts）、接 HyperFrames 的接头（runtime.js.tmpl）与 SKILL.md 模板。filmstyle 的通用部分与内核不 import 这里。
 */
import type { BuiltinPlugin } from '../../plugin/types';
import { filmStyleSourceItem } from '../../prereqs';
import { LibraryEnv } from './anidoodle';
import { anidoodleSource } from './source';

export * from './anidoodle';
export * from './build';
export * from './library';
export { RuntimeFile, fill, type FillSource } from './fill';
export { anidoodleSource } from './source';

export const anidoodleStyles: BuiltinPlugin = {
  id: 'anidoodle-styles',
  apply(ctx) {
    ctx.filmStyleSource(anidoodleSource);
    // 与 lemo 同在安装页「以后可能用到」的「整片风格库」卡片里（按 group 合成一张）。
    ctx.prereq({ ...filmStyleSourceItem(anidoodleSource), later: { title: '整片风格库', desc: '给整部片子套一种现成画风', icon: 'styles' } });
    // 用户自己的检出（AM_ANIDOODLE_LIBRARY）设了才传；默认目录在风格根目录下，根目录由 config 显式传。
    ctx.childEnv({ key: LibraryEnv, value: () => '' });
  },
};
