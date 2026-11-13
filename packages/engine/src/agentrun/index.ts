// 运行编排工具，把各家 CLI 的结构化输出统一成同一套事件。
export * from './parse';
export * from './run';
export type { AskPermission, PermissionAnswer } from './interactive';
export { commandAllowed, unwrapShell } from './interactive';
