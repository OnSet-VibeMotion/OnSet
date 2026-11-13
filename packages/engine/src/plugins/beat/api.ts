/** 节拍页的后端接口 /api/beat（原在 studio/api_ui.ts）。 */
import fs from 'node:fs';
import path from 'node:path';
import * as beat from '../../beat';
import { envMap } from '../../envutil';
import type { ApiHost } from '../../plugin/types';
import { SetupCommand } from '../../prereq';
import * as scene from '../../scene';
import { goMap, writeJSON } from '../../studio/http';

/** BeatStoryFile 是卡点项目的故事与文案，卡点流程的制作提示词让编排工具开工先写它。 */
export const BeatStoryFile = beat.Store + '/story.md';
const maxStoryBytes = 512 * 1024;

const exists = (file: string): boolean => {
  try {
    return !fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};

/**
 * beatAPI 返回卡点模式的全部状态，「节拍」页据此画波形、拍点、小节与分镜计划。
 *
 * 展示哪一份网格：有还没确认（或与正式网格不同）的草稿时展示草稿，否则展示正式网格。
 * 只读，不校验音乐摘要（每次刷新都哈希整首音乐太慢）；网格与音乐不符由 beat_confirm 拦下。
 */
export function beatAPI(s: ApiHost): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const has = (rel: string) => exists(path.join(p.path, rel));
  const out: Record<string, unknown> = {
    enabled: has(beat.ConfigFile),
    draft: has(beat.DraftFile),
    click: has(beat.ClickFile),
    confirmed: has(beat.GridFile),
    click_path: beat.ClickFile,
  };
  if (!out.enabled) return writeJSON(200, goMap(out));
  out.analyzer = beatAnalyzer(p.path);
  const story = readBeatStory(p.path);
  if (story) out.story = story;
  const track = readBeatTrack(p.path);
  if (track) {
    out.music_path = beat.Store + '/' + track.audio;
    out.track = { source: track.source, duration_seconds: track.duration_seconds };
  }
  const read = (rel: string): beat.Grid | null => {
    if (!has(rel)) return null;
    try {
      return beat.readDraft(path.join(p.path, rel));
    } catch (err) {
      out.grid_error = rel + '：' + (err as Error).message;
      return null;
    }
  };
  const confirmed = read(beat.GridFile);
  const draft = read(beat.DraftFile);
  const draftPending = draft !== null && (confirmed === null || !sameDownbeats(draft, confirmed));
  const shown = draftPending ? draft : confirmed;
  out.draft_pending = draftPending;
  let fps = 30;
  try {
    fps = scene.canvasOf(p.path, 'frame.md').fps;
  } catch {
    // 没有 frame.md 的项目按默认帧率换算，只影响显示。
  }
  out.fps = fps;
  if (shown) {
    out.grid = {
      kind: draftPending ? 'draft' : 'confirmed',
      source: shown.source,
      duration_seconds: shown.duration_seconds,
      beats: shown.beats ?? [],
      downbeats: shown.downbeats ?? [],
    };
    out.problems = beat.gridProblems(shown);
  }
  if (has(beat.PlanFile)) {
    try {
      if (!confirmed || draftPending) throw new Error('节拍网格确认之后才能按小节换算分镜计划');
      const segments = beat.layout(confirmed, beat.loadPlan(p.path), fps);
      out.plan = segments.map((seg) => ({
        id: seg.id,
        first_bar: seg.firstBar,
        bars: seg.bars,
        start_seconds: seg.startFrame / fps,
        end_seconds: (seg.startFrame + seg.frames) / fps,
      }));
    } catch (err) {
      out.plan_error = (err as Error).message;
    }
  }
  return writeJSON(200, goMap(out));
}

/**
 * beatAnalyzer 报告节拍分析能不能跑：beat.yaml 没写 python 时看 am setup 装的共享环境，写了就看那个文件。
 * 缺了界面给出 am setup --only beat，不让用户（或编排工具）自己去建 Python 环境。
 */
function beatAnalyzer(root: string): { ready: boolean; location: string; command?: string } {
  const env = envMap();
  let python = '';
  try {
    python = beat.loadConfig(root).python;
  } catch {
    // beat.yaml 写错时由 beat_* 操作报具体原因。
  }
  if (python !== '') {
    let ready = false;
    try {
      ready = fs.statSync(python).isFile();
    } catch {
      ready = false;
    }
    return { ready, location: python };
  }
  const dir = beat.envDir(env);
  const ready = beat.envReady(dir) || process.env.AM_STUDIO_SKIP_SKILL_INSTALL === '1';
  return ready ? { ready, location: dir } : { ready, location: dir, command: SetupCommand + ' --only beat' };
}

/** 读故事与文案；文件经符号链接指出项目之外、或太大时不读。 */
function readBeatStory(root: string): { path: string; content: string; mtime: number } | null {
  try {
    const realRoot = fs.realpathSync(root);
    const file = fs.realpathSync(path.join(root, BeatStoryFile));
    if (!file.startsWith(realRoot + path.sep)) return null;
    const info = fs.statSync(file);
    if (!info.isFile() || info.size > maxStoryBytes) return null;
    return { path: BeatStoryFile, content: fs.readFileSync(file, 'utf8'), mtime: Math.floor(info.mtimeMs) };
  } catch {
    return null;
  }
}

/** 只读 track.json 的字段，不像 beat.loadTrack 那样核对整首音乐的摘要。 */
function readBeatTrack(root: string): { audio: string; source: string; duration_seconds: number } | null {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(root, beat.TrackFile), 'utf8')) as Record<string, unknown>;
    if (typeof t.audio !== 'string' || t.audio === '' || t.audio.includes('/') || t.audio.startsWith('.')) return null;
    return { audio: t.audio, source: String(t.source ?? ''), duration_seconds: Number(t.duration_seconds) || 0 };
  } catch {
    return null;
  }
}

/** 两份网格的重拍是否相同（拍数一致、每个重拍差不超过 2 毫秒）。 */
export function sameDownbeats(a: beat.Grid, b: beat.Grid): boolean {
  const x = a.downbeats ?? [];
  const y = b.downbeats ?? [];
  if (x.length !== y.length || (a.beats ?? []).length !== (b.beats ?? []).length) return false;
  return x.every((v, i) => Math.abs(v - y[i]) <= 0.002);
}
