/**
 * 分镜页：把编排写下的整片处理方案、分镜计划与每个镜头的画面描述摆给用户看。
 *
 * 这几份文件在渲染之前就写好了，以前界面上看不到，用户第一次看到画面时所有镜头已经渲染过一遍。
 * 这里只读：要改分镜，在对话里让编排改项目文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as scene from '../scene';
import { writeError, writeJSON } from './http';
import { discoverScenes } from './scenes';
import { localRFC3339 } from './script';
import type { Server } from './studio';

export const storyboardPlanPath = 'production/scene-plan.json';
export const storyboardDocPath = 'production/scene-plan.md';
export const treatmentPath = 'production/treatment.md';

export interface StoryboardHandoff {
  device: string;
  /** 手法的中文名（接力、推进穿越……）；未知手法为空。 */
  device_label: string;
  bridge: string;
  style_shift?: string;
  style_shift_label?: string;
}

export interface StoryboardScene {
  id: string;
  /** 镜头目录，相对项目根。 */
  dir: string;
  chapter?: string;
  visual_role?: string;
  summary?: string;
  film_style?: string;
  /** 从哪里开始：第几条字幕或哪个短语。第一个镜头为空。 */
  anchor?: string;
  handoff?: StoryboardHandoff;
  /** scene.json 的 text：这个镜头对应的口播。 */
  text?: string;
  /** 由分镜计划推出的时长（跑过 scene_cues 才有）。 */
  seconds?: number;
  /** 这个镜头的画面描述（prompt.md）。 */
  prompt?: { path: string; content: string };
  /** 镜头目录已经建好（有 scene.json）。 */
  created: boolean;
  /** 已经有产物。 */
  rendered: boolean;
}

export interface StoryboardResponse {
  /** 读的是分镜计划（production/scene-plan.json）；为空时镜头来自项目里已有的镜头目录。 */
  plan_path: string;
  updated_at?: string;
  parse_error?: string;
  look?: Partial<scene.Look>;
  treatment?: { path: string; content: string };
  /** 给人看的分镜说明（scene-plan.md）在不在，界面只给一个「原文」链接。 */
  doc_path?: string;
  scenes: StoryboardScene[];
}

export function storyboardAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return writeError(405, 'method_not_allowed', '只支持 GET');
  let root: string;
  try {
    root = s.currentProject().path;
  } catch (err) {
    return writeError(404, 'no_project', (err as Error).message);
  }
  return writeJSON(200, readStoryboard(root));
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 项目里的相对目录；写成绝对路径或跑出项目的一律不认（计划是编排写的，不能让它把界面指到项目外）。 */
function insideProject(root: string, rel: string): string | null {
  if (rel === '' || path.isAbsolute(rel)) return null;
  const full = path.resolve(root, rel);
  const back = path.relative(root, full);
  if (back === '' || back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back)) return null;
  return full;
}

function deviceLabel(device: string): string {
  const guide = scene.handoffGuide(device);
  const i = guide.indexOf('：');
  return i > 0 ? guide.slice(0, i) : '';
}

function compactLook(look: scene.Look | null): Partial<scene.Look> | undefined {
  if (!look) return undefined;
  const out: Partial<scene.Look> = {};
  for (const key of ['background', 'surface', 'ink', 'accent', 'accent_2'] as const) {
    if (look[key]) out[key] = look[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 镜头目录里能补上的：口播、算好的时长、画面描述。 */
function fillFromDir(root: string, item: StoryboardScene, rendered: Map<string, boolean>) {
  const dir = insideProject(root, item.dir);
  if (!dir) return;
  const body = readText(path.join(dir, 'scene.json'));
  if (body !== null) {
    item.created = true;
    try {
      const v = JSON.parse(body) as Record<string, unknown>;
      if (typeof v.text === 'string' && v.text.trim() !== '') item.text = v.text.trim();
      // 占位时长是 1；只有 cues 写过 timing 块的时长才是真的。
      if (typeof v.duration_seconds === 'number' && v.timing && typeof v.timing === 'object') item.seconds = v.duration_seconds;
    } catch {
      // scene.json 坏了：镜头页与渲染会报，这里只是少几项。
    }
  }
  const prompt = readText(path.join(dir, 'prompt.md'));
  if (prompt !== null && prompt.trim() !== '') {
    item.prompt = { path: path.relative(root, path.join(dir, 'prompt.md')).split(path.sep).join('/'), content: prompt };
  }
  item.rendered = rendered.get(path.resolve(dir)) ?? false;
}

export function readStoryboard(root: string): StoryboardResponse {
  const out: StoryboardResponse = { plan_path: '', scenes: [] };
  const treatment = readText(path.join(root, treatmentPath));
  if (treatment !== null && treatment.trim() !== '') out.treatment = { path: treatmentPath, content: treatment };
  if (readText(path.join(root, storyboardDocPath)) !== null) out.doc_path = storyboardDocPath;

  const discovered = discoverScenes(root);
  const rendered = new Map(discovered.map((sc) => [path.resolve(sc.directory), sc.exists]));

  const planFile = path.join(root, storyboardPlanPath);
  const planBody = readText(planFile);
  let plan: scene.TimingPlan | null = null;
  if (planBody !== null) {
    out.plan_path = storyboardPlanPath;
    try {
      out.updated_at = localRFC3339(fs.statSync(planFile).mtime);
    } catch {
      // 读得到却 stat 不了：不给时间。
    }
    try {
      plan = scene.parseTimingPlan(planBody);
    } catch (err) {
      out.parse_error = (err as Error).message;
    }
  }

  if (plan) {
    out.look = compactLook(plan.look);
    for (const entry of plan.scenes ?? []) {
      const item: StoryboardScene = { id: entry.id, dir: entry.dir, created: false, rendered: false };
      if (entry.chapter) item.chapter = entry.chapter;
      if (entry.visual_role) item.visual_role = entry.visual_role;
      if (entry.summary) item.summary = entry.summary;
      if (entry.film_style) item.film_style = entry.film_style;
      if (entry.first_subtitle !== null) item.anchor = `第 ${entry.first_subtitle} 条字幕`;
      else if (entry.first_phrase) item.anchor = `短语 ${entry.first_phrase}`;
      if (entry.handoff) {
        const h: StoryboardHandoff = { device: entry.handoff.device, device_label: deviceLabel(entry.handoff.device), bridge: entry.handoff.bridge };
        if (entry.handoff.style_shift) {
          h.style_shift = entry.handoff.style_shift;
          h.style_shift_label = scene.styleShiftOf(entry.handoff.style_shift)?.name ?? '';
        }
        item.handoff = h;
      }
      fillFromDir(root, item, rendered);
      out.scenes.push(item);
    }
    return out;
  }

  // 没有分镜计划（卡点项目、老项目）或计划写坏了：按项目里已有的镜头目录列出画面描述。
  for (const sc of discovered) {
    const dir = path.relative(root, sc.directory).split(path.sep).join('/');
    const item: StoryboardScene = { id: sc.id, dir, created: true, rendered: false };
    fillFromDir(root, item, rendered);
    out.scenes.push(item);
  }
  return out;
}
