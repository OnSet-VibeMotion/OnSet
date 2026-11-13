// Package reads：检查画面上每个可读元素是否给了观众足够的阅读时间。
export {
  Defaults,
  DecorativeRole,
  ReportSchemaVersion,
  RuleBinding,
  RuleDuration,
  RuleFrames,
  RuleIdentity,
  RuleOrder,
  RuleSpoiler,
  RuleTimeline,
  check,
  loadInventory,
  loadTimeline,
  newEvent,
  newPhrase,
  requiredFrames,
  ruleIDs,
  units,
  writeJSON,
} from './reads';
export type { Event, EventResult, Finding, Inventory, Options, Phrase, Report, Timeline } from './reads';
