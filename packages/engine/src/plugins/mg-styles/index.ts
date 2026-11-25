/**
 * 内置插件「MG 动效风格库（MIT）」（mg-styles）：登记源自 MIT 许可项目 Vincentwei1021/mg-styles-15
 * 的 15 套高完成度 MG 整片风格（3 套 Three.js 真 3D + 3 套 WebGL2 着色器 + 9 套 Canvas2D 逐帧绘制），
 * 并向子进程透传离线本地参考帧目录环境变量 ONSET_FILM_STYLE_REFS_DIR。
 */
import { RefsDirEnv } from '../../filmstyle';
import type { BuiltinPlugin } from '../../plugin/types';
import { mgSource } from './source';

export * from './mg';
export { renderAttributionMD, renderSkillMD, renderStyleJSON, renderStyleMD } from './render';
export { mgSource } from './source';

export const mgStyles: BuiltinPlugin = {
  id: 'mg-styles',
  apply(ctx) {
    ctx.filmStyleSource(mgSource);
    // 用户在本地配置了离线参考帧目录时透传给子进程，未配置时不写入。
    ctx.childEnv({ key: RefsDirEnv, value: () => '' });
  },
};
