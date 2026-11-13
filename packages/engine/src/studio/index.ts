// 移植自 internal/studio：对话驱动的本地工作台的后端。Electron 主进程经 handle(request) 承接界面请求。
export { Server, newServer, inspectProject, projectMetadata, stageFor } from './studio';
export type { Config, Project, ProjectSummary } from './studio';
export { BusyError, attachmentText, studioInteraction, transcript, type Attachment, type SessionEvent, type SessionMeta } from './sessions';
export { ConflictError, diffTrees, revertTurn, scanTree, statTree, type FileChange, type Turn } from './turns';
export { setInstallOfficialSkills, type SkillInstaller, type SkillsStatus } from './skills';
export { agentOrder } from './agents';
export { describeView, drainViewInbox, validateViewRequest, viewInbox, writeViewRequest } from './view';
export type { ViewPage, ViewRequest, ViewState } from './view';
export type { Task } from './tasks';
