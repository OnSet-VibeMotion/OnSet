// Package align：把强制对齐结果映射回终稿，产出 voice.srt、phrase-timeline.json 与 align-report.json。
export { Script, ParseError, VocalEvents, isVocalEvent, loadScript, parseScript } from './script';
export type { PhraseSpan, ScriptToken } from './script';
export { tokenize } from './token';
export type { Token } from './token';
export { LabelExact, LabelInsertion, LabelMerge, LabelOmission, LabelReplace, LabelSplit } from './match';
export { CanonicalShape, loadEvidence, loadSegments, parseSegmentFlag } from './evidence';
export type { Item, Segment } from './evidence';
export { MaxCueUnits, formatSRT, writeSRT } from './cue';
export type { Cue } from './cue';
export type { TimedToken } from './timing';
export {
  SourceAdjusted,
  SourceForced,
  SourceInterpolated,
  TimelineSchema,
  loadAdjust,
  loadExistingTimeline,
  timelineToJSON,
} from './phrase';
export type { AdjustFile, Adjustment, Phrase, Timeline } from './phrase';
export { HintConfidence, MinMatchRate, ReportSchemaVersion, build, reportToJSON, sortedLabels, writeJSON } from './build';
export type { Irregular, Options, PhraseStat, Report, Result } from './build';
export { view } from './view';
export type { ViewBlock, ViewNode, ViewStats } from './view';
