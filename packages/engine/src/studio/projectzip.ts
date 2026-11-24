/**
 * 离线便携工程 ZIP 归档的 Studio 后端接口：/api/project-zip/export 与 /api/project-zip/import。
 */
import path from 'node:path';
import * as projectzip from '../projectzip';
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

export async function projectZipAPI(s: Server, request: Request, rest: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  let body: Record<string, unknown>;
  try {
    body = await decodeJSON(request);
  } catch (err) {
    return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
  }

  if (rest === 'export') {
    const p = s.projectOr404();
    if (p instanceof Response) return p;
    const dest = fieldString(body, 'dest') || projectzip.defaultExportZipPath(p.path);
    try {
      const res = projectzip.exportProjectZip(p.path, dest, {
        title: fieldString(body, 'title') || p.name,
        includeRenders: fieldBool(body, 'include_renders'),
      });
      return writeJSON(200, goMap(res as unknown as Record<string, unknown>));
    } catch (err) {
      return writeError(400, 'project_zip_export_failed', (err as Error).message);
    }
  }

  if (rest === 'import') {
    const zipPath = fieldString(body, 'zip');
    const dest = fieldString(body, 'dest');
    if (!zipPath || !dest) return writeError(400, 'invalid_request', '请提供 zip 与 dest 路径');
    try {
      const res = projectzip.importProjectZip(zipPath, path.resolve(dest));
      return writeJSON(201, goMap(res as unknown as Record<string, unknown>));
    } catch (err) {
      return writeError(400, 'project_zip_import_failed', (err as Error).message);
    }
  }

  return writeError(404, 'not_found', '归档接口路径不存在');
}
