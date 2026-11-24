// Package memory：渲染记忆——把每次渲染写成经历，整理成可检验的经验，渲染前按镜头特征召回，
// 经回放考试才转为长期记忆。设计见 docs/superpowers/specs/2026-11-02-渲染记忆-design.md。

export * from './acceptance';
export * from './checks';
export type { Cluster, ConsolidateOptions, ConsolidateResult, Contrast, Drafter } from './consolidate';
export {
  ClusterKeyHuman,
  clusterFailures,
  clusterToJSON,
  consolidate,
  consolidateResultToJSON,
  consolidationBrief,
  contrastLine,
  contrastToJSON,
  copyContrastCode,
  distribution,
  kindLabel,
  lastConsolidation,
  MaxContrasts,
} from './consolidate';
export type { Signal, Utterance } from './conversation';
export { preferenceSignals, recordUtterance, signalToJSON, similar } from './conversation';
export type { AttemptSource, Episode, Feedback } from './episode';
export {
  episodeByID,
  episodes,
  episodeToJSON,
  failure,
  feedbackToJSON,
  firstTry,
  freezeInput,
  newEpisode,
  newFeedback,
  OutcomeFeedback,
  parseEpisode,
  passed,
  projectName,
  recordAttempt,
  recordFeedback,
  SourceCheck,
  SourceConversation,
  SourceExam,
  SourceFeedback,
  SourceRender,
} from './episode';
export * from './events';
export * from './exam';
export * from './examreads';
export {
  CheckerAudition,
  CheckerHuman,
  examinable,
  examinableLesson,
  featureDescriptions,
  features,
  knownCheckers,
  knownFeature,
  promptText,
} from './features';
export type { ImportOptions, ImportResult } from './importer';
export { importProject, importResultToJSON } from './importer';
export * from './labels';
export type { LintContext } from './lint';
export { lint, MaxBodyChars, MaxDescriptionChars, MinRevisionRatio } from './lint';
export * from './memory';
export * from './models';
export type { RememberInput } from './preferences';
export {
  parseSeriesScope,
  preferenceBrief,
  preferenceMatches,
  remember,
  SeriesScopePrefix,
  seriesScope,
  setPreferenceScope,
} from './preferences';
export type { Exploration, RecallInput, RecallItem, RecallOptions, RecallResult } from './recall';
export {
  attachRecall,
  DefaultMaxLessons,
  draw,
  explore,
  recall,
  recallDigest,
  recallItemToJSON,
  recallNames,
  recallReason,
  recallResultToJSON,
  recallScene,
  recallSection,
  withExtra,
} from './recall';
export * from './report';
export type { Snapshot, SnapshotEntry } from './snapshot';
export {
  drift,
  latestSnapshot,
  loadSnapshot,
  newSnapshot,
  resolveSnapshot,
  rollback,
  snapshotIDs,
  snapshotMemories,
  snapshotToJSON,
  takeSnapshot,
} from './snapshot';
export type { Stat, Suspect, Weak } from './stats';
export {
  computeStats,
  DormancyMinRecalls,
  SuspectMinHarm,
  smoothedRate,
  statKey,
  statRate,
  statsToJSON,
  suspectMemories,
  weakMemories,
} from './stats';
export * from './status';
export { open, openReadOnly, Store } from './store';
export { lessonWritingGuide } from './writing';
