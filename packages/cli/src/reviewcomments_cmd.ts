/**
 * 多形态矢量审片批注操作（review_comments_list / add / update / delete）。
 */
import * as rc from '@onset/engine/reviewcomments';
import { defineGroup } from './ops/cli';
import { num, projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['review-comments'],
  summary: '项目审片批注与批量返修清单',
  description: '读写项目的审片批注（支持画笔、矩形、椭圆、箭头与文字标签归一化标绘、过期检测与乐观锁状态闭环）。',
});

defineOp({
  name: 'review_comments_list',
  cli: ['review-comments', 'list'],
  summary: '列出项目审片批注及每条相对当前源码的过期状态',
  description: '读取 production/studio/review-comments.json 中的审片批注，可按状态（open/resolved）或镜头编号过滤。',
  examples: ['review_comments_list({"project_root": ".", "status": "open"})'],
  params: {
    project_root: projectRoot,
    status: { type: 'string', description: '状态过滤：open 或 resolved，留空返回全部' },
    scene_id: { type: 'string', description: '只看指定镜头的批注' },
  },
  run: async (p, { out }) => {
    const root = str(p.project_root) || '.';
    const statusRaw = str(p.status);
    const status = statusRaw === 'open' || statusRaw === 'resolved' ? statusRaw : undefined;
    const list = rc.listComments(root, { status, scene_id: str(p.scene_id) || undefined });
    for (const c of list) {
      out.write(
        `- [${c.status}${c.stale ? '·已过期' : ''}] ${c.id} (rev=${c.revision}) ${c.anchor.scene_id || c.anchor.target}: ${c.text}\n`,
      );
    }
    out.write(`共 ${list.length} 条批注。\n`);
    return { data: { count: list.length, comments: list } };
  },
});

defineOp({
  name: 'review_comments_add',
  cli: ['review-comments', 'add'],
  summary: '新增一条带时间点/元素/归一化矢量标绘的审片批注',
  description: '创建一条审片批注；支持 request_id 幂等回执与 expected_source_revision 防过期检查。',
  examples: [
    'review_comments_add({"project_root": ".", "scope": "frame", "target": "scenes/scene-001/scene.mp4", "scene_id": "scene-001", "time_seconds": 2.4, "text": "标题偏右"})',
  ],
  params: {
    project_root: projectRoot,
    scope: { type: 'string', description: '作用域：project / frame / element', required: true },
    target: { type: 'string', description: '项目内目标文件路径', required: true },
    scene_id: { type: 'string', description: '关联镜头 ID（可选）' },
    time_seconds: { type: 'number', description: '时间点（秒，frame/element 必填）' },
    text: { type: 'string', description: '批注正文', required: true },
    annotation_json: { type: 'string', description: '可选：归一化矢量标绘 JSON（ReviewAnnotation）' },
    element_json: { type: 'string', description: '可选：DOM 元素锚点 JSON（ReviewElementRef）' },
    request_id: { type: 'string', description: '可选：稳定幂等键' },
    expected_source_revision: { type: 'string', description: '可选：期望的目标源码摘要' },
  },
  run: async (p, { out }) => {
    const root = str(p.project_root) || '.';
    const scope = str(p.scope) as 'project' | 'frame' | 'element';
    const anchor: rc.ReviewAnchor = {
      scope,
      target: str(p.target),
      scene_id: str(p.scene_id) || undefined,
      time_seconds: scope === 'project' ? undefined : num(p.time_seconds),
      annotation: str(p.annotation_json) ? (JSON.parse(str(p.annotation_json)) as rc.ReviewAnnotation) : undefined,
      element: str(p.element_json) ? (JSON.parse(str(p.element_json)) as rc.ReviewElementRef) : undefined,
    };
    const res = rc.createComment(root, {
      request_id: str(p.request_id) || undefined,
      text: str(p.text),
      anchor,
      expected_source_revision: str(p.expected_source_revision) || undefined,
    });
    out.write(`已记录批注 ${res.comment.id}（rev=${res.comment.revision}${res.replayed ? '，幂等重放' : ''}）\n`);
    return { data: res };
  },
});

defineOp({
  name: 'review_comments_update',
  cli: ['review-comments', 'update'],
  summary: '更新批注正文或状态（修完验证后标记 resolved）',
  description: '带 expected_revision 乐观锁更新批注状态（open/resolved）或正文。',
  examples: [
    'review_comments_update({"project_root": ".", "id": "<comment-id>", "expected_revision": 1, "status": "resolved"})',
  ],
  params: {
    project_root: projectRoot,
    id: { type: 'string', description: '批注 ID', required: true, positional: 0 },
    expected_revision: { type: 'integer', description: '当前版本号（乐观锁）', required: true },
    status: { type: 'string', description: '新状态：open 或 resolved' },
    text: { type: 'string', description: '新正文（可选）' },
    request_id: { type: 'string', description: '可选：稳定幂等键' },
  },
  run: async (p, { out }) => {
    const root = str(p.project_root) || '.';
    const statusRaw = str(p.status);
    const res = rc.updateComment(root, {
      id: str(p.id),
      expected_revision: Math.trunc(num(p.expected_revision)),
      status: statusRaw === 'open' || statusRaw === 'resolved' ? statusRaw : undefined,
      text: str(p.text) || undefined,
      request_id: str(p.request_id) || undefined,
    });
    out.write(`已更新批注 ${res.comment.id} → ${res.comment.status}（rev=${res.comment.revision}）\n`);
    return { data: res };
  },
});

defineOp({
  name: 'review_comments_delete',
  cli: ['review-comments', 'delete'],
  summary: '删除一条审片批注',
  description: '带 expected_revision 乐观锁删除审片批注。',
  examples: ['review_comments_delete({"project_root": ".", "id": "<comment-id>", "expected_revision": 1})'],
  params: {
    project_root: projectRoot,
    id: { type: 'string', description: '批注 ID', required: true, positional: 0 },
    expected_revision: { type: 'integer', description: '当前版本号（乐观锁）', required: true },
    request_id: { type: 'string', description: '可选：稳定幂等键' },
  },
  run: async (p, { out }) => {
    const root = str(p.project_root) || '.';
    const res = rc.deleteComment(root, {
      id: str(p.id),
      expected_revision: Math.trunc(num(p.expected_revision)),
      request_id: str(p.request_id) || undefined,
    });
    out.write(`已删除批注 ${res.deleted_id}\n`);
    return { data: res };
  },
});
