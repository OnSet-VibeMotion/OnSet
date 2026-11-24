/**
 * 专栏跨期资产库与双向同步/沉淀的 Studio 后端接口：
 * - GET /api/series/{id}/assets
 * - PUT /api/series/{id}/publish-template
 * - DELETE /api/series/{id}/assets/{kind}/{name}
 * - POST /api/series/project/sync
 * - POST /api/series/project/promote
 */
import * as series from '../series';
import {
  DecodeError,
  decodeJSON,
  fieldBool,
  fieldString,
  goMap,
  methodNotAllowed,
  writeError,
  writeJSON,
} from './http';
import type { Server } from './studio';

function toStrings(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val.filter((x): x is string => typeof x === 'string');
}

export async function handleSeriesAssetsSubroute(
  s: Server,
  root: string,
  request: Request,
  id: string,
  parts: string[],
): Promise<Response> {
  const action = parts[1] ?? '';

  // GET /api/series/{id}/assets
  if (action === 'assets' && parts.length === 2) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const cfg = series.getSeries(root, id);
    if (!cfg) return writeError(404, 'not_found', `找不到专栏：${id}`);
    const assets = series.listSeriesAssets(root, id);
    const publishTemplate = series.readPublishTemplate(root, id);
    const curRoot = s.projectRoot();
    let binding: series.ProjectSeriesBinding | null = null;
    try {
      binding = curRoot ? series.readBinding(curRoot) : null;
    } catch {
      binding = null;
    }
    const isCurrent = binding?.series_id === id;
    const syncStatus = isCurrent && curRoot ? series.diffSeriesAssets(root, curRoot) : [];
    const candidates = isCurrent && curRoot ? series.listProjectAssetCandidates(curRoot) : [];
    return writeJSON(
      200,
      goMap({
        series_id: id,
        assets,
        publish_template: publishTemplate,
        current_project_bound: isCurrent,
        sync_status: syncStatus,
        project_candidates: candidates,
      }),
    );
  }

  // DELETE /api/series/{id}/assets/{kind}/{name}
  if (action === 'assets' && parts.length === 4) {
    if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
    const kind = parts[2] ?? '';
    const name = parts[3] ?? '';
    if (!series.isDirAssetKind(kind)) return writeError(400, 'invalid_kind', `不支持删除的资产类型：${kind}`);
    try {
      series.deleteSeriesAsset(root, id, kind, name);
      return writeJSON(200, goMap({ deleted: `${kind}:${name}` }));
    } catch (err) {
      return writeError(404, 'not_found', (err as Error).message);
    }
  }

  // PUT /api/series/{id}/publish-template
  if (action === 'publish-template' && parts.length === 2) {
    if (request.method !== 'PUT') return methodNotAllowed('PUT');
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    try {
      const saved = series.writePublishTemplate(root, id, {
        title_pattern: fieldString(body, 'title_pattern') || undefined,
        default_hashtags: toStrings(body.default_hashtags),
        description_footer: fieldString(body, 'description_footer') || undefined,
        cover_guidelines: fieldString(body, 'cover_guidelines') || undefined,
        credits_lines: toStrings(body.credits_lines),
      });
      return writeJSON(200, goMap({ series_id: id, publish_template: saved }));
    } catch (err) {
      const msg = (err as Error).message;
      return writeError(msg.startsWith('找不到专栏') ? 404 : 400, 'publish_template_error', msg);
    }
  }

  return writeError(404, 'not_found', '专栏资产接口路径不存在');
}

/** POST /api/series/project/sync | POST /api/series/project/promote */
export async function handleProjectSeriesAssetAction(
  s: Server,
  root: string,
  request: Request,
  action: 'sync' | 'promote',
): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;

  let body: Record<string, unknown>;
  try {
    body = await decodeJSON(request);
  } catch (err) {
    return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
  }

  if (action === 'sync') {
    const kind = fieldString(body, 'kind');
    const name = fieldString(body, 'name');
    const replace = fieldBool(body, 'replace');
    const all = fieldBool(body, 'all');
    try {
      s.acquire(p.path, '同步专栏资产');
    } catch (err) {
      return writeError(409, 'project_busy', (err as Error).message);
    }
    try {
      if (all) {
        const statuses = series.diffSeriesAssets(root, p.path);
        const synced: series.SyncAssetResult[] = [];
        for (const item of statuses) {
          if (
            item.status === 'missing' ||
            item.status === 'update_available' ||
            (replace && item.status !== 'synced')
          ) {
            synced.push(series.syncAssetToProject(root, p.path, { kind: item.kind, name: item.name, replace }));
          }
        }
        return writeJSON(200, goMap({ synced }));
      }
      if (!series.ValidAssetKinds.has(kind as series.AssetKind)) {
        return writeError(400, 'invalid_kind', `不支持的资产类型：${kind}`);
      }
      const result = series.syncAssetToProject(root, p.path, {
        kind: kind as series.AssetKind,
        name,
        replace,
      });
      return writeJSON(200, goMap({ result }));
    } catch (err) {
      return writeError(400, 'series_sync_failed', (err as Error).message);
    } finally {
      s.release(p.path);
    }
  }

  // promote：从当前项目沉淀回所属专栏（只写用户级专栏库，不改项目内容除更新 synced_assets 摘要）。
  const binding = series.readBinding(p.path);
  if (!binding) return writeError(400, 'no_series', '当前项目没有归属任何专栏');
  const kind = fieldString(body, 'kind');
  const name = fieldString(body, 'name');
  const from = fieldString(body, 'from');
  const replace = fieldBool(body, 'replace');
  if (!series.isDirAssetKind(kind)) {
    return writeError(400, 'invalid_kind', `沉淀资产类型必须是 shared、cast、bumper、audio 或 cover：${kind}`);
  }
  try {
    const result = series.promoteAssetToSeries(root, binding.series_id, p.path, { kind, name, from, replace });
    return writeJSON(200, goMap({ result }));
  } catch (err) {
    return writeError(400, 'series_promote_failed', (err as Error).message);
  }
}
