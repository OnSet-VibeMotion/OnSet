/**
 * 项目里的镜头列表：studio.go 的 discoverScenes / SceneSummary / sceneRendering。
 */
import crypto from 'node:crypto';
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
  /**
   * 产物文件的指纹（修改时间与大小）。界面拿它给镜头视频的地址做缓存参数：只有这个镜头的产物变了才重新加载，
   * 编排工具改别的镜头、别的文件时，正在看的镜头不会被打断、从头播放。
   */
  output_stamp?: string;
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
    output_stamp: sc.output_stamp || undefined,
    stale: sc.stale,
    attempts: sc.attempts,
    usage: sc.usage ? usageJSON(sc.usage) : undefined,
    rendering: sc.rendering || undefined,
  };
}

/**
 * 镜头是否正在渲染：以 scene.run 写的进行中标记（render-<id>.live.json）为准，看标记里的进程还在不在。
 * 渲染器跑 hyperframes render 的几分钟里日志不动，所以不看日志静默。
 */
export function sceneRendering(dir: string, id: string): boolean {
  const live = scene.readLive(dir, id);
  return live ? scene.processAlive(live.pid) : false;
}

/**
 * scene.json 比产物新，但内容还是渲染时那一份：`scene_cues` 每次都把全部镜头的 scene.json 重写一遍，
 * 时长没变的镜头内容逐字节相同，只是修改时间变了。只看修改时间的话，重跑一次 cues 所有镜头都显示「要重渲染」
 * （2026-11 实测：修一个多音字重新配音后，24 个镜头全标成要重渲染）。
 * 按渲染记录（.am-render.json）里 scene.json 的摘要核对；记录对不上当前产物（大小不同）时不算数。
 * 只核对 scene.json 这一项：完整的输入指纹要读技能、配置与记忆，镜头列表每几秒刷新一次，算不起。
 */
function renderedFrom(dir: string, output: string, outputSize: number, sceneFile: string): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dir, scene.RecordFile), 'utf8')) as Record<string, unknown>;
    const parts = record.parts as Record<string, unknown> | undefined;
    if (record.output !== output || record.output_size !== outputSize || !parts) return false;
    const digest = crypto.createHash('sha256').update(fs.readFileSync(sceneFile)).digest('hex');
    return parts['file:scene.json'] === digest;
  } catch {
    return false;
  }
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
    let stamp = '';
    if (exists) {
      try {
        const out = fs.statSync(target);
        stamp = `${Math.floor(out.mtimeMs)}-${out.size}`;
        stale = fs.statSync(file).mtimeMs > out.mtimeMs && !renderedFrom(dir, output, out.size, file);
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
      output_stamp: stamp || undefined,
      stale,
      attempts: 0,
      rendering: sceneRendering(dir, id) || undefined,
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
