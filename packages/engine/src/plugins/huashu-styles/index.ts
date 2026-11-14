/**
 * 内置插件「花叔艺术动画」（huashu-styles）：登记整片风格来源 huashu（花叔的 huashu-art-motion，MIT）、
 * 它的前置资源（下载、改写引擎与字体表、裁海报；am setup 与安装页「以后可能用到」里的「花叔艺术动画」）
 * 与检出目录的覆盖变量。
 *
 * 实现都在这个目录里：固定 commit 与目录（huashu.ts、catalog.json、gen/）、下载（library.ts）、构建（build.ts）、
 * 装进项目（fill.ts）、接 HyperFrames 的接头（pre.js.tmpl、runtime.js.tmpl）与说明模板。filmstyle 的通用部分与内核不 import 这里。
 */
import type { BuiltinPlugin } from '../../plugin/types';
import { filmStyleSourceItem } from '../../prereqs';
import { LibraryEnv } from './huashu';
import { huashuSource } from './source';

export * from './huashu';
export * from './build';
export * from './library';
export { PreFile, RuntimeFile, SceneFile, SceneName, TemplateFile, fill, sceneOutline, templateHTML, type FillSource } from './fill';
export { huashuSource } from './source';

export const huashuStyles: BuiltinPlugin = {
  id: 'huashu-styles',
  apply(ctx) {
    ctx.filmStyleSource(huashuSource);
    // 安装页「以后可能用到」里单独一张卡片，理由同 anidoodle：几个来源合成一张，一个装了、一个没装时看不出缺的是谁。
    ctx.prereq({ ...filmStyleSourceItem(huashuSource), later: { title: '花叔艺术动画', desc: '给整部片子套一种艺术史上的画风：梵高、莫奈、克里姆特、古埃及壁画、敦煌壁画、包豪斯、波普等 26 种，每一帧都由代码画出', icon: 'styles' } });
    // 用户自己的检出（AM_HUASHU_LIBRARY）设了才传；默认目录在风格根目录下，根目录由 config 显式传。
    ctx.childEnv({ key: LibraryEnv, value: () => '' });
  },
};
