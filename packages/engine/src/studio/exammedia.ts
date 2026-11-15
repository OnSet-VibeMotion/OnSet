import fs from 'node:fs';
import path from 'node:path';
import * as scene from '../scene';
import { containedPath } from './sessions';
import type { SceneSummary } from './scenes';
import { discoverScenes } from './scenes';
import type { Project } from './studio';

export interface ExamAudio {
  file: string;
  start_seconds: number;
  duration_seconds: number;
  source_project: string;
}

/** 考场必须属于当前项目或已登记项目，路径仍使用 containedPath 的真实路径边界。 */
function examWorkspace(project: string, workdir: string, projects: Pick<Project, 'path' | 'name'>[]): { project: string; name: string; workdir: string } | null {
  if (!path.isAbsolute(workdir)) return null;
  // 项目登记使用真实路径，历史记录可能保留 macOS 的 /var → /private/var 别名。
  // 两边都归一后再计算相对位置；实际落在项目外的目录仍由 containedPath 拒绝。
  try { workdir = fs.realpathSync(workdir); } catch { return null; }
  for (const candidate of [{ path: project, name: path.basename(project) }, ...projects]) {
    try {
      const root = fs.realpathSync(candidate.path);
      const directory = containedPath(root, path.relative(root, workdir));
      if (fs.statSync(directory).isDirectory()) return { project: root, name: candidate.name, workdir: directory };
    } catch { /* 不属于该项目、项目已移走或链接逃出边界。 */ }
  }
  return null;
}

/** 只定位考试记录中的产物，不能借此读取其他项目里的任意文件。 */
export function resolveExamVideo(project: string, workdir: string, projects: Pick<Project, 'path' | 'name'>[]): { file: string; source_project: string } | null {
  const owner = examWorkspace(project, workdir, projects);
  if (!owner) return null;
  try {
    let output: string;
    try { output = scene.outputPath(scene.load(owner.workdir)); }
    catch { output = path.join(owner.workdir, 'out.mp4'); }
    const file = containedPath(owner.workdir, path.relative(owner.workdir, output));
    if (!fs.statSync(file).isFile()) return null;
    return { file, source_project: owner.name };
  } catch { return null; }
}

/** 仅沿考试记录的来源，在已登记项目里匹配；不接受请求方提供任意音频路径。 */
export function resolveExamAudio(project: string, workdir: string, sourceDirectory: string, projects: Pick<Project, 'path' | 'name'>[]): ExamAudio | null {
  try {
    const owner = examWorkspace(project, workdir, projects);
    if (!owner) return null;
    // 考试记录可能保留 /var 等别名，项目登记则使用 realpath。先统一路径，再校验项目边界。
    project = owner.project;
    workdir = owner.workdir;
    if (sourceDirectory) sourceDirectory = fs.realpathSync(sourceDirectory);
    const frozen = scene.load(containedPath(project, path.relative(project, workdir)));
    const sourceProject = sourceDirectory ? projects.find((p) => {
      const rel = path.relative(p.path, sourceDirectory);
      if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
      try { containedPath(p.path, rel); return true; } catch { return false; }
    }) : {path: project, name: path.basename(project)};
    if (!sourceProject) return null;
    const source = sourceDirectory || discoverScenes(sourceProject.path).find((s) => s.id === frozen.id)?.directory;
    if (!source) return null;
    const original = scene.load(containedPath(sourceProject.path, path.relative(sourceProject.path, source)));
    if (!matchesNarration(frozen, original)) return null;
    const file = containedPath(sourceProject.path, 'production/audio/voice.wav');
    if (!fs.statSync(file).isFile()) return null;
    const data = scene.buildSceneData(frozen);
    return {file, start_seconds: data.start_frame! / data.fps, duration_seconds: data.frames / data.fps, source_project: sourceProject.name};
  } catch { return null; }
}

function matchesNarration(frozen: scene.Scene, original: scene.Scene): boolean {
  if (frozen.id !== original.id || !frozen.timing) return false;
  const a = scene.buildSceneData(frozen), b = scene.buildSceneData(original);
  const compact = (text: string) => text.replace(/[\t\n\r ]/g, '');
  const aligned = a.phrases.length > 0 ? a.phrases.length === b.phrases.length &&
    a.phrases.every((p, i) => compact(p.text) === compact(b.phrases[i].text) && p.start_frame === b.phrases[i].start_frame && p.end_frame_exclusive === b.phrases[i].end_frame_exclusive)
    : b.phrases.length === 0 && a.cues.length > 0 && a.cues.length === b.cues.length &&
      a.cues.every((c, i) => compact(c.text) === compact(b.cues[i].text) && c.start_frame === b.cues[i].start_frame && c.end_frame_exclusive === b.cues[i].end_frame_exclusive);
  return a.start_frame !== null && a.start_frame === b.start_frame && a.frames === b.frames && a.fps === b.fps &&
    compact(frozen.text) === compact(original.text) && aligned;
}

/** 这是叠加当前项目口播的预览引用，不改写历史考试视频，也不冒充已冻结的考试音轨。 */
export function examPreviewAudio(project: string, workdir: string, sources: SceneSummary[]): Record<string, unknown> {
  const unavailable = { audio_unavailable: '此题未找到可匹配的项目口播，只能预览画面。' };
  try {
    const relative = path.relative(project, workdir);
    const frozen = scene.load(containedPath(project, relative));
    const source = sources.find((s) => s.id === frozen.id);
    if (!source || !frozen.timing) return unavailable;
    const original = scene.load(containedPath(project, path.relative(project, source.directory)));
    // 同编号不足以证明同一口播。必须同时匹配镜头范围、文字与实际短语时间，
    // 防止在项目甲里重放项目乙的旧题时误播甲的配音；不依赖易变的排版换行或事件绑定元数据。
    if (!matchesNarration(frozen, original)) return unavailable;
    const a = scene.buildSceneData(frozen);
    const audio = 'production/audio/voice.wav';
    if (!fs.statSync(containedPath(project, audio)).isFile()) return unavailable;
    return { preview_audio: { path: audio, start_seconds: a.start_frame! / a.fps, duration_seconds: a.frames / a.fps, label: '项目口播' } };
  } catch {
    return unavailable;
  }
}
