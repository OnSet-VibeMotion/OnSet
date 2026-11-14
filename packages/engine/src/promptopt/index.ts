// 提示词优化：输入框润色与镜头画面描述检查。见 docs/superpowers/specs/2026-11-12-提示词优化-design.md。
export { callOnce, optimizerOf, type CallOptions } from './call';
export { extractJSONObject } from './extract';
export { filePaths, inventedPaths, missing, missingRestrictions, polishKeeps, restrictions, sceneKeeps } from './guard';
export { LastReplyLimit, PolishRejected, buildPolishPrompt, parsePolish, polish, polishLimit, type PolishInput, type PolishResult } from './polish';
export {
  CheckRejected,
  DimensionLabels,
  Dimensions,
  TreatmentLimit,
  applyCheck,
  buildCheckPrompt,
  check,
  checkOutdated,
  checksDir,
  parseCheck,
  readCheck,
  readPromptFile,
  removeCheck,
  rewriteProblems,
  sha256,
  writeCheck,
  type CheckResult,
  type Decision,
  type Dimension,
  type HandoffEvidence,
  type PromptCheck,
  type SceneEvidence,
} from './scenecheck';
export { fillTemplate, readTemplate, templateDir } from './template';
