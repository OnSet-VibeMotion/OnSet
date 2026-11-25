// Package scene：单镜头的执行契约——scene.json 的加载与校验、渲染提示词、技能解析、
// 输入指纹与渲染记录、尝试记录、镜头局部数据（onset-scene.js）、时间合同与交接，以及启动渲染器。

export * from './attempt';
export * from './block';
export * from './checks';
export * from './component-plan';
export * from './components';
export * from './edits';
export * from './failure';
export * from './frames';
export * from './lease';
export * from './live';
export * from './motion_prompt';
export * from './record';
export { parseRepairIssues, type RepairIssue } from './repair';
export * from './resume';
export * from './run';
export * from './sandbox';
export * from './scene';
export * from './scenedata';
export * from './seam';
export * from './skills';
export * from './timing';
export * from './verification';

// 内置插件登记的镜头扩展块与渲染技能：导入 plugin 包即登记全部内置插件。
import '../plugin';
