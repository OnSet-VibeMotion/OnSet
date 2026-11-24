import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeSourceRevision,
  createComment,
  deleteComment,
  formatBatchRepairPrompt,
  listComments,
  updateComment,
} from './index';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-reviewcomments-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('reviewcomments', () => {
  it('creates, updates, resolves, detects staleness, enforces optimistic locks and formats batch prompt', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'scenes', 'scene-001'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scenes', 'scene-001', 'index.html'), '<div>v1</div>');

    const rev1 = computeSourceRevision(root, 'scenes/scene-001/scene.mp4', 'scene-001');
    const created = createComment(root, {
      request_id: 'req-1',
      text: '右上角数字与图标重叠，往左移 24px',
      expected_source_revision: rev1,
      anchor: {
        scope: 'frame',
        target: 'scenes/scene-001/scene.mp4',
        scene_id: 'scene-001',
        time_seconds: 2.5,
        annotation: {
          version: 1,
          coordinate_space: 'normalized',
          width: 1080,
          height: 1440,
          marks: [
            {
              kind: 'arrow',
              points: [
                { x: 0.7, y: 0.2 },
                { x: 0.85, y: 0.15 },
              ],
            },
            { kind: 'text', points: [{ x: 0.7, y: 0.22 }], text: '太挤' },
          ],
        },
      },
    });
    expect(created.replayed).toBe(false);
    expect(created.comment.stale).toBe(false);

    // 幂等重放返回同一条评论
    const replay = createComment(root, {
      request_id: 'req-1',
      text: '右上角数字与图标重叠，往左移 24px',
      expected_source_revision: rev1,
      anchor: created.comment.anchor,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.comment.id).toBe(created.comment.id);

    // 批量返修提示词包含坐标像素换算与 ID
    const prompt = formatBatchRepairPrompt([created.comment]);
    expect(prompt).toContain(created.comment.id);
    expect(prompt).toContain('scene-001');
    expect(prompt).toContain('太挤');
    expect(prompt).not.toMatch(/\bagent\b/i);

    // 修改镜头源码后，自动标出 stale
    fs.writeFileSync(path.join(root, 'scenes', 'scene-001', 'index.html'), '<div>v2</div>');
    const listed = listComments(root);
    expect(listed[0].stale).toBe(true);

    // 乐观锁：旧版本号拒绝更新，正确版本号成功标记 resolved
    expect(() => updateComment(root, { id: created.comment.id, expected_revision: 99, status: 'resolved' })).toThrow(
      /COMMENT_CONFLICT/,
    );
    const resolved = updateComment(root, { id: created.comment.id, expected_revision: 1, status: 'resolved' });
    expect(resolved.comment.status).toBe('resolved');
    expect(resolved.comment.revision).toBe(2);

    // 删除
    const del = deleteComment(root, { id: created.comment.id, expected_revision: 2 });
    expect(del.deleted_id).toBe(created.comment.id);
    expect(listComments(root)).toHaveLength(0);
  });

  it('rejects out-of-range coordinates and mismatched scope fields', () => {
    const root = tempDir();
    expect(() =>
      createComment(root, {
        text: 'bad',
        anchor: {
          scope: 'frame',
          target: 'final.mp4',
          time_seconds: 1,
          annotation: {
            version: 1,
            coordinate_space: 'normalized',
            width: 1920,
            height: 1080,
            marks: [
              {
                kind: 'rectangle',
                points: [
                  { x: 1.5, y: 0.2 },
                  { x: 0.5, y: 0.5 },
                ],
              },
            ],
          },
        },
      }),
    ).toThrow(/\[0, 1\]/);
  });
});
