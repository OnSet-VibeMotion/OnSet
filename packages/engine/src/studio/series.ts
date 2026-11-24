/**
 * 专栏（Series）的 Studio 后端接口：/api/series/*。
 *
 * 与音色库、品牌包相同，专栏存在用户级目录（ONSET_SERIES_DIR），跨项目共用；
 * 项目归属通过项目根目录的 onset.series.json 落盘，不移动任何项目文件夹。
 */
import fs from 'node:fs';
import { envMap } from '../envutil';
import * as series from '../series';
import { DecodeError, decodeJSON, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { handleProjectSeriesAssetAction, handleSeriesAssetsSubroute } from './series_assets';
import type { Server } from './studio';
import { isWithinStudioBrowseRoot, projectJSON } from './studio_inspect';

function seriesRoot(): string {
  return series.defaultDir(envMap());
}

function optionalPositiveInt(body: Record<string, unknown>, key: string): number | undefined {
  const val = body[key];
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'number' && Number.isInteger(val) && val >= 1) return val;
  throw new DecodeError(`${key} 必须是正整数`);
}

function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  if (!(key in body)) return undefined;
  const val = body[key];
  if (val === null) return '';
  if (typeof val === 'string') return val;
  throw new DecodeError(`${key} 必须是字符串`);
}

function parseDefaults(raw: unknown): series.SeriesDefaults | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DecodeError('defaults 必须是对象');
  const d = raw as Record<string, unknown>;
  const str = (key: string) => (typeof d[key] === 'string' ? (d[key] as string) : undefined);
  const extras = Array.isArray(d.extra_film_styles)
    ? d.extra_film_styles.filter((x): x is string => typeof x === 'string')
    : undefined;
  return {
    canvas: str('canvas'),
    delivery: str('delivery'),
    narration: str('narration'),
    film_style: str('film_style'),
    extra_film_styles: extras,
    tts_voice: str('tts_voice'),
    brand_kit_id: str('brand_kit_id'),
    orchestrator: str('orchestrator'),
    renderer: str('renderer'),
  };
}

function formatSeriesItem(s: Server, root: string, cfg: series.SeriesConfig): Record<string, unknown> {
  const projects = s.registeredProjects().filter((p) => p.series_id === cfg.id);
  return goMap({
    ...cfg,
    brief: series.readBrief(root, cfg.id),
    project_count: projects.length,
  });
}

function validateParentDir(parent: string | undefined): Response | null {
  if (!parent) return null;
  if (!isWithinStudioBrowseRoot(parent)) {
    return writeError(403, 'directory_outside_root', '专栏默认目录必须在用户目录下');
  }
  return null;
}

export async function seriesAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const root = seriesRoot();

  // GET /api/series | POST /api/series
  if (rest === '') {
    if (request.method === 'GET') {
      const items = series.listSeries(root);
      return writeJSON(200, goMap({ dir: root, series: items.map((item) => formatSeriesItem(s, root, item)) }));
    }
    if (request.method !== 'POST') return methodNotAllowed('GET, POST');
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    try {
      const parentDir = optionalStringField(body, 'parent_dir');
      const parentErr = validateParentDir(parentDir);
      if (parentErr) return parentErr;
      const created = series.createSeries(root, {
        id: optionalStringField(body, 'id'),
        name: fieldString(body, 'name'),
        description: optionalStringField(body, 'description'),
        accent: optionalStringField(body, 'accent'),
        parent_dir: parentDir,
        naming_pattern: optionalStringField(body, 'naming_pattern'),
        next_episode: optionalPositiveInt(body, 'next_episode'),
        defaults: parseDefaults(body.defaults),
        brief: optionalStringField(body, 'brief'),
      });
      return writeJSON(201, formatSeriesItem(s, root, created));
    } catch (err) {
      return writeError(400, 'series_error', (err as Error).message);
    }
  }

  // POST /api/series/unbind
  if (rest === 'unbind') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let projectId: string;
    try {
      projectId = fieldString(await decodeJSON(request), 'project_id');
    } catch (err) {
      return writeError(400, 'invalid_json', (err as Error).message);
    }
    const target = s.registeredProjects().find((p) => p.id === projectId);
    if (!target) return writeError(404, 'project_not_found', '项目未登记');
    try {
      s.acquire(target.path, '移出专栏');
    } catch (err) {
      return writeError(409, 'project_busy', (err as Error).message);
    }
    try {
      if (fs.existsSync(target.path)) series.unbindProject(target.path);
      const updated = s.updateProjectSeries(target.id, undefined, undefined) ?? target;
      return writeJSON(200, goMap({ project: projectJSON(updated) }));
    } finally {
      s.release(target.path);
    }
  }

  // POST /api/series/project/sync | POST /api/series/project/promote
  if (rest === 'project/sync') return handleProjectSeriesAssetAction(s, root, request, 'sync');
  if (rest === 'project/promote') return handleProjectSeriesAssetAction(s, root, request, 'promote');

  const parts = rest.split('/').filter(Boolean);
  const id = parts[0] ?? '';
  const action = parts[1] ?? '';
  if (!id) return writeError(404, 'not_found', '专栏接口路径不存在');
  if (action === 'assets' || action === 'publish-template') {
    return handleSeriesAssetsSubroute(s, root, request, id, parts);
  }
  if (parts.length > 2) return writeError(404, 'not_found', '专栏接口路径不存在');

  // POST /api/series/{id}/bind
  if (action === 'bind') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', (err as Error).message);
    }
    let projectId: string;
    let episode: number | undefined;
    try {
      projectId = fieldString(body, 'project_id');
      episode = optionalPositiveInt(body, 'episode');
    } catch (err) {
      return writeError(400, 'invalid_request', (err as Error).message);
    }
    const target = s.registeredProjects().find((p) => p.id === projectId);
    if (!target) return writeError(404, 'project_not_found', '项目未登记');
    try {
      s.acquire(target.path, '归入专栏');
    } catch (err) {
      return writeError(409, 'project_busy', (err as Error).message);
    }
    try {
      const binding = series.bindProject(root, id, target.path, { episode });
      const updatedProject = s.updateProjectSeries(target.id, binding.series_id, binding.episode) ?? target;
      const latest = series.getSeries(root, id);
      return writeJSON(
        200,
        goMap({
          project: projectJSON(updatedProject),
          binding,
          series: latest ? formatSeriesItem(s, root, latest) : null,
        }),
      );
    } catch (err) {
      return writeError(400, 'series_bind_failed', (err as Error).message);
    } finally {
      s.release(target.path);
    }
  }

  if (action !== '') return writeError(404, 'not_found', '专栏接口路径不存在');

  // GET /api/series/{id}
  if (request.method === 'GET') {
    const cfg = series.getSeries(root, id);
    if (!cfg) return writeError(404, 'not_found', `找不到专栏：${id}`);
    const projects = s
      .registeredProjects()
      .filter((p) => p.series_id === cfg.id)
      .sort((a, b) => (a.episode ?? Number.MAX_SAFE_INTEGER) - (b.episode ?? Number.MAX_SAFE_INTEGER));
    return writeJSON(
      200,
      goMap({
        series: formatSeriesItem(s, root, cfg),
        projects: projects.map(projectJSON),
      }),
    );
  }

  // PUT /api/series/{id}
  if (request.method === 'PUT') {
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', (err as Error).message);
    }
    try {
      const parentDir = optionalStringField(body, 'parent_dir');
      const parentErr = validateParentDir(parentDir);
      if (parentErr) return parentErr;
      const updated = series.updateSeries(root, id, {
        name: optionalStringField(body, 'name'),
        description: optionalStringField(body, 'description'),
        accent: optionalStringField(body, 'accent'),
        parent_dir: parentDir,
        naming_pattern: optionalStringField(body, 'naming_pattern'),
        next_episode: optionalPositiveInt(body, 'next_episode'),
        defaults: parseDefaults(body.defaults),
        brief: optionalStringField(body, 'brief'),
      });
      return writeJSON(200, formatSeriesItem(s, root, updated));
    } catch (err) {
      const msg = (err as Error).message;
      return writeError(msg.startsWith('找不到专栏') ? 404 : 400, 'series_error', msg);
    }
  }

  // DELETE /api/series/{id}
  if (request.method === 'DELETE') {
    try {
      series.deleteSeries(root, id);
      // 同步解除已登记项目对该专栏的绑定（绝不删除任何项目目录）。
      for (const p of s.registeredProjects()) {
        if (p.series_id === id && fs.existsSync(p.path)) {
          try {
            const binding = series.readBinding(p.path);
            if (binding?.series_id === id) series.unbindProject(p.path);
          } catch {
            // 忽略单个损坏文件。
          }
        }
      }
      s.clearSeriesProjects(id);
      return writeJSON(200, goMap({ deleted_id: id }));
    } catch (err) {
      return writeError(404, 'not_found', (err as Error).message);
    }
  }

  return methodNotAllowed('GET, PUT, DELETE');
}
