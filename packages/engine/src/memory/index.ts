// Package memory：渲染记忆——把每次渲染写成经历，整理成可检验的经验，渲染前按镜头特征召回，
// 经回放考试才转为长期记忆。移植自 internal/memory，设计见 docs/superpowers/specs/2026-11-02-渲染记忆-design.md。
export * from './memory';
export { Store, open, openReadOnly } from './store';
export * from './events';
export * from './models';
export * from './checks';
export * from './labels';
export {
  SourceRender,
  SourceExam,
  SourceFeedback,
  SourceConversation,
  SourceCheck,
  OutcomeFeedback,
  newFeedback,
  feedbackToJSON,
  newEpisode,
  episodeToJSON,
  parseEpisode,
  firstTry,
  passed,
  failure,
  projectName,
  recordAttempt,
  recordFeedback,
  episodes,
  episodeByID,
} from './episode';
export type { Feedback, Episode, AttemptSource } from './episode';
export {
  featureDescriptions,
  knownFeature,
  features,
  promptText,
  CheckerHuman,
  knownCheckers,
  examinable,
  examinableLesson,
} from './features';
export * from './status';
export {
  newSnapshot,
  snapshotToJSON,
  snapshotMemories,
  snapshotIDs,
  loadSnapshot,
  latestSnapshot,
  resolveSnapshot,
  takeSnapshot,
  drift,
  rollback,
} from './snapshot';
export type { Snapshot, SnapshotEntry } from './snapshot';
export {
  recallItemToJSON,
  recallReason,
  recallResultToJSON,
  recallNames,
  recallSection,
  recallDigest,
  attachRecall,
  DefaultMaxLessons,
  recall,
  recallScene,
  explore,
  draw,
  withExtra,
} from './recall';
export type { RecallItem, Exploration, RecallResult, RecallInput, RecallOptions } from './recall';
export {
  statRate,
  statsToJSON,
  statKey,
  computeStats,
  smoothedRate,
  DormancyMinRecalls,
  weakMemories,
  SuspectMinHarm,
  suspectMemories,
} from './stats';
export type { Stat, Weak, Suspect } from './stats';
export { MaxDescriptionChars, MaxBodyChars, MinRevisionRatio, lint } from './lint';
export type { LintContext } from './lint';
export { preferenceBrief, remember } from './preferences';
export type { RememberInput } from './preferences';
export * from './report';
export { recordUtterance, signalToJSON, preferenceSignals, similar } from './conversation';
export type { Utterance, Signal } from './conversation';
export {
  contrastToJSON,
  clusterToJSON,
  MaxContrasts,
  ClusterKeyHuman,
  clusterFailures,
  copyContrastCode,
  lastConsolidation,
  consolidateResultToJSON,
  consolidate,
  kindLabel,
  consolidationBrief,
  contrastLine,
  distribution,
} from './consolidate';
export type { Cluster, Contrast, Drafter, ConsolidateOptions, ConsolidateResult } from './consolidate';
export * from './exam';
export { importResultToJSON, importProject, dropRetimed, classifyProblems } from './importer';
export type { ImportOptions, ImportResult } from './importer';
