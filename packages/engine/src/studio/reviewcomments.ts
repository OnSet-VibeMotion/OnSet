/**
 * 审片批注的 Studio 后端接口：/api/review-comments。
 *
 * 批注保存在项目的 production/studio/review-comments.json（工作区元数据，不修改镜头源码），
 * 与 Studio 对话/事件一样直接读写，无需占用镜头渲染写锁；支持画笔/矩形/椭圆/箭头/文字标绘与批量返修。
 */
import * as rc from '../reviewcomments';
import { DecodeError, decodeJSON, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import type { Server } from './studio';

export async function reviewCommentsAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const p = s.projectOr404();
  if (p instanceof Response) return p;

  // GET /api/review-comments  |  POST /api/review-comments  |  POST /api/review-comments/batch-prompt
  if (rest === '') {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const statusRaw = url.searchParams.get('status') ?? '';
      const status = statusRaw === 'open' || statusRaw === 'resolved' ? statusRaw : undefined;
      const sceneId = url.searchParams.get('scene_id') ?? undefined;
      const comments = rc.listComments(p.path, { status, scene_id: sceneId });
      return writeJSON(200, goMap({ comments }));
    }
    if (request.method !== 'POST') return methodNotAllowed('GET, POST');
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    try {
      const res = rc.createComment(p.path, {
        request_id: fieldString(body, 'request_id') || undefined,
        text: fieldString(body, 'text'),
        anchor: body.anchor as rc.ReviewAnchor,
        expected_source_revision: fieldString(body, 'expected_source_revision') || undefined,
      });
      return writeJSON(201, goMap({ comment: res.comment, replayed: res.replayed }));
    } catch (err) {
      const msg = (err as Error).message;
      const status = msg.startsWith('VERSION_CONFLICT') || msg.startsWith('REQUEST_ID_CONFLICT') ? 409 : 400;
      return writeError(status, 'review_comment_error', msg);
    }
  }

  if (rest === 'batch-prompt') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
    const all = rc.listComments(p.path, { status: 'open' });
    const selected = ids.length > 0 ? all.filter((c) => ids.includes(c.id)) : all;
    const prompt = rc.formatBatchRepairPrompt(selected);
    return writeJSON(200, goMap({ count: selected.length, prompt }));
  }

  if (rest === 'revision') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const url = new URL(request.url);
    const target = url.searchParams.get('target') ?? '';
    const sceneId = url.searchParams.get('scene_id') ?? undefined;
    if (!target) return writeError(400, 'invalid_target', '缺少 target 参数');
    return writeJSON(200, goMap({ source_revision: rc.computeSourceRevision(p.path, target, sceneId) }));
  }

  // PATCH /api/review-comments/{id}  |  DELETE /api/review-comments/{id}
  const id = rest.replace(/^\/+|\/+$/g, '');
  if (!id || id.includes('/')) return writeError(404, 'not_found', '批注接口路径不存在');

  if (request.method === 'PATCH') {
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    const expectedRevision = typeof body.expected_revision === 'number' ? Math.trunc(body.expected_revision) : 0;
    const statusRaw = fieldString(body, 'status');
    try {
      const res = rc.updateComment(p.path, {
        id,
        request_id: fieldString(body, 'request_id') || undefined,
        expected_revision: expectedRevision,
        text: typeof body.text === 'string' ? body.text : undefined,
        status: statusRaw === 'open' || statusRaw === 'resolved' ? statusRaw : undefined,
      });
      return writeJSON(200, goMap({ comment: res.comment, replayed: res.replayed }));
    } catch (err) {
      const msg = (err as Error).message;
      const code =
        msg.startsWith('COMMENT_CONFLICT') || msg.startsWith('REQUEST_ID_CONFLICT')
          ? 409
          : msg.startsWith('找不到')
            ? 404
            : 400;
      return writeError(code, 'review_comment_error', msg);
    }
  }

  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const revParam = Number(url.searchParams.get('expected_revision') ?? '0');
    try {
      const res = rc.deleteComment(p.path, {
        id,
        expected_revision: Math.trunc(revParam),
      });
      return writeJSON(200, goMap({ deleted_id: res.deleted_id, replayed: res.replayed }));
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.startsWith('COMMENT_CONFLICT') ? 409 : msg.startsWith('找不到') ? 404 : 400;
      return writeError(code, 'review_comment_error', msg);
    }
  }

  return methodNotAllowed('PATCH, DELETE');
}
