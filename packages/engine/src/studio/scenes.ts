/**
 * 项目里的镜头列表（studio.go 的 discoverScenes / SceneSummary 中不依赖 scene 包的部分）。
 *
 * /api/state、最近项目摘要、制作进度推断与「校验镜头」命令都只要知道有哪些镜头、产物在不在、是不是过期，
 * 这部分是纯文件扫描，先移植过来。
 *
 * TODO(scene)：scene 包移植完成后补上 attempts / usage（scene.AttemptHistory）与 rendering（sceneRendering），
 * 并接回 /api/scenes 系列路由。
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import type { Usage } from '../tools';
import { walkDir } from './turns';

export interface SceneSummary {
  id: string;
  directory: string;
  duration_seconds?: number;
  output?: string;
  exists: boolean;
  stale: boolean;
  /** 这个镜头全部渲染尝试（含归档）的次数与用量合计。TODO(scene)：现在总是 0 / 空。 */
  attempts: number;
  usage?: Usage;
  /** 这个镜头此刻正在渲染。TODO(scene)：现在总是 false。 */
  rendering?: boolean;
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
    out.push({ id, directory: dir, duration_seconds: duration || undefined, output: output || undefined, exists, stale, attempts: 0 });
  });
  out.sort((a, b) => compareBytes(a.id, b.id));
  return out;
}
