/**
 * 跨项目品牌包的 Studio 后端接口：/api/brand-kits。
 *
 * 与音色库相同，品牌包存于用户级目录，跨项目共用；应用到当前项目时经 production/brand-kit.json 落盘。
 */
import * as brandkit from '../brandkit';
import { envMap } from '../envutil';
import { DecodeError, decodeJSON, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import type { Server } from './studio';

function kitsDir(): string {
  return brandkit.defaultBrandKitsDir(envMap());
}

function kitResponse(kit: brandkit.BrandKit): Record<string, unknown> {
  return goMap({
    ...kit,
    effective_style: brandkit.effectiveBrandStyle(kit),
  });
}

export async function brandKitsAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const dir = kitsDir();

  // GET /api/brand-kits  |  POST /api/brand-kits
  if (rest === '') {
    if (request.method === 'GET') {
      const kits = brandkit.listBrandKits(dir);
      const root = s.projectRoot();
      const applied = root ? brandkit.readProjectBrandKit(root) : null;
      return writeJSON(200, goMap({ dir, kits: kits.map(kitResponse), applied }));
    }
    if (request.method !== 'POST') return methodNotAllowed('GET, POST');
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    try {
      const saved = brandkit.saveBrandKit(dir, {
        id: fieldString(body, 'id') || undefined,
        name: fieldString(body, 'name'),
        source_url: fieldString(body, 'source_url') || undefined,
        style: (body.style && typeof body.style === 'object' ? body.style : undefined) as
          | Partial<brandkit.BrandStyle>
          | undefined,
        style_overrides: (body.style_overrides && typeof body.style_overrides === 'object'
          ? body.style_overrides
          : undefined) as Partial<brandkit.BrandStyle> | undefined,
        rules: Array.isArray(body.rules) ? body.rules.filter((x): x is string => typeof x === 'string') : undefined,
        expected_updated_at: fieldString(body, 'expected_updated_at') || undefined,
      });
      return writeJSON(201, kitResponse(saved));
    } catch (err) {
      const msg = (err as Error).message;
      return writeError(msg.startsWith('BRAND_KIT_CHANGED') ? 409 : 400, 'brand_kit_error', msg);
    }
  }

  // POST /api/brand-kits/extract
  if (rest === 'extract') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    try {
      const kit = await brandkit.extractAndSaveBrandKit(dir, fieldString(body, 'url'), {
        kitId: fieldString(body, 'kit_id') || undefined,
        expectedUpdatedAt: fieldString(body, 'expected_updated_at') || undefined,
      });
      return writeJSON(200, kitResponse(kit));
    } catch (err) {
      const msg = (err as Error).message;
      return writeError(msg.startsWith('BRAND_KIT_CHANGED') ? 409 : 400, 'brand_kit_extract_failed', msg);
    }
  }

  // POST /api/brand-kits/{id}/apply  |  DELETE /api/brand-kits/{id}  |  GET /api/brand-kits/{id}
  const parts = rest.split('/').filter(Boolean);
  const id = parts[0] ?? '';
  const action = parts[1] ?? '';
  if (!id || parts.length > 2) return writeError(404, 'not_found', '品牌包接口路径不存在');

  if (action === 'apply') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const p = s.projectOr404();
    if (p instanceof Response) return p;
    try {
      const applied = brandkit.applyBrandKitToProject(dir, id, p.path);
      return writeJSON(200, goMap({ applied, prompt_section: brandkit.brandKitPromptSection(applied) }));
    } catch (err) {
      return writeError(400, 'brand_kit_apply_failed', (err as Error).message);
    }
  }

  if (action !== '') return writeError(404, 'not_found', '品牌包接口路径不存在');

  if (request.method === 'GET') {
    const kit = brandkit.getBrandKit(dir, id);
    if (!kit) return writeError(404, 'not_found', `找不到品牌包：${id}`);
    return writeJSON(200, kitResponse(kit));
  }
  if (request.method === 'DELETE') {
    try {
      brandkit.deleteBrandKit(dir, id);
      return writeJSON(200, goMap({ deleted_id: id }));
    } catch (err) {
      return writeError(404, 'not_found', (err as Error).message);
    }
  }
  return methodNotAllowed('GET, DELETE');
}
