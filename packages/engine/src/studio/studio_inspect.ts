/**
 * Studio 的核心类型、路径/目录辅助函数与项目状态检查（inspectProject、projectMetadata、stepOf、stageFor）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import * as filmstyle from '../filmstyle';
import * as flow from '../flow';
import { goPathError } from '../gofmt';
import * as preset from '../preset';
import * as series from '../series';
import * as studioview from '../studioview';
import { withinDirectoryBrowseRoot } from './directories';
import { goMap } from './http';
import { computeStations, flowView, latestOutput } from './progress';
import { filmVideos } from './reviewreport';
import { discoverScenes, fileExists, type SceneSummary } from './scenes';
import { readStepMark, viewPages } from './view';

export interface Config {
  /** 桌面端按来源地址解析系统/PAC 代理；只用于插件的 Git 下载，返回 Chromium resolveProxy 的原样结果。 */
  stationProxy?: (url: string) => Promise<string>;
  /** 只有桌面端提供；插件逻辑仍在子进程，不加载到宿主。 */
  stationBrowser?: (request: flow.StationBrowserRequest) => Promise<flow.StationBrowserLease>;
  projectPath?: string;
  configPath?: string;
  /** 对应 onset --unsafe：编排工具与 onset 子命令都关闭权限隔离。 */
  unsafe?: boolean;
  /**
   * onset 命令行入口（Go 版是 os.Executable()）：写任务经它运行 onset 子命令，编排工具的 PATH 里也放它所在的目录。
   * 不给时用 envutil.onsetExecutable()（ONSET_SELF）。
   */
  executable?: string;
}

/** 登记的一个项目。字段名照抄 Go 的 JSON tag。 */
export interface Project {
  id: string;
  path: string;
  name: string;
  last_opened_at?: string;
  /** 所属专栏 ID（缓存自项目根目录的 onset.series.json，方便首页分组）。 */
  series_id?: string;
  /** 在专栏里的期号（可选）。 */
  episode?: number;
}

export function projectJSON(p: Project): Record<string, unknown> {
  return {
    id: p.id,
    path: p.path,
    name: p.name,
    last_opened_at: p.last_opened_at || undefined,
    series_id: p.series_id || undefined,
    episode: p.episode,
  };
}

export interface Registry {
  schema: number;
  /** Go 的 nil 切片写成 null。 */
  projects: Project[] | null;
  /** 上次新建项目时选的父目录，首页的「保存到」默认用它。 */
  last_parent?: string;
  /** 客户端用哪套界面皮肤（studio/skins.ts）；空是放映室。 */
  skin?: string;
}

/** 最近项目列表里每个项目的一行状态：做到哪一步、出了几个镜头、是否正忙。 */
export interface ProjectSummary {
  /** 制作走到了顶栏的哪一步（步骤 id）与它的名字。 */
  stage: string;
  stage_label: string;
  completed: number;
  total: number;
  busy?: string;
  missing?: boolean;
}

export function summaryJSON(s: ProjectSummary): Record<string, unknown> {
  return {
    stage: s.stage,
    stage_label: s.stage_label,
    completed: s.completed,
    total: s.total,
    busy: s.busy || undefined,
    missing: s.missing || undefined,
  };
}

export function canonicalProjectPath(file: string): string {
  if (file === '') throw new Error('项目路径不能为空');
  const abs = path.resolve(file);
  let clean: string;
  try {
    clean = fs.realpathSync(abs);
  } catch (err) {
    throw new Error('项目目录不可用：' + goPathError('lstat', abs, err), { cause: err });
  }
  if (!dirExists(clean)) throw new Error('项目路径必须是目录');
  return clean;
}

export function projectID(file: string): string {
  return 'project-' + crypto.createHash('sha256').update(file).digest().subarray(0, 8).toString('hex');
}

export function studioBrowseRoot(): string {
  const home = process.env.HOME || os.homedir();
  if (home) return path.resolve(home);
  return path.resolve(process.cwd());
}

export function isWithinStudioBrowseRoot(file: string): boolean {
  return withinDirectoryBrowseRoot(path.resolve(file), studioBrowseRoot());
}

export function isStudioProjectDir(dir: string): boolean {
  try {
    if (!fs.statSync(path.join(dir, 'frame.md')).isDirectory()) return true;
  } catch {
    // 没有 frame.md。
  }
  return dirExists(path.join(dir, 'scenes'));
}

export function dirExists(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** 遍历 root 下的全部非目录条目（filepath.WalkDir，d.Info() 是 lstat）。 */
export function walkFiles(root: string, visit: (file: string, info: fs.Stats) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, visit);
      continue;
    }
    try {
      visit(full, fs.lstatSync(full));
    } catch {
      // 竞态删除。
    }
  }
}

/** defaultParent 是新建项目的默认父目录：上次选的，否则最近一个项目所在的目录，否则家目录。 */
export function defaultParent(last: string, recent: Project[]): string {
  for (const candidate of [last, ...recent.map((p) => path.dirname(p.path))]) {
    if (candidate === '' || !isWithinStudioBrowseRoot(candidate)) continue;
    if (dirExists(candidate)) return candidate;
  }
  return studioBrowseRoot();
}

export function findProjectVideo(root: string): string {
  for (const file of filmVideos) {
    const candidate = path.join(root, file);
    if (fileExists(candidate)) return candidate;
  }
  return '';
}

export function inspectProject(p: Project): Record<string, unknown> {
  const scenes = discoverScenes(p.path);
  let done = 0;
  let stale = 0;
  for (const sc of scenes) {
    if (sc.exists) done++;
    if (sc.stale) stale++;
  }
  const meta = projectMetadata(p.path);
  // 整片风格的名字给顶栏用。
  try {
    const { manifest, ok } = filmstyle.installed(p.path);
    if (ok) meta.film_style = manifest.cn;
  } catch {
    // 读不了就不显示。
  }
  try {
    const binding = series.readBinding(p.path);
    if (binding) {
      meta.series_id = binding.series_id;
      meta.series_name = binding.series_name;
      if (binding.episode !== undefined) meta.episode = String(binding.episode);
    }
  } catch {
    // 绑定文件损坏时不阻断打开项目。
  }
  // 项目的流程：顶栏的步骤、第一步与用不上的页面都按它（界面不按片型写死）。没有流程记录的目录排不出路线：
  // 不给 flow 与 step，flow_error 照实说缺什么（界面据此提示，「开始制作」也会报同一句）。
  let flowState: Record<string, unknown>;
  try {
    flowState = { ...stepOf(p.path, scenes), flow: flowView(p.path) };
  } catch (err) {
    if (!(err instanceof flow.MissingFlowRecordError)) throw err;
    flowState = { flow_error: err.message };
  }
  return goMap({
    project: projectJSON(p),
    ...flowState,
    // 客户端有哪些页（宿主的加上内置插件登记的）：界面只列这里有的，组件仍在界面里按 id 对上。
    pages: viewPages().map((pg) => goMap({ id: pg.id, label: pg.label })),
    metadata: goMap(meta),
    scenes: goMap({ total: scenes.length, completed: done, stale }),
  });
}

/**
 * projectMetadata 从 frame.md 的 front matter 取画幅。Studio 只是观察者，项目改到一半、
 * front matter 写坏了也照样返回能读到的部分，不报错。
 *
 * 只看顶层键：front matter 里 colors.canvas 这类同名的嵌套键是颜色值，按行扫描会读错。
 */
export function projectMetadata(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'frame.md'), 'utf8').replaceAll('\r\n', '\n');
  } catch {
    return result;
  }
  if (!text.startsWith('---\n')) return result;
  const end = text.slice(4).indexOf('\n---');
  if (end < 0) return result;
  let front: unknown;
  try {
    front = YAML.parse(text.slice(4, 4 + end));
  } catch {
    return result;
  }
  if (front === null || front === undefined) return result;
  if (typeof front !== 'object' || Array.isArray(front)) return result;
  const f = front as Record<string, unknown>;
  const canvas = f.canvas;
  if (canvas !== null && typeof canvas === 'object' && !Array.isArray(canvas)) {
    const c = canvas as Record<string, unknown>;
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : 0);
    const width = int(c.width_px);
    const height = int(c.height_px);
    const fps = int(c.fps);
    const orientation = typeof c.orientation === 'string' ? c.orientation : '';
    if (width > 0 && height > 0) result.canvas = `${width}×${height}`;
    if (fps > 0) result.fps = String(fps);
    if (orientation !== '') result.orientation = orientation;
    const p = preset.byCanvas(width, height, fps, orientation);
    if (p) result.canvas_id = p.id;
  }
  return result;
}

/**
 * 顶栏标出的「现在在哪一步」：编排工具每轮结束前用 studio_step 标的为准（step_marked）；
 * 还没标过（老项目、没在客户端里做过）时按产物推一个。
 */
export function stepOf(root: string, scenes: SceneSummary[]): { step?: string; step_marked?: boolean } {
  const mark = readStepMark(root);
  // 编排工具的标记只在它比项目里最新的产物还新时才算：之后又有了新产物，说明它标的已经过时。
  if (mark && Date.parse(mark.at) >= latestOutput(root, scenes) - 1000) return { step: mark.step, step_marked: true };
  const { stations, current } = computeStations(root, scenes);
  const at = stations.find((s) => s.id === current);
  // 全部做完：停在最后一步。
  return { step: (at ?? stations[stations.length - 1]).step };
}

/**
 * stageFor 是首页最近项目那一行的阶段：与顶栏同一个来源（stepOf：编排标的步骤，否则制作路线当前一站所在的步骤），
 * 不另看文件。没有流程记录的目录排不出路线，为空。
 */
export function stageFor(root: string, scenes: SceneSummary[]): { stage: string; label: string } {
  let step: string;
  try {
    step = stepOf(root, scenes).step ?? '';
  } catch (err) {
    if (err instanceof flow.MissingFlowRecordError) return { stage: '', label: '' };
    throw err;
  }
  return { stage: step, label: studioview.steps().find((x) => x.id === step)?.label ?? step };
}
