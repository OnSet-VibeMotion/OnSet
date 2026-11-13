// Package project：am init 的骨架叠加、项目规则派生与整片制作提示词。
export { initialize, initializeWithFiles, rejectSymlinkPath, validPath } from './init';
export type { InitResult, SourceTree } from './init';
export { RulesTemplate, writeRules } from './rules';
export { flowPromptFile, legacyRunPrompt, ProductionPrompt, promptSource, runPrompt } from './runprompt';
export type { RunPromptResult } from './runprompt';
