/**
 * 第三方站与内置插件。原来全在这一个文件里，现在按职责拆开，这里只转出，免得已有的 import 要改：
 *
 * | 文件 | 内容 |
 * |---|---|
 * | manifest.ts | 清单类型、字段分级（ManifestFields）、格式版本与 onset 版本兼容 |
 * | parse.ts | 解析与校验 onset-station.json |
 * | fields.ts | 解析用的小工具（路径校验、拒收不认识的字段） |
 * | pages.ts | 清单到路线、页面、工具名的映射 |
 * | lock.ts | 项目的 onset.flow.json（新建时记下的流程） |
 * | installed.ts | 用户级的已装插件清单 |
 * | digest.ts | 站目录的内容摘要（带进程内缓存） |
 * | fetch.ts | 来源、git 下载、读清单与检查文件 |
 * | load.ts | 读出全部插件、路线用的站、读不出来的插件参与了哪些制作 |
 * | update.ts | 已装插件清单的读写、升级前后的差异 |
 * | staging.ts | 装与升级的两步：取到暂存处、给用户看、装上或取消 |
 * | builtinplugins.ts | 内置插件与 am_* 认领 |
 * | promptparts.ts | 第三方站的阶段补充与接在最后的说明 |
 * | skills.ts | 第三方渲染技能 |
 */
export {
  ManifestFile,
  ManifestFields,
  ManifestVersion,
  HookEvents,
  onsetVersion,
  checkCompatible,
  compareSemver,
  experimentalFields,
  manifestFieldNames,
  nodeFieldNames,
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
export { flowRecord, LockFile, readLock, recordFlow, type FlowRecord, type Lock } from './lock';
export { InstalledFile, readInstalled, roleOf, type Installed, type InstalledEntry, type InstalledRole, type LoadedStation } from './installed';
export { treeDigest } from './digest';
export { fetchStation, parseSource, StationsDirEnv, stationsDir, withGitProxy, writeStationForTest } from './fetch';
export * as market from './market';
export { fetchArchive, githubArchiveURL, MaxArchiveBytes } from './archive';
export { brokenParticipants, loadStations, stationExtras, type LoadedStations, type StationProblem } from './load';
export { installedEntry, installStation, permissionLines, removeStation, updateDiff, type StationUpdate } from './update';
export { discardStaged, HookEventLabels, installStaged, previewOf, readStaged, stageStation, stageUpdate, StagingDir, type StageExpect, type Staged, type StationPreview } from './staging';
export { builtinPluginIDs, builtinPlugins, builtinPluginsDir, stationOwners } from './builtinplugins';
export { extraPrompt } from './promptparts';
export { pluginSkillsFor } from './skills';
