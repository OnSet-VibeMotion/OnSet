// Package dialogue 把分说话人合成的音频段装配成一条时间线。移植自 internal/dialogue。
export { DialogueRelPath, SRTRelPath, VoiceRelPath } from './paths';
export { SchemaVersion, planToJSON, resultToJSON, totalSeconds, unmarshalResult } from './plan';
export type { Line, Plan, PlanLine, PlanSegment, Result, Segment } from './plan';
export { clock, rebuild, writeResultJSON, writeSRT } from './timeline';
export { Runner, newRunner, trimSeconds } from './audio';
export { DriftToleranceSeconds, assemble } from './assemble';
export type { Options } from './assemble';
