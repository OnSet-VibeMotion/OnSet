// Package align：把强制对齐结果映射回终稿，产出 voice.srt、phrase-timeline.json 与 align-report.json。

export type { Irregular, Options, PhraseStat, Report, Result } from './build';
export {
  build,
  HintConfidence,
  MinMatchRate,
  ReportSchemaVersion,
  reportToJSON,
  sortedLabels,
  writeJSON,
} from './build';
export type { Cue } from './cue';
export { formatSRT, MaxCueUnits, writeSRT } from './cue';
export type { Item, Segment } from './evidence';
export { CanonicalShape, loadEvidence, loadSegments, parseSegmentFlag } from './evidence';
export { LabelExact, LabelInsertion, LabelMerge, LabelOmission, LabelReplace, LabelSplit } from './match';
export type { AdjustFile, Adjustment, Phrase, Timeline } from './phrase';
export {
  loadAdjust,
  loadExistingTimeline,
  SourceAdjusted,
  SourceForced,
  SourceInterpolated,
  TimelineSchema,
  timelineToJSON,
} from './phrase';
export type { PhraseSpan, ScriptToken } from './script';
export {
  isVocalEvent,
  loadProjectScript,
  loadScript,
  ParseError,
  parseScript,
  Script,
  stripVocalEvents,
  VocalEvents,
} from './script';
export type { TimedToken } from './timing';
export type { Token } from './token';
export { tokenize } from './token';
export type { DisplayCueAlignment, DisplayCueInput, ViewBlock, ViewNode, ViewStats } from './view';
export { alignDisplayCues, view } from './view';
