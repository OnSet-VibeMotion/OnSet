// Package castbeats 把 production/dialogue.json 的全局台词时间线切成各镜头的 cast.beats
// （镜头本地时间）。
export { DialogueRelPath, apply, loadDialogueLines, setDialogueRelPath, writeSceneBeats } from './apply';
export type { Report, SceneBeats } from './apply';
export { readSceneHeads } from './scenes';
export type { SceneHead } from './scenes';
export { minBeatSeconds, slice } from './slice';
export { compact, decodeObject, encodeObject, findField, indent, setField } from '../rawjson/jsonedit';
export type { Field } from '../rawjson/jsonedit';
