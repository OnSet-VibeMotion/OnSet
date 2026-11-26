// 对话驱动的本地工作台的后端。Electron 主进程经 handle(request) 承接界面请求。

export { agentOrder } from './agents';
export { startOperationBroker } from './opbroker';
export { assertPilotGateUnlocked } from './progress';
export {
  type Attachment,
  attachmentText,
  BusyError,
  type SessionEvent,
  type SessionMeta,
  studioInteraction,
  transcript,
} from './sessions';
export { type SkillInstaller, type SkillsStatus, setInstallOfficialSkills } from './skills';
export { currentSkin, skinJSON } from './skins';
export { readStoryboard, type StoryboardResponse, type StoryboardScene } from './storyboard';
export type { Config, Project, ProjectSummary } from './studio';
export { inspectProject, newServer, projectMetadata, Server, stageFor } from './studio';
export type { Task } from './tasks';
export { ConflictError, diffTrees, type FileChange, revertTurn, scanTree, statTree, type Turn } from './turns';
export type { ViewPage, ViewRequest, ViewState } from './view';
export { describeView, drainViewInbox, validateViewRequest, viewInbox, writeViewRequest } from './view';
