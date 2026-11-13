/**
 * 新建项目的画幅与风格选项、文件树、原样读文件、卡点状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as assets from '../assets';
import * as beat from '../beat';
import { compareBytes } from '../gojson';
import { envMap } from '../envutil';
import { SetupCommand } from '../prereq';
import * as preset from '../preset';
import * as scene from '../scene';
import { goMap, methodNotAllowed, notFound, serveFile, writeJSON } from './http';
import { containedPath } from './sessions';
import { fileExists } from './scenes';
import type { Server } from './studio';
import { skipDir, walkDir } from './turns';

/**
 * maxTreeEntries 限制 /api/tree 返回的文件数。项目里真正要看的文件远少于这个数，
 * 超过说明扫进了依赖或缓存目录，截断比让网页卡死好。
 */
export const maxTreeEntries = 5000;

/** stylesAPI 列出新建项目可选的画幅与风格，示例图经 /api/styles/{风格}/{画幅}/{骨架}.png 取。 */
export function stylesAPI(request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const canvases = preset.all().map((p) => ({ id: p.id, label: p.label, width: p.canvas.widthPx, height: p.canvas.heightPx, orientation: p.canvas.orientation }));
  const styles = preset.allStyles().map((st) => ({ id: st.id, name: st.name, label: st.label }));
  return writeJSON(
    200,
    goMap({
      canvases,
      styles,
      custom: { id: preset.CustomStyle.id, name: preset.CustomStyle.name, label: '由模型按描述自主定风格' },
      archetypes: preset.ArchetypeIDs,
      default_canvas: preset.defaultPreset().id,
    }),
  );
}

export function styleExampleAPI(rest: string): Response {
  const parts = rest.split('/');
  if (parts.length !== 3 || !parts[2].endsWith('.png')) return notFound();
  const [styleID, canvasID] = parts;
  const archetype = parts[2].slice(0, -'.png'.length);
  if (!preset.styleByID(styleID)) return notFound();
  if (!preset.ArchetypeIDs.includes(archetype)) return notFound();
  let body: Buffer;
  try {
    body = assets.style(styleID, canvasID).readFile('assets/style-guide/examples/' + archetype + '.png');
  } catch {
    return notFound();
  }
  return new Response(new Uint8Array(body), { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } });
}

export function isEnvFile(file: string): boolean {
  const base = path.basename(file);
  return base === '.env' || (base.startsWith('.env.') && base !== '.env.example');
}

/** treeAPI 列出项目文件，跳过的目录与快照一致，.env 不列出。 */
export function treeAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const entries: { path: string; size: number; mtime: number }[] = [];
  let truncated = false;
  walkDir(p.path, (file, entry) => {
    if (!entry) return;
    // 用量账本是 Studio 与 am 自己记的账，不是项目内容，文件树里不列。
    if (entry.isDirectory()) return skipDir(p.path, file, entry.name) ? 'skip' : undefined;
    if (!entry.isFile() || isEnvFile(file)) return;
    if (entries.length >= maxTreeEntries) {
      truncated = true;
      return 'stop';
    }
    try {
      const info = fs.lstatSync(file);
      entries.push({ path: path.relative(p.path, file).split(path.sep).join('/'), size: info.size, mtime: Math.floor(info.mtimeMs) });
    } catch {
      // 竞态删除。
    }
  });
  entries.sort((a, b) => compareBytes(a.path, b.path));
  return writeJSON(200, goMap({ files: entries, truncated }));
}

/** rawAPI 原样返回项目里的一个文件（成片、联系表、封面、附件等），支持 Range。 */
export function rawAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  let file: string;
  try {
    file = containedPath(p.path, new URL(request.url).searchParams.get('path') ?? '');
  } catch {
    return notFound();
  }
  if (isEnvFile(file)) return notFound();
  try {
    if (fs.statSync(file).isDirectory()) return notFound();
  } catch {
    return notFound();
  }
  return serveFile(request, file, { 'Cache-Control': 'no-cache' });
}

/**
 * beatAPI 返回卡点模式的全部状态，「节拍」页据此画波形、拍点、小节与分镜计划。
 *
 * 展示哪一份网格：有还没确认（或与正式网格不同）的草稿时展示草稿，否则展示正式网格。
 * 只读，不校验音乐摘要（每次刷新都哈希整首音乐太慢）；网格与音乐不符由 am beat confirm 拦下。
 */
export function beatAPI(s: Server): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const exists = (rel: string) => fileExists(path.join(p.path, rel));
  const out: Record<string, unknown> = {
    enabled: exists(beat.ConfigFile),
    draft: exists(beat.DraftFile),
    click: exists(beat.ClickFile),
    confirmed: exists(beat.GridFile),
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
    if (!exists(rel)) return null;
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
  if (exists(beat.PlanFile)) {
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
    // beat.yaml 写错时由 am beat 命令报具体原因。
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

/** BeatStoryFile 是卡点项目的故事与文案，制作提示词「卡点分支」让编排工具开工先写它。 */
export const BeatStoryFile = beat.Store + '/story.md';
const maxStoryBytes = 512 * 1024;

function readBeatStory(root: string): { path: string; content: string; mtime: number } | null {
  try {
    const file = containedPath(root, BeatStoryFile);
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

export function sameDownbeats(a: beat.Grid, b: beat.Grid): boolean {
  const x = a.downbeats ?? [];
  const y = b.downbeats ?? [];
  if (x.length !== y.length || (a.beats ?? []).length !== (b.beats ?? []).length) return false;
  return x.every((v, i) => Math.abs(v - y[i]) <= 0.002);
}
