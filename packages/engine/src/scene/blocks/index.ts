// 内置的镜头扩展块。每个块在模块加载时向 block.ts 的注册表登记自己，登记靠 import 的副作用，
// 所以集中在这一处 import（理由同 filmstyle/sources/index.ts）：scene 的包入口 index.ts 导入本文件，
// 任何经 `../scene` / `@am/engine/scene` 用到镜头的地方都拿到完整的注册表。
// 新增一种块：在 scene/blocks/ 下写一个模块、调用 registerBlock，并在这里加一行。
export * from './cast';
export * from './song';
export * from './beat';
