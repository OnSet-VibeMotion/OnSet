// 歌曲模式的数据结构，以及按 Go struct 字段顺序与 omitempty 规则构造 JSON 值的函数。
// 字段名照抄 Go 的 json tag（Config 额外带 yaml 才有的 python）。
import type { Schema } from './jsondecode';

/** song.yaml。python 只在 YAML 里（json:"-"）。 */
export interface Config {
  schema: number;
  provider: string;
  model: string;
  workspace: string;
  endpoint: string;
  lyrics: string;
  style: string;
  language: string;
  target_seconds: number;
  bpm: number;
  python: string;
}

/** Config 的 Go 零值；测试与调用方用它补齐字段，对应 Go 的 Config{...} 字面量。 */
export function config(fields: Partial<Config> = {}): Config {
  return {
    schema: 0,
    provider: '',
    model: '',
    workspace: '',
    endpoint: '',
    lyrics: '',
    style: '',
    language: '',
    target_seconds: 0,
    bpm: 0,
    python: '',
    ...fields,
  };
}

export function configToJSON(c: Config): unknown {
  return {
    schema: c.schema,
    provider: c.provider,
    model: c.model,
    workspace: c.workspace || undefined,
    endpoint: c.endpoint || undefined,
    lyrics: c.lyrics,
    style: c.style,
    language: c.language,
    target_seconds: c.target_seconds,
    bpm: c.bpm,
  };
}

/** 一个不可变的歌曲候选（production/song/candidates/<id>/candidate.json）。 */
export interface Candidate {
  id: string;
  provider: string;
  model: string;
  task_id: string;
  request_sha256: string;
  audio: string;
  lyrics: string;
  audio_sha256: string;
  lyrics_sha256: string;
  duration_seconds: number;
  state: string;
  started_at: string;
  elapsed_seconds: number;
  provider_exit_code: number;
}

export function candidate(fields: Partial<Candidate> = {}): Candidate {
  return {
    id: '',
    provider: '',
    model: '',
    task_id: '',
    request_sha256: '',
    audio: '',
    lyrics: '',
    audio_sha256: '',
    lyrics_sha256: '',
    duration_seconds: 0,
    state: '',
    started_at: '',
    elapsed_seconds: 0,
    provider_exit_code: 0,
    ...fields,
  };
}

export function candidateToJSON(c: Candidate): unknown {
  return {
    id: c.id,
    provider: c.provider,
    model: c.model,
    task_id: c.task_id || undefined,
    request_sha256: c.request_sha256 || undefined,
    audio: c.audio,
    lyrics: c.lyrics,
    audio_sha256: c.audio_sha256,
    lyrics_sha256: c.lyrics_sha256,
    duration_seconds: c.duration_seconds,
    state: c.state,
    started_at: c.started_at || undefined,
    elapsed_seconds: c.elapsed_seconds || undefined,
    provider_exit_code: c.provider_exit_code || undefined,
  };
}

export const candidateSchema: Schema = {
  struct: [
    ['id', 'string'],
    ['provider', 'string'],
    ['model', 'string'],
    ['task_id', 'string'],
    ['request_sha256', 'string'],
    ['audio', 'string'],
    ['lyrics', 'string'],
    ['audio_sha256', 'string'],
    ['lyrics_sha256', 'string'],
    ['duration_seconds', 'float'],
    ['state', 'string'],
    ['started_at', 'string'],
    ['elapsed_seconds', 'float'],
    ['provider_exit_code', 'int'],
  ],
};

export interface Word {
  text: string;
  start: number;
  end: number;
  estimated: boolean;
}

export interface Line {
  id: string;
  source_line: number;
  text: string;
  alignment_text: string;
  start: number;
  end: number;
  /** Go 的 nil 切片为 null。 */
  words: Word[] | null;
}

export interface Interval {
  kind: string;
  start: number;
  end: number;
}

export interface Timeline {
  schema: number;
  candidate_id: string;
  audio_sha256: string;
  lyrics_sha256: string;
  duration_seconds: number;
  source: string;
  reviewed: boolean;
  lines: Line[] | null;
  beats: number[] | null;
  instrumentals: Interval[] | null;
  warnings: string[] | null;
}

export function word(fields: Partial<Word> = {}): Word {
  return { text: '', start: 0, end: 0, estimated: false, ...fields };
}

export function line(fields: Partial<Line> = {}): Line {
  return { id: '', source_line: 0, text: '', alignment_text: '', start: 0, end: 0, words: null, ...fields };
}

export function timeline(fields: Partial<Timeline> = {}): Timeline {
  return {
    schema: 0,
    candidate_id: '',
    audio_sha256: '',
    lyrics_sha256: '',
    duration_seconds: 0,
    source: '',
    reviewed: false,
    lines: null,
    beats: null,
    instrumentals: null,
    warnings: null,
    ...fields,
  };
}

const nonEmpty = <T>(list: T[] | null): T[] | undefined => (list && list.length > 0 ? list : undefined);

export function wordToJSON(w: Word): unknown {
  return { text: w.text, start: w.start, end: w.end, estimated: w.estimated || undefined };
}

export function lineToJSON(l: Line): unknown {
  return {
    id: l.id,
    source_line: l.source_line,
    text: l.text,
    alignment_text: l.alignment_text || undefined,
    start: l.start,
    end: l.end,
    words: nonEmpty(l.words)?.map(wordToJSON),
  };
}

export function intervalToJSON(g: Interval): unknown {
  return { kind: g.kind, start: g.start, end: g.end };
}

export function intervalsToJSON(list: Interval[] | null): unknown {
  return list === null ? null : list.map(intervalToJSON);
}

export function timelineToJSON(t: Timeline): unknown {
  return {
    schema: t.schema,
    candidate_id: t.candidate_id,
    audio_sha256: t.audio_sha256,
    lyrics_sha256: t.lyrics_sha256,
    duration_seconds: t.duration_seconds,
    source: t.source,
    reviewed: t.reviewed,
    lines: t.lines === null ? null : t.lines.map(lineToJSON),
    beats: nonEmpty(t.beats),
    instrumentals: nonEmpty(t.instrumentals)?.map(intervalToJSON),
    warnings: nonEmpty(t.warnings),
  };
}

const wordSchema: Schema = {
  struct: [
    ['text', 'string'],
    ['start', 'float'],
    ['end', 'float'],
    ['estimated', 'bool'],
  ],
};

const lineSchema: Schema = {
  struct: [
    ['id', 'string'],
    ['source_line', 'int'],
    ['text', 'string'],
    ['alignment_text', 'string'],
    ['start', 'float'],
    ['end', 'float'],
    ['words', { slice: wordSchema }],
  ],
};

const intervalSchema: Schema = {
  struct: [
    ['kind', 'string'],
    ['start', 'float'],
    ['end', 'float'],
  ],
};

export const timelineSchema: Schema = {
  struct: [
    ['schema', 'int'],
    ['candidate_id', 'string'],
    ['audio_sha256', 'string'],
    ['lyrics_sha256', 'string'],
    ['duration_seconds', 'float'],
    ['source', 'string'],
    ['reviewed', 'bool'],
    ['lines', { slice: lineSchema }],
    ['beats', { slice: 'float' }],
    ['instrumentals', { slice: intervalSchema }],
    ['warnings', { slice: 'string' }],
  ],
};

/** 网页手动生成的交接记录（production/song/web-handoff.json）。 */
export interface WebHandoff {
  schema: number;
  id: string;
  state: string;
  lyrics_sha256: string;
  style_sha256: string;
  candidate_id: string;
}

export function webHandoffToJSON(h: WebHandoff): unknown {
  return {
    schema: h.schema,
    id: h.id,
    state: h.state,
    lyrics_sha256: h.lyrics_sha256,
    style_sha256: h.style_sha256,
    candidate_id: h.candidate_id || undefined,
  };
}

export const webHandoffSchema: Schema = {
  struct: [
    ['schema', 'int'],
    ['id', 'string'],
    ['state', 'string'],
    ['lyrics_sha256', 'string'],
    ['style_sha256', 'string'],
    ['candidate_id', 'string'],
  ],
};

/** Cue binds local timing to exact global state. Paths are relative to the scene. */
export interface Cue {
  fps: number;
  timeline: string;
  sha256: string;
  start_seconds: number;
  data: string;
  data_sha256: string;
}

export function cueToJSON(c: Cue): unknown {
  return { fps: c.fps, timeline: c.timeline, sha256: c.sha256, start_seconds: c.start_seconds, data: c.data, data_sha256: c.data_sha256 };
}

export const cueSchema: Schema = {
  struct: [
    ['fps', 'int'],
    ['timeline', 'string'],
    ['sha256', 'string'],
    ['start_seconds', 'float'],
    ['data', 'string'],
    ['data_sha256', 'string'],
  ],
};

export interface SourceLine {
  source_line: number;
  original: string;
  display: string;
  alignment_input: string;
}

export function sourceLineToJSON(s: SourceLine): unknown {
  return { source_line: s.source_line, original: s.original, display: s.display, alignment_input: s.alignment_input };
}
