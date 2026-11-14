// Package plugin：内置插件的进程内登记（apply(ctx)）。见 types.ts 与 registry.ts。
// 导入 ../plugins 是为了登记全部内置插件：凡是经这个包取登记表的地方都拿得到。
import '../plugins';

export * from './registry';
export type * from './types';
