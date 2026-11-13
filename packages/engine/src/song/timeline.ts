// 移植自 internal/song/timeline.go。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goPathError, goRound, goTrimSpace } from '../gofmt';
import { candidateDir, digest, finite, hashFile, loadConfig, localPath, readJSON, selected, Store, writeJSON } from './store';
import { intervalsToJSON, timelineSchema, timelineToJSON, type Cue, type Interval, type Line, type Timeline, type Word } from './types';

export function frames(t: Timeline, fps: number): number {
  return Math.ceil(t.duration_seconds * fps - 1e-9);
}

export function problems(t: Timeline): string[] {
  const p: string[] = [];
  if (t.schema !== 1 || !finite(t.duration_seconds) || t.duration_seconds <= 0) p.push('无效时间轴版本或时长');
  const lines = t.lines ?? [];
  if (lines.length === 0) p.push('没有已对齐歌词');
  const seen = new Set<string>();
  let end = 0.0;
  for (const l of lines) {
    if (l.id === '' || seen.has(l.id)) p.push('歌词 ID 缺失或重复');
    seen.add(l.id);
    if (goTrimSpace(l.text) === '' || !finite(l.start) || !finite(l.end) || l.start < end - 1e-6 || l.end <= l.start || l.end > t.duration_seconds + 1e-6) {
      p.push('歌词缺失、倒序、重叠或越界：' + l.id);
    }
    end = l.end;
    let wEnd = l.start;
    for (const w of l.words ?? []) {
      if (w.estimated || !finite(w.start) || !finite(w.end) || w.start < wEnd - 1e-6 || w.end <= w.start || w.end > l.end + 1e-6 || goTrimSpace(w.text) === '') {
        p.push('字词时间不可靠：' + l.id);
      }
      wEnd = w.end;
    }
  }
  let last = -1.0;
  for (const b of t.beats ?? []) {
    if (!finite(b) || b < 0 || b >= t.duration_seconds || b <= last) p.push('节拍倒序或越界');
    last = b;
  }
  return p;
}

export function slice(t: Timeline, start: number, duration: number): Timeline {
  const out: Timeline = { ...t, duration_seconds: duration, lines: null, beats: null, instrumentals: null };
  const end = start + duration;
  for (const l of t.lines ?? []) {
    if (l.end <= start || l.start >= end) continue;
    const c: Line = { ...l, start: Math.max(l.start, start) - start, end: Math.min(l.end, end) - start, words: null };
    for (const w of l.words ?? []) {
      if (w.end <= start || w.start >= end) continue;
      const nw: Word = { ...w, start: Math.max(w.start, start) - start, end: Math.min(w.end, end) - start };
      (c.words ??= []).push(nw);
    }
    (out.lines ??= []).push(c);
  }
  for (const b of t.beats ?? []) {
    if (b >= start && b < end) (out.beats ??= []).push(b - start);
  }
  for (const g of t.instrumentals ?? []) {
    if (g.end <= start || g.start >= end) continue;
    (out.instrumentals ??= []).push({ ...g, start: Math.max(g.start, start) - start, end: Math.min(g.end, end) - start });
  }
  return out;
}

function gaps(t: Timeline): void {
  let list: Interval[] | null = null;
  let cursor = 0.0;
  (t.lines ?? []).forEach((l, i) => {
    if (l.start > cursor) (list ??= []).push({ kind: i === 0 ? 'intro' : 'interlude', start: cursor, end: l.start });
    cursor = l.end;
  });
  if (cursor < t.duration_seconds) (list ??= []).push({ kind: 'outro', start: cursor, end: t.duration_seconds });
  t.instrumentals = list;
}

function checkSelection(root: string, t: Timeline): void {
  const c = selected(root);
  if (t.candidate_id !== c.id || t.audio_sha256 !== c.audio_sha256 || t.lyrics_sha256 !== c.lyrics_sha256 || Math.abs(t.duration_seconds - c.duration_seconds) > 1e-6) {
    throw new Error('时间轴已过期：与选定音频或歌词不一致');
  }
  const dir = candidateDir(root, c.id);
  const file = path.join(dir, c.lyrics);
  let b: string;
  try {
    b = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(goPathError('open', file, err), { cause: err });
  }
  const lines = lyricLines(b);
  const tl = t.lines ?? [];
  if (lines.length !== tl.length) throw new Error(`对齐歌词行数不匹配：需要 ${lines.length} 行，得到 ${tl.length} 行`);
  lines.forEach((l, i) => {
    if (goTrimSpace(l) !== goTrimSpace(tl[i].text)) throw new Error(`第 ${i + 1} 行歌词与选定文本不一致`);
  });
}

/** lyricLines excludes structure tags, never deduplicates repeated choruses. */
export function lyricLines(text: string): string[] {
  const out: string[] = [];
  for (let s of text.split('\n')) {
    s = goTrimSpace(s);
    if (s === '' || (s.startsWith('[') && s.endsWith(']'))) continue;
    out.push(s);
  }
  return out;
}

export function saveTimeline(root: string, t: Timeline): void {
  checkSelection(root, t);
  const p = problems(t);
  if (p.length > 0) throw new Error(`时间轴不合格：${p.join('；')}`);
  t = { ...t };
  gaps(t);
  const file = localPath(root, Store + '/timeline.json');
  // The timeline is the commit marker; derived files are written first.
  let s = '';
  (t.lines ?? []).forEach((l, i) => {
    s += `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.text}\n\n`;
  });
  atomicWrite(path.join(path.dirname(file), 'lyrics.srt'), s, 0o644);
  writeJSON(file, timelineToJSON(t));
}

export function readTimeline(file: string): Timeline {
  return readJSON<Timeline>(file, timelineSchema);
}

export function loadTimeline(root: string): Timeline {
  loadConfig(root);
  const file = localPath(root, Store + '/timeline.json');
  const t = readTimeline(file);
  checkSelection(root, t);
  const p = problems(t);
  if (p.length > 0) throw new Error(`时间轴不合格：${p.join('；')}`);
  const canonical = { ...t };
  gaps(canonical);
  if (digest(intervalsToJSON(canonical.instrumentals)) !== digest(intervalsToJSON(t.instrumentals))) {
    throw new Error('无歌词区段与歌词时间轴不一致，请重新 prepare');
  }
  return t;
}

function pad(n: number, width: number): string {
  const s = String(Math.abs(n)).padStart(width, '0');
  return n < 0 ? '-' + s : s;
}

export function srtTime(s: number): string {
  const ms = goRound(s * 1000);
  return `${pad(Math.trunc(ms / 3600000), 2)}:${pad(Math.trunc(ms / 60000) % 60, 2)}:${pad(Math.trunc(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`;
}

export function verifyCue(dir: string, c: Cue, duration: number): void {
  const p = path.normalize(path.join(dir, c.timeline));
  const root = path.dirname(path.dirname(path.dirname(p)));
  if (p !== path.join(root, Store, 'timeline.json')) throw new Error('song.timeline 必须引用 production/song/timeline.json');
  const t = loadTimeline(root);
  if (!t.reviewed) throw new Error('歌曲时间轴尚未人工复核');
  if (hashFile(p) !== c.sha256) throw new Error('歌曲时间轴变化，请重新运行 song_cues()');
  const fps = c.fps;
  if (
    fps <= 0 ||
    !finite(c.start_seconds) ||
    c.start_seconds < 0 ||
    c.start_seconds >= t.duration_seconds ||
    !finite(duration) ||
    duration <= 0 ||
    c.start_seconds + duration > frames(t, fps) / fps + 1e-6 ||
    Math.abs(c.start_seconds * fps - goRound(c.start_seconds * fps)) > 1e-5 ||
    Math.abs(duration * fps - goRound(duration * fps)) > 1e-5
  ) {
    throw new Error('歌曲镜头时间越界');
  }
  const dp = localPath(dir, c.data);
  if (hashFile(dp) !== c.data_sha256) throw new Error('歌曲局部时间轴摘要变化');
  const actual = readTimeline(dp);
  const expected = slice(t, c.start_seconds, duration);
  if (digest(timelineToJSON(expected)) !== digest(timelineToJSON(actual))) throw new Error('镜头局部歌词或节拍与全局不一致');
}
