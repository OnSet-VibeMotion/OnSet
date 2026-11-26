// Package determinism：静态扫描镜头合成源码，拦下会让渲染结果不可复现的写法。

export type {
  EngineContractIssue,
  EngineContractOptions,
  EngineContractReport,
  EngineDeviation,
} from './engine_contract';
export {
  checkEngineContract,
  formatEngineContractIssue,
  resolveSceneEngineContract,
} from './engine_contract';
export type { Rule } from './rules';
export { AllowMarker, isIgnoredRef, isRemote, remoteProblem, ruleIDs, scriptRules } from './rules';
export type { Finding, Report } from './scan';
export { findingString, problems, ReportSchemaVersion, scan, writeJSON } from './scan';
