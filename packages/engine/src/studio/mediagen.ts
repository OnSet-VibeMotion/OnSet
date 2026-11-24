/**
 * 多模态素材生成与跨项目资产库的 Studio 后端接口：/api/media-gen/*。
 */

import { envMap } from '../envutil';
import * as mediagen from '../mediagen';
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

export async function mediaGenAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const env = envMap();
  const assetsRoot = mediagen.defaultAssetsDir(env);

  // GET /api/media-gen/providers  |  PUT /api/media-gen/providers
  if (rest === 'providers') {
    if (request.method === 'GET') {
      return writeJSON(
        200,
        goMap({
          providers: mediagen.listMediaProviders(env),
          guide: mediagen.GenerationLadderGuide,
        }),
      );
    }
    if (request.method !== 'PUT') return methodNotAllowed('GET, PUT');
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    const id = fieldString(body, 'id') as mediagen.MediaProviderId;
    if (!['openai-compatible', 'dashscope', 'fal', 'codex'].includes(id)) {
      return writeError(400, 'invalid_provider', `不支持的供应商：${id}`);
    }
    const existing = mediagen.loadMediaProviderConfigs(env)[id];
    mediagen.saveMediaProviderConfig(
      {
        id,
        enabled: body.enabled !== undefined ? fieldBool(body, 'enabled') : existing.enabled,
        base_url: fieldString(body, 'base_url') || existing.base_url,
        api_key: fieldString(body, 'api_key') || existing.api_key,
        default_models:
          body.default_models && typeof body.default_models === 'object'
            ? {
                ...(existing.default_models ?? {}),
                ...(body.default_models as Partial<Record<mediagen.Modality, string>>),
              }
            : existing.default_models,
      },
      env,
    );
    return writeJSON(200, goMap({ providers: mediagen.listMediaProviders(env) }));
  }

  // GET /api/media-gen/assets
  if (rest === 'assets') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const url = new URL(request.url);
    const modRaw = url.searchParams.get('modality') ?? '';
    const modality = modRaw === 'image' || modRaw === 'video' || modRaw === 'audio' ? modRaw : undefined;
    const assets = mediagen.listAssets(assetsRoot, {
      modality,
      query: url.searchParams.get('q') ?? undefined,
      includeTrashed: url.searchParams.get('trashed') === '1',
    });
    return writeJSON(200, goMap({ assets, jobs: mediagen.listMediaJobs(assetsRoot).slice(0, 30) }));
  }

  // POST /api/media-gen/import-to-project
  if (rest === 'import-to-project') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const p = s.projectOr404();
    if (p instanceof Response) return p;
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    try {
      s.acquire(p.path, '导入素材');
    } catch (err) {
      return writeError(409, 'project_busy', (err as Error).message);
    }
    try {
      const res = mediagen.importAssetToProject(
        assetsRoot,
        { asset_id: fieldString(body, 'asset_id'), version_id: fieldString(body, 'version_id') },
        p.path,
        fieldString(body, 'target_name') || undefined,
      );
      return writeJSON(200, goMap(res as unknown as Record<string, unknown>));
    } catch (err) {
      return writeError(400, 'asset_import_failed', (err as Error).message);
    } finally {
      s.release(p.path);
    }
  }

  // POST /api/media-gen/retry-save
  if (rest === 'retry-save') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    try {
      const job = mediagen.retrySaveMediaJob(assetsRoot, fieldString(body, 'job_id'));
      return writeJSON(200, goMap({ job }));
    } catch (err) {
      return writeError(400, 'retry_save_failed', (err as Error).message);
    }
  }

  return writeError(404, 'not_found', '多模态生成接口路径不存在');
}
