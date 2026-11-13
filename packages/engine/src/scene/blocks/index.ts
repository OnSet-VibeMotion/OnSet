// 宿主自己的镜头扩展块（还没做成插件的卡点）。块在模块加载时向 block.ts 的注册表登记自己，
// scene 的包入口 index.ts 导入本文件。功能插件的块由插件在 apply 里登记（ctx.sceneBlock），不在这里。
// scene 的包入口同时导入 ../plugin（登记全部内置插件），经 `../scene` 用到镜头的地方拿到完整的注册表。
export * from './beat';
