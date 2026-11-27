import fs from 'node:fs';
import path from 'node:path';
import * as align from '../align';
import * as srt from '../srt';
import { containedPath } from './sessions';

export interface ScriptAudioOption {
  path: string;
  name: string;
  version: number;
}
export interface ScriptAudio extends ScriptAudioOption {
  seconds: number;
  timing: 'aligned' | 'subtitled' | 'segmented' | 'estimated' | 'dialogue';
}

function file(root: string, relative: string): string | undefined {
  try {
    const full = containedPath(root, relative);
    return fs.statSync(full).isFile() ? full : undefined;
  } catch {
    return undefined;
  }
}

/** 规范音频优先；版本稿可以切换。字幕、伴奏、音色试听都不能冒充正式配音。 */
export function scriptAudioOptions(root: string): ScriptAudioOption[] {
  let names: string[];
  try {
    names = fs.readdirSync(containedPath(root, 'production/audio'));
  } catch {
    return [];
  }
  const options: ScriptAudioOption[] = [];
  for (const name of names) {
    if (!/\.(wav|mp3|m4a|ogg|flac)$/i.test(name)) continue;
    const stem = name.slice(0, -path.extname(name).length);
    if (!/^voice(?:[-_].+)?$/i.test(stem) && !file(root, `production/audio/${stem}.tts/report.json`)) continue;
    const relative = 'production/audio/' + name;
    const full = file(root, relative);
    if (!full) continue;
    const stat = fs.statSync(full);
    if (!stat.size) continue;
    options.push({ path: relative, name, version: stat.mtimeMs });
  }
  return options.sort((a, b) => {
    const rank = (name: string) => (name === 'voice.wav' ? 0 : name === 'voice.mp3' ? 1 : 2);
    return rank(a.name) - rank(b.name) || b.version - a.version || a.name.localeCompare(b.name);
  });
}

const matchedAudio = new Map<string, { key: string; matches: boolean }>();

// 工具先保存对齐结果、再复制正式音频；这时用原始产物确认归属，不能只比较时间先后。
function matchesManagedAudio(root: string, option: ScriptAudioOption, stem: string): boolean {
  const original = file(root, stem + '.tts/audio.wav');
  const current = file(root, option.path);
  if (!original || !current) return false;
  const a = fs.statSync(original),
    b = fs.statSync(current);
  if (a.size !== b.size) return false;
  const key = `${a.mtimeMs}:${a.ctimeMs}:${b.mtimeMs}:${b.ctimeMs}:${a.size}`;
  let cached = matchedAudio.get(current);
  if (cached?.key !== key) {
    cached = { key, matches: fs.readFileSync(original).equals(fs.readFileSync(current)) };
    matchedAudio.set(current, cached);
    if (matchedAudio.size > 24) matchedAudio.delete(matchedAudio.keys().next().value!);
  }
  return cached.matches;
}

const timingCache = new Map<string, { key: string; timing: ScriptAudio['timing']; blocks?: align.ViewBlock[] }>();

const minTimingMatchRate = 0.95;
const maxInterpolatedRatio = 0.05;
const maxDurationOverflowSeconds = 5;

function statTag(full: string | undefined): string {
  if (!full) return '';
  try {
    const st = fs.statSync(full);
    return `${full}:${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function isFreshForAudio(
  root: string,
  option: ScriptAudioOption,
  stem: string,
  full: string,
  allowManagedBeforeCopy = false,
): boolean {
  const mtime = fs.statSync(full).mtimeMs;
  if (mtime >= option.version) return true;
  if (!matchesManagedAudio(root, option, stem)) return false;
  if (allowManagedBeforeCopy) return true;
  const original = file(root, stem + '.tts/audio.wav');
  return !!original && mtime >= fs.statSync(original).mtimeMs;
}

function acceptableReport(report: align.Report, audioSeconds: number): boolean {
  if (report.tokens <= 0) return false;
  if (report.match_rate < minTimingMatchRate) return false;
  if (report.interpolated_tokens / report.tokens > maxInterpolatedRatio) return false;
  if (report.speech_end_ms <= report.speech_start_ms) return false;
  if (audioSeconds > 0 && report.speech_end_ms / 1000 > audioSeconds + maxDurationOverflowSeconds) return false;
  return true;
}

function buildAlignedBlocks(
  script: align.Script,
  evidenceFile: string,
  audioSeconds: number,
): align.ViewBlock[] | undefined {
  try {
    const result = align.build(script, align.loadEvidence(evidenceFile), { fps: 30 });
    if (acceptableReport(result.report, audioSeconds)) return align.view(script, result.tokens).blocks;
  } catch {
    /* 不匹配或损坏的对齐不用于高亮，不影响播放。 */
  }
  return undefined;
}

function buildSubtitleBlocks(
  script: align.Script,
  srtFile: string,
  audioSeconds: number,
): align.ViewBlock[] | undefined {
  try {
    const cues = srt.readCues(srtFile);
    let prevStart = 0;
    for (const cue of cues) {
      if (
        !Number.isFinite(cue.start_seconds) ||
        !Number.isFinite(cue.end_seconds) ||
        cue.start_seconds < 0 ||
        cue.end_seconds < cue.start_seconds ||
        cue.start_seconds < prevStart - 0.05
      ) {
        return undefined;
      }
      prevStart = cue.start_seconds;
    }
    const display = align.alignDisplayCues(script, cues);
    if (
      display &&
      display.tokens > 0 &&
      display.match_rate >= minTimingMatchRate &&
      display.interpolated_tokens / display.tokens <= maxInterpolatedRatio &&
      (audioSeconds <= 0 || display.speech_end_seconds <= audioSeconds + maxDurationOverflowSeconds)
    ) {
      return display.blocks;
    }
    const items: align.Item[] = cues
      .filter((c) => c.end_seconds > c.start_seconds && c.text.trim() !== '')
      .map((c) => ({ text: c.text, start: c.start_seconds, end: c.end_seconds, segment: 0 }));
    if (items.length > 0) {
      const spoken = align.build(script, items, { fps: 30 });
      if (acceptableReport(spoken.report, audioSeconds)) return align.view(script, spoken.tokens).blocks;
    }
  } catch {
    /* 字幕损坏或不匹配时继续回退。 */
  }
  return undefined;
}

function buildSegmentBlocks(
  script: align.Script,
  reportFile: string,
  audioSeconds: number,
): align.ViewBlock[] | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as { segments?: unknown };
    if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) return undefined;
    const items: align.Item[] = [];
    let prevEnd = 0;
    for (const raw of parsed.segments as Array<{
      text?: unknown;
      start_seconds?: unknown;
      duration_seconds?: unknown;
    }>) {
      if (
        typeof raw?.text !== 'string' ||
        typeof raw.start_seconds !== 'number' ||
        typeof raw.duration_seconds !== 'number' ||
        !Number.isFinite(raw.start_seconds) ||
        !Number.isFinite(raw.duration_seconds) ||
        raw.start_seconds < 0 ||
        raw.start_seconds < prevEnd - 0.02 ||
        raw.duration_seconds <= 0
      ) {
        return undefined;
      }
      const end = raw.start_seconds + raw.duration_seconds;
      prevEnd = end;
      const clean = align.stripVocalEvents(raw.text).trim();
      if (clean !== '') items.push({ text: clean, start: raw.start_seconds, end, segment: 0 });
    }
    if (items.length === 0) return undefined;
    const result = align.build(script, items, { fps: 30 });
    if (acceptableReport(result.report, audioSeconds)) return align.view(script, result.tokens).blocks;
  } catch {
    /* 分段报告损坏或不匹配时退回时长估算。 */
  }
  return undefined;
}

/**
 * 只读已有对齐、字幕与配音分段报告，不在打开页面时运行模型。
 * 按精度分级回退：字级 align.json → 句级 voice.srt → 配音段级 report.json → 前端时长估算。
 */
export function scriptAudio(
  root: string,
  option: ScriptAudioOption,
  script?: align.Script,
  source = '',
): { voice: ScriptAudio; blocks?: align.ViewBlock[] } {
  const stem = option.path.slice(0, -path.extname(option.path).length);
  const voice: ScriptAudio = { ...option, seconds: 0, timing: 'estimated' };
  const report = file(root, stem + '.tts/report.json');
  if (report) {
    try {
      const seconds: unknown = JSON.parse(fs.readFileSync(report, 'utf8')).duration_seconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) voice.seconds = seconds;
    } catch {
      /* 报告损坏不影响播放。 */
    }
  }
  const subtitles = file(root, stem + '.srt');
  if (subtitles && !voice.seconds) {
    try {
      voice.seconds = srt.readSpan(subtitles).endSeconds;
    } catch {
      /* 仍可读取音频自身的时长。 */
    }
  }
  if (!script) return { voice };
  const candidates = [stem + '.tts/align.json', stem + '.align.json'];
  if (['voice.wav', 'voice.mp3', 'voice.m4a'].includes(option.name)) candidates.push('production/audio/align.json');
  const freshEvidence = candidates.flatMap((name) => {
    const full = file(root, name);
    return full && isFreshForAudio(root, option, stem, full, name === stem + '.tts/align.json') ? [full] : [];
  });
  const freshSubtitles = subtitles && isFreshForAudio(root, option, stem, subtitles) ? subtitles : undefined;
  const managedReport = report && matchesManagedAudio(root, option, stem) ? report : undefined;
  if (freshEvidence.length === 0 && !freshSubtitles && !managedReport) return { voice };
  const key = [
    option.version,
    voice.seconds,
    freshEvidence.map(statTag).join(','),
    statTag(freshSubtitles),
    statTag(managedReport),
    source,
  ].join('|');
  const cacheID = root + '/' + option.path;
  let cached = timingCache.get(cacheID);
  if (cached?.key !== key) {
    cached = { key, timing: 'estimated' };
    for (const evidence of freshEvidence) {
      const blocks = buildAlignedBlocks(script, evidence, voice.seconds);
      if (blocks) {
        cached.blocks = blocks;
        cached.timing = 'aligned';
        break;
      }
    }
    if (!cached.blocks && freshSubtitles) {
      const blocks = buildSubtitleBlocks(script, freshSubtitles, voice.seconds);
      if (blocks) {
        cached.blocks = blocks;
        cached.timing = 'subtitled';
      }
    }
    if (!cached.blocks && managedReport) {
      const blocks = buildSegmentBlocks(script, managedReport, voice.seconds);
      if (blocks) {
        cached.blocks = blocks;
        cached.timing = 'segmented';
      }
    }
    timingCache.set(cacheID, cached);
    if (timingCache.size > 24) timingCache.delete(timingCache.keys().next().value!);
  }
  voice.timing = cached.timing;
  return { voice, blocks: cached.blocks };
}
