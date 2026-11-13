/**
 * 项目里的镜头列表：studio.go 的 discoverScenes / SceneSummary / sceneRendering。
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import * as scene from '../scene';
import { newUsage, usageAdd, usageJSON, type Usage } from '../tools';
import { walkDir } from './turns';

export interface SceneSummary {
  id: string;
  directory: string;
  duration_seconds?: number;
  output?: string;
  exists: boolean;
  stale: boolean;
  /** 这个镜头全部渲染尝试（含归档）的次数与用量合计。 */
  attempts: number;
  usage?: Usage;
  /** 这个镜头此刻正在渲染：进行中标记里的进程还在（没有标记时看渲染日志最近还在写，且比上一次尝试记录新）。 */
  rendering?: boolean;
}

/** SceneSummary 的 JSON（Go struct 的字段顺序与 omitempty）。 */
export function sceneSummaryJSON(sc: SceneSummary): Record<string, unknown> {
  return {
    id: sc.id,
    directory: sc.directory,
    duration_seconds: sc.duration_seconds || undefined,
    output: sc.output || undefined,
    exists: sc.exists,
    stale: sc.stale,
    attempts: sc.attempts,
    usage: sc.usage ? usageJSON(sc.usage) : undefined,
    rendering: sc.rendering || undefined,
  };
}

/**
 * renderingWindow 是判定「还在渲染」的日志静默上限（毫秒）。渲染工具一直往流日志里写事件，
 * 超过这么久没动静，多半是进程已经没了（被杀、机器睡眠），不再显示成渲染中。
 */
export const renderingWindow = 3 * 60 * 1000;

function mtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export function sceneRendering(dir: string, id: string, now: Date): boolean {
  // 有进行中标记时以它为准：渲染器跑 hyperframes render 的几分钟里日志不动，静默判断会误判成结束。
  const live = scene.readLive(dir, id);
  if (live) return scene.processAlive(live.pid);
  // 没有标记的是旧版 am 起的渲染，退回看日志。
  let latest: number | null = null;
  for (const name of ['render-' + id + '.stream.jsonl', 'render-' + id + '.user.log', 'render-' + id + '.stderr.log']) {
    const t = mtime(path.join(dir, name));
    if (t !== null && (latest === null || t > latest)) latest = t;
  }
  if (latest === null || now.getTime() - latest > renderingWindow) return false;
  const attempt = mtime(path.join(dir, 'render-' + id + '.attempt.json'));
  return attempt === null || attempt < latest;
}

export function fileExists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

export function discoverScenes(root: string): SceneSummary[] {
  const out: SceneSummary[] = [];
  // 渲染记忆的考场里是镜头副本，不是项目的镜头。
  const exams = path.join(root, 'production', 'memory-exams');
  walkDir(root, (file, entry) => {
    if (!entry) return;
    if (entry.isDirectory()) return file === exams ? 'skip' : undefined;
    if (entry.name !== 'scene.json') return;
    let v: Record<string, unknown>;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      v = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const id = v.id ?? '';
    const duration = v.duration_seconds ?? 0;
    const output = v.output ?? '';
    if (typeof id !== 'string' || typeof duration !== 'number' || typeof output !== 'string' || id === '') return;
    const dir = path.dirname(file);
    const target = path.join(dir, output);
    const rel = path.relative(dir, target);
    const contained = rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(output);
    const exists = contained && fileExists(target);
    let stale = false;
    if (exists) {
      try {
        stale = fs.statSync(file).mtimeMs > fs.statSync(target).mtimeMs;
      } catch {
        stale = false;
      }
    }
    const summary: SceneSummary = {
      id,
      directory: dir,
      duration_seconds: duration || undefined,
      output: output || undefined,
      exists,
      stale,
      attempts: 0,
      rendering: sceneRendering(dir, id, new Date()) || undefined,
    };
    const history = scene.attemptHistory(dir, id);
    if (history.length > 0) {
      const total = newUsage();
      for (const attempt of history) usageAdd(total, attempt.usage ?? newUsage());
      summary.attempts = history.length;
      summary.usage = total;
    }
    out.push(summary);
  });
  out.sort((a, b) => compareBytes(a.id, b.id));
  return currentScenes(root, out);
}

/**
 * 同一个镜头 id 只留一份。重做分镜时编排工具常把旧的一套整体挪进 `production/v1/scenes/` 之类的地方留底，
 * 两套 id 相同：不去重的话镜头列表出现两组，按 id 找镜头的地方（镜头页、渲染、校验）又先碰到旧的那份。
 * 取舍：分镜计划 `dir` 指向的 → 项目根 `scenes/` 下的 → 路径层级浅的 → 路径字典序。
 */
function currentScenes(root: string, scenes: SceneSummary[]): SceneSummary[] {
  const planned = plannedDirs(root);
  const top = path.join(root, 'scenes') + path.sep;
  const rank = (sc: SceneSummary): number[] => [
    planned.has(path.resolve(sc.directory)) ? 0 : 1,
    sc.directory.startsWith(top) ? 0 : 1,
    sc.directory.split(path.sep).length,
  ];
  const better = (a: SceneSummary, b: SceneSummary): boolean => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i];
    return compareBytes(a.directory, b.directory) < 0;
  };
  const chosen = new Map<string, SceneSummary>();
  for (const sc of scenes) {
    const prev = chosen.get(sc.id);
    if (!prev || better(sc, prev)) chosen.set(sc.id, sc);
  }
  return scenes.filter((sc) => chosen.get(sc.id) === sc);
}

/** 分镜计划 `production/scene-plan.json` 里每个镜头的 `dir`（绝对路径）；没有或读不了时为空。 */
function plannedDirs(root: string): Set<string> {
  const out = new Set<string>();
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'production', 'scene-plan.json'), 'utf8')) as { scenes?: unknown };
    if (!Array.isArray(plan.scenes)) return out;
    for (const entry of plan.scenes) {
      const dir = (entry as { dir?: unknown } | null)?.dir;
      if (typeof dir === 'string' && dir !== '') out.add(path.resolve(root, dir));
    }
  } catch {
    // 没有计划（卡点项目、旧项目）就只按位置判断。
  }
  return out;
}
