/**
 * 第三方站与内置插件。原来全在这一个文件里，现在按职责拆开，这里只转出，免得已有的 import 要改：
 *
 * | 文件 | 内容 |
 * |---|---|
 * | manifest.ts | 清单类型、字段分级（ManifestFields）、格式版本与 am 版本兼容 |
 * | parse.ts | 解析与校验 am-station.json |
 * | fields.ts | 解析用的小工具（路径校验、拒收不认识的字段） |
 * | pages.ts | 清单到路线、页面、工具名的映射 |
 * | lock.ts | 项目的 article-to-motion.flow.json |
 * | digest.ts | 站目录的内容摘要（带进程内缓存） |
 * | fetch.ts | 来源、git 下载、读清单与检查文件 |
 * | load.ts | 读出项目加的站、路线用的站、选用的流程 |
 * | update.ts | 升级一个第三方站 |
 * | builtinplugins.ts | 内置插件与 am_* 认领 |
 * | promptparts.ts | 插件标记、阶段插入、接在最后的说明 |
 * | skills.ts | 第三方渲染技能 |
 */
export {
  ManifestFile,
  ManifestFields,
  ManifestVersion,
  HookEvents,
  SlotPages,
  amVersion,
  checkCompatible,
  compareSemver,
  experimentalFields,
  manifestFieldNames,
  validSemver,
  type FieldTier,
  type HookEvent,
  type Manifest,
  type ManifestCommand,
  type ManifestFlow,
  type ManifestNode,
  type ManifestOp,
  type ManifestPage,
  type ManifestParam,
  type ManifestPermissions,
  type ManifestSetting,
  type ManifestSlot,
  type ParamType,
  type SlotPage,
} from './manifest';
export { parseManifest, type ParseOptions } from './parse';
export { pageCallableOp, pageMayRead, pageTab, toExtra, toolName } from './pages';
export { addToProject, flowRecord, LockFile, readLock, recordFlow, removeFromProject, type FlowRecord, type LoadedStation, type Lock, type LockEntry } from './lock';
export { treeDigest } from './digest';
export { fetchStation, parseSource, StationsDirEnv, stationsDir, writeStationForTest } from './fetch';
export { activeFlowStation, loadProjectStations, projectExtras, setProjectFlow } from './load';
export { permissionLines, updateStation, type StationUpdate } from './update';
export { builtinPluginIDs, builtinPlugins, builtinPluginsDir, disabledBuiltins, disabledPluginOps, disabledPluginStations, inUse, setBuiltinEnabled, stationOwners } from './builtinplugins';
export { applyPluginMarkers, extraPrompt, insertStageSections, markPluginSection } from './promptparts';
export { pluginSkillsFor } from './skills';
