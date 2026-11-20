// Package song owns immutable song candidates and their derived timing contract.
export { Platforms, checkCredential, configure, knownProvider, platformGuide, providerInfo, validateHostedConfig } from './platforms';
export type { ConfigureOptions, Platform, Writer } from './platforms';
export {
  AceStepGGUFModel,
  AcestepBinDirEnv,
  AcestepCppCommit,
  AcestepCppRepo,
  AcestepCppVersion,
  AcestepModelsDirEnv,
  AcestepSourceEnv,
  DefaultLocalLMModel,
  DefaultLocalSynthModel,
  DefaultLocalVAEModel,
  buildLocalRequest,
  ensureLocalAcestep,
  ensureLocalAcestepBinaries,
  generateLocalAcestep,
  isCoverTask,
  localAcestepBinDir,
  localAcestepBinariesReady,
  localAcestepModelsDir,
  localAcestepModelsReady,
  localAcestepStatus,
  requireLocalAcestep,
  resolveLocalLMModel,
  resolveLocalSynthModel,
} from './local';
export type { LocalAcestepInstallOptions, LocalAcestepRuntime, LocalAcestepStatus, LocalGenerateOptions } from './local';
export {
  DefaultConfig,
  Store,
  bytesHash,
  candidateDir,
  decodeConfig,
  digest,
  enabled,
  finite,
  hashFile,
  idPattern,
  loadCandidate,
  loadConfig,
  localPath,
  parseGoURL,
  readCandidate,
  readJSON,
  select,
  selected,
  withLock,
  writeJSON,
} from './store';
export type { GoURL } from './store';
export {
  candidate,
  candidateSchema,
  candidateToJSON,
  config,
  configToJSON,
  cueSchema,
  cueToJSON,
  intervalToJSON,
  intervalsToJSON,
  line,
  lineToJSON,
  sourceLineToJSON,
  timeline,
  timelineSchema,
  timelineToJSON,
  webHandoffSchema,
  webHandoffToJSON,
  word,
  wordToJSON,
} from './types';
export type { Candidate, Config, Cue, Interval, Line, SourceLine, Timeline, WebHandoff, Word } from './types';
export { frames, loadTimeline, lyricLines, problems, readTimeline, saveTimeline, slice, srtTime, verifyCue } from './timeline';
export { exportPhrases } from './phrases';
export { AlignerVersion, LibrosaVersion, convertAlignment, doctor, lyricMapping, prepare } from './prepare';
export { generate, importSong } from './generate';
export { handoff, handoffWithRefresh, loadHandoff, receive } from './handoff';
export type { LoadedHandoff } from './handoff';
export { ACEClient } from './provider';
export type { ACEClientOptions, ResumableProvider } from './provider';
export { JSONDecodeError } from './jsondecode';
export type { Schema } from './jsondecode';
export { setDefaultTransport } from './http';
export type { HttpRequest, HttpResponse, RoundTripper } from './http';
