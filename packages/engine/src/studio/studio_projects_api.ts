/**
 * 项目与目录相关的 HTTP 接口：/api/directories、/api/projects/*、/api/workspaces/*。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as brandkit from '../brandkit';
import { envMap } from '../envutil';
import * as filmstyle from '../filmstyle';
import { goClean, goTrimSpace } from '../gofmt';
import * as preset from '../preset';
import * as projectinit from '../projectinit';
import * as series from '../series';
import { directoryBrowseRoot, directoryDrives } from './directories';
import { startFilmStyleTask } from './filmstyle';
import { DecodeError, decodeJSONStrict, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { recordNamingUsage } from './naming';
import { discoverScenes, fileExists } from './scenes';
import { installSkills } from './skills';
import type { Server } from './studio';
import {
  defaultParent,
  dirExists,
  isStudioProjectDir,
  isWithinStudioBrowseRoot,
  type Project,
  type ProjectSummary,
  projectJSON,
  stageFor,
  studioBrowseRoot,
  summaryJSON,
} from './studio_inspect';

/** summaryLimit 是首页侧栏要摘要的最近项目数：每个摘要要扫一遍项目目录。 */
const summaryLimit = 15;

export interface ProjectAPIHost {
  readonly server: Server;
  projects(): Project[];
  currentId(): string;
  setCurrentId(id: string): void;
  lastParent(): string;
  setLastParent(parent: string): void;
  removeProjectById(id: string): void;
  saveRegistry(): void;
  trySaveRegistry(): void;
}

export function directoriesAPI(request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const home = studioBrowseRoot();
  const requested = new URL(request.url).searchParams.get('path') ?? '';
  const dir = requested !== '' ? path.resolve(requested) : home;
  const root = directoryBrowseRoot(dir, home);
  if (!isWithinStudioBrowseRoot(dir)) {
    return writeError(403, 'directory_outside_root', '只能浏览服务器用户目录下的文件夹');
  }
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return writeError(400, 'directory_unavailable', '目录不存在或不可读取');
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return writeError(403, 'directory_unreadable', '没有权限读取这个目录');
  }
  const entries = items
    .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
    .map((item) => {
      const child = path.join(dir, item.name);
      return { name: item.name, path: child, is_project: isStudioProjectDir(child) };
    });
  entries.sort((a, b) => {
    if (a.is_project !== b.is_project) return a.is_project ? -1 : 1;
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const parent = dir !== root ? path.dirname(dir) : '';
  const drives = directoryDrives();
  return writeJSON(200, goMap({ path: dir, parent, root, entries, ...(drives.length ? { drives } : {}) }));
}

function summarizeProject(s: Server, p: Project): ProjectSummary {
  if (!dirExists(p.path)) return { stage: '', stage_label: '', completed: 0, total: 0, missing: true };
  const scenes = discoverScenes(p.path);
  const at = stageFor(p.path, scenes);
  const summary: ProjectSummary = {
    stage: at.stage,
    stage_label: at.label,
    completed: 0,
    total: scenes.length,
    busy: s.busyHolder(p.path) || undefined,
  };
  for (const sc of scenes) if (sc.exists && !sc.stale) summary.completed++;
  return summary;
}

export function projectsAPI(host: ProjectAPIHost): Response {
  const projects = host.projects();
  const current = host.currentId();
  const lastParent = host.lastParent();
  const recent = [...projects].sort((a, b) => {
    const x = a.last_opened_at ?? '';
    const y = b.last_opened_at ?? '';
    return x > y ? -1 : x < y ? 1 : 0;
  });
  const summaries: Record<string, unknown> = {};
  recent.forEach((p, i) => {
    if (i < summaryLimit) summaries[p.id] = summaryJSON(summarizeProject(host.server, p));
    // 只查目录还在不在，便宜；完整摘要只给最近的几个。
    else if (!dirExists(p.path))
      summaries[p.id] = summaryJSON({ stage: '', stage_label: '', completed: 0, total: 0, missing: true });
  });
  return writeJSON(
    200,
    goMap({
      projects: projects.map(projectJSON),
      current_project_id: current,
      summaries: goMap(summaries),
      default_parent: defaultParent(lastParent, recent),
    }),
  );
}

export async function createProjectAPI(host: ProjectAPIHost, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  let req: {
    parent: string;
    name: string;
    canvas: string;
    delivery: string;
    narration: string;
    film_style: string;
    naming: string;
    series_id: string;
    episode?: number;
  };
  try {
    const body = await decodeJSONStrict(request);
    let episode: number | undefined;
    if (body.episode !== undefined && body.episode !== null && body.episode !== '') {
      if (typeof body.episode !== 'number' || !Number.isInteger(body.episode) || body.episode < 1) {
        throw new DecodeError('episode 必须是正整数');
      }
      episode = body.episode;
    }
    req = {
      parent: fieldString(body, 'parent'),
      name: fieldString(body, 'name'),
      canvas: fieldString(body, 'canvas'),
      // delivery 与 narration 同 onset init --delivery / --narration，缺省为 speech / solo。
      delivery: fieldString(body, 'delivery'),
      narration: fieldString(body, 'narration'),
      // film_style 是整片风格（风格库目录名、中文名或英文名），空表示不用。
      // 建好项目后在后台起一个 onset film-style use 任务，任务编号随响应返回。
      film_style: fieldString(body, 'film_style'),
      // naming 是起名那次调用的凭据（/api/projects/name 给的），建好后把那次的用量记进新项目。
      naming: fieldString(body, 'naming'),
      // 可选：归属专栏 ID 与期号；未显式传入的画幅/做法/风格将回退至专栏默认预设。
      series_id: fieldString(body, 'series_id'),
      episode,
    };
  } catch {
    return writeError(400, 'invalid_request', '请填写项目名称');
  }
  const seriesRoot = series.defaultDir(envMap());
  let seriesCfg: series.SeriesConfig | null = null;
  if (req.series_id !== '') {
    seriesCfg = series.getSeries(seriesRoot, req.series_id);
    if (!seriesCfg) return writeError(400, 'unknown_series', `找不到专栏：${req.series_id}`);
    if (req.canvas === '' && seriesCfg.defaults.canvas) req.canvas = seriesCfg.defaults.canvas;
    if (req.delivery === '' && seriesCfg.defaults.delivery) req.delivery = seriesCfg.defaults.delivery;
    if (req.narration === '' && seriesCfg.defaults.narration) req.narration = seriesCfg.defaults.narration;
    if (req.film_style === '' && seriesCfg.defaults.film_style) req.film_style = seriesCfg.defaults.film_style;
    if (req.parent === '' && seriesCfg.parent_dir) req.parent = seriesCfg.parent_dir;
  }
  if (goTrimSpace(req.name) === '') return writeError(400, 'invalid_request', '请填写项目名称');
  if (req.canvas === '') req.canvas = preset.defaultPreset().id;
  const parent = path.resolve(req.parent);
  if (!isWithinStudioBrowseRoot(parent))
    return writeError(403, 'directory_outside_root', '只能在服务器用户目录下创建项目');
  if (!dirExists(parent)) return writeError(400, 'directory_unavailable', '父目录不存在');
  const name = path.basename(goClean(req.name));
  if (name === '.' || name === '..' || name !== req.name || /[/\\]/.test(name)) {
    return writeError(400, 'invalid_project_name', '项目名称只能是一个文件夹名称');
  }
  const target = path.join(parent, name);
  if (fileExists(target)) return writeError(409, 'project_exists', '这个目录已经存在');
  let filmStyle: filmstyle.Style | undefined;
  if (req.film_style !== '') {
    try {
      filmStyle = filmstyle.lookup(req.film_style);
    } catch (err) {
      return writeError(400, 'unknown_film_style', (err as Error).message);
    }
  }
  if (req.delivery === '') req.delivery = projectinit.DeliverySpeech;
  if (req.narration === '') req.narration = projectinit.NarrationSolo;
  const opts: projectinit.Options = { target, canvas: req.canvas, delivery: req.delivery, narration: req.narration };
  try {
    projectinit.validate(opts);
  } catch (err) {
    return writeError(400, 'invalid_mode', (err as Error).message);
  }
  if (!preset.byID(req.canvas)) return writeError(400, 'invalid_canvas', '未知画幅：' + req.canvas);
  try {
    projectinit.create(opts);
  } catch (err) {
    return writeError(400, 'project_create_failed', (err as Error).message);
  }
  if (seriesCfg) {
    try {
      const ep = req.episode ?? seriesCfg.next_episode;
      series.bindProject(seriesRoot, seriesCfg.id, target, { episode: ep });
      series.applySeriesDefaultsToProject(target, seriesCfg);
      series.materializeSeriesIntoProject(seriesRoot, target);
      if (seriesCfg.defaults.brand_kit_id) {
        try {
          brandkit.applyBrandKitToProject(
            brandkit.defaultBrandKitsDir(envMap()),
            seriesCfg.defaults.brand_kit_id,
            target,
          );
        } catch {
          // 品牌包已删或不可用时不阻断建项目。
        }
      }
    } catch (err) {
      return writeError(500, 'series_bind_failed', (err as Error).message);
    }
  }
  let p: Project;
  try {
    p = host.server.openProject(target);
  } catch (err) {
    return writeError(500, 'project_register_failed', (err as Error).message);
  }
  // 官方技能从本机缓存拷进项目（前置资源由 onset setup 准备，这里不联网），放到后台：项目先打开。
  // 用登记后的路径（已 realpath），与 currentProject() 返回的一致。
  installSkills(host.server, p.path);
  recordNamingUsage(req.naming, p.path);
  host.setCurrentId(p.id);
  host.setLastParent(parent);
  host.trySaveRegistry();
  const resp: Record<string, unknown> = { project: projectJSON(p) };
  if (filmStyle) {
    // 第一次要下载风格库，放到后台；它占项目写锁，装好之前开工会被告知项目正忙。
    try {
      resp.film_style_task = startFilmStyleTask(host.server, p, filmStyle, false).task_id;
    } catch (err) {
      resp.film_style_error = (err as Error).message;
    }
  }
  return writeJSON(201, goMap(resp));
}

export async function openProjectAPI(host: ProjectAPIHost, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  let file: string;
  try {
    file = fieldString(await decodeJSONStrict(request), 'path');
  } catch {
    return writeError(400, 'invalid_json', '请求不是合法 JSON');
  }
  let p: Project;
  try {
    p = host.server.openProject(file);
  } catch (err) {
    return writeError(400, 'project_unavailable', (err as Error).message);
  }
  host.setCurrentId(p.id);
  host.trySaveRegistry();
  return writeJSON(200, goMap({ project: projectJSON(p) }));
}

export async function removeProjectAPI(host: ProjectAPIHost, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  let id = '';
  try {
    id = fieldString(await decodeJSONStrict(request), 'project_id');
  } catch {
    id = '';
  }
  if (id === '') return writeError(400, 'invalid_request', '缺少 project_id');
  host.removeProjectById(id);
  try {
    host.saveRegistry();
  } catch (err) {
    return writeError(500, 'registry_write_failed', (err as Error).message);
  }
  return writeJSON(200, goMap({ ok: true }));
}

export function currentProjectAPI(host: ProjectAPIHost): Response {
  const current = host.currentId();
  for (const p of host.projects()) if (p.id === current) return writeJSON(200, goMap({ project: projectJSON(p) }));
  return writeJSON(200, goMap({ project: null }));
}

export async function switchProjectAPI(host: ProjectAPIHost, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  let id: string;
  try {
    id = fieldString(await decodeJSONStrict(request), 'project_id');
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    throw err;
  }
  for (const p of host.projects()) {
    if (p.id === id) {
      host.setCurrentId(p.id);
      host.trySaveRegistry();
      return writeJSON(200, goMap({ project: projectJSON(p) }));
    }
  }
  return writeError(404, 'project_not_found', '项目未登记');
}
