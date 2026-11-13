// Package scene：单镜头的执行契约——scene.json 的加载与校验、渲染提示词、技能解析、
// 输入指纹与渲染记录、尝试记录、镜头局部数据（am-scene.js）、时间合同与交接，以及启动渲染器。
// 移植自 internal/scene。
export * from './scene';
export * from './skills';
export * from './timing';
export * from './scenedata';
export * from './record';
export * from './attempt';
export * from './checks';
export * from './frames';
export * from './verification';
export * from './run';
export * from './live';
export * from './block';
export * from './blocks';
// 内置插件登记的镜头扩展块与渲染技能：导入 plugin 包即登记全部内置插件。
import '../plugin';
