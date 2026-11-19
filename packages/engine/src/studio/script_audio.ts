import fs from 'node:fs';
import path from 'node:path';
import * as align from '../align';
import * as srt from '../srt';
import { containedPath } from './sessions';

export interface ScriptAudioOption { path: string; name: string; version: number }
export interface ScriptAudio extends ScriptAudioOption {
  seconds: number;
  timing: 'aligned' | 'estimated' | 'dialogue';
}

function file(root: string, relative: string): string | undefined {
  try {
    const full = containedPath(root, relative);
    return fs.statSync(full).isFile() ? full : undefined;
  } catch { return undefined; }
}

/** 规范音频优先；版本稿可以切换。字幕、伴奏、音色试听都不能冒充正式配音。 */
export function scriptAudioOptions(root: string): ScriptAudioOption[] {
  let names: string[];
  try { names = fs.readdirSync(containedPath(root, 'production/audio')); }
  catch { return []; }
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
    const rank = (name: string) => name === 'voice.wav' ? 0 : name === 'voice.mp3' ? 1 : 2;
    return rank(a.name) - rank(b.name) || b.version - a.version || a.name.localeCompare(b.name);
  });
}

const matchedAudio = new Map<string, { key: string; matches: boolean }>();

// 工具先保存对齐结果、再复制正式音频；这时用原始产物确认归属，不能只比较时间先后。
function matchesManagedAudio(root: string, option: ScriptAudioOption, stem: string): boolean {
  const original = file(root, stem + '.tts/audio.wav');
  const current = file(root, option.path);
  if (!original || !current) return false;
  const a = fs.statSync(original), b = fs.statSync(current);
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

const timingCache = new Map<string, { key: string; blocks?: align.ViewBlock[] }>();

/** 只读已有对齐结果，不在打开页面时运行模型。旧对齐或不匹配的文稿改为界面估算。 */
export function scriptAudio(root: string, option: ScriptAudioOption, script?: align.Script, source = ''): { voice: ScriptAudio; blocks?: align.ViewBlock[] } {
  const stem = option.path.slice(0, -path.extname(option.path).length);
  const voice: ScriptAudio = { ...option, seconds: 0, timing: 'estimated' };
  const report = file(root, stem + '.tts/report.json');
  if (report) {
    try {
      const seconds: unknown = JSON.parse(fs.readFileSync(report, 'utf8')).duration_seconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) voice.seconds = seconds;
    } catch { /* 报告损坏不影响播放。 */ }
  }
  const subtitles = file(root, stem + '.srt');
  if (subtitles && !voice.seconds) {
    try { voice.seconds = srt.readSpan(subtitles).endSeconds; } catch { /* 仍可读取音频自身的时长。 */ }
  }
  if (!script) return { voice };
  const candidates = [stem + '.tts/align.json', stem + '.align.json'];
  if (['voice.wav', 'voice.mp3', 'voice.m4a'].includes(option.name)) candidates.push('production/audio/align.json');
  const evidence = candidates.map((name) => ({ relative: name, full: file(root, name) })).find(({ relative, full }) =>
    full && (fs.statSync(full).mtimeMs >= option.version || (relative === stem + '.tts/align.json' && matchesManagedAudio(root, option, stem))),
  )?.full;
  if (!evidence) return { voice };
  const stat = fs.statSync(evidence);
  const key = `${option.version}:${evidence}:${stat.mtimeMs}:${stat.size}:${source}`;
  const cacheID = root + '/' + option.path;
  let cached = timingCache.get(cacheID);
  if (cached?.key !== key) {
    cached = { key };
    try {
      const result = align.build(script, align.loadEvidence(evidence), { fps: 30 });
      if (result.report.match_rate >= 0.98 && result.report.interpolated_tokens === 0) cached.blocks = align.view(script, result.tokens).blocks;
    } catch { /* 不匹配或损坏的对齐不用于高亮，不影响播放。 */ }
    timingCache.set(cacheID, cached);
    if (timingCache.size > 24) timingCache.delete(timingCache.keys().next().value!);
  }
  if (cached.blocks) voice.timing = 'aligned';
  return { voice, blocks: cached.blocks };
}
