// Package determinism：静态扫描镜头合成源码，拦下会让渲染结果不可复现的写法。移植自 internal/determinism。
export { AllowMarker, ruleIDs, scriptRules, remoteProblem, isRemote, isIgnoredRef } from './rules';
export type { Rule } from './rules';
export { ReportSchemaVersion, findingString, problems, scan, writeJSON } from './scan';
export type { Finding, Report } from './scan';
