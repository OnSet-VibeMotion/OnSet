import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { formatFixed } from '../gofmt';
import { marshalIndent } from '../gojson';
import {
  type ReviewAnchor,
  type ReviewComment,
  ReviewCommentLimit,
  type ReviewCommentStatus,
  validateReviewAnchor,
} from './types';

interface Receipt {
  hash: string;
  comment_id?: string;
  deleted_id?: string;
}

interface CommentsState {
  schema: 1;
  comments: ReviewComment[];
  receipts: Record<string, Receipt>;
}

export interface CreateCommentInput {
  request_id?: string;
  text: string;
  anchor: ReviewAnchor;
  expected_source_revision?: string;
}

export interface UpdateCommentInput {
  id: string;
  request_id?: string;
  expected_revision: number;
  text?: string;
  status?: ReviewCommentStatus;
}

export interface DeleteCommentInput {
  id: string;
  request_id?: string;
  expected_revision: number;
}

export interface CommentView extends ReviewComment {
  /** 当前目标文件的源码/媒体指纹已变化，说明旧画布标绘或元素坐标可能已过期。 */
  stale: boolean;
  current_source_revision: string;
}

export const CommentsRelPath = path.join('production', 'studio', 'review-comments.json');

function commentsFile(projectRoot: string): string {
  return path.join(projectRoot, CommentsRelPath);
}

function loadState(projectRoot: string): CommentsState {
  const file = commentsFile(projectRoot);
  if (!fs.existsSync(file)) return { schema: 1, comments: [], receipts: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CommentsState>;
  return {
    schema: 1,
    comments: Array.isArray(raw.comments) ? raw.comments : [],
    receipts: raw.receipts && typeof raw.receipts === 'object' ? raw.receipts : {},
  };
}

function saveState(projectRoot: string, state: CommentsState): void {
  atomicWrite(commentsFile(projectRoot), marshalIndent(state) + '\n', 0o644);
}

function canonicalHash(value: unknown): string {
  const text = JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * 为锚定目标计算轻量内容指纹（用于检测画布标绘和元素坐标是否过期）。
 * - 镜头目标：覆盖该镜头目录的 index.html、scene.json、onset-edits.json 与 scene.mp4 stat；
 * - 整片/其他文件：覆盖目标文件 stat（小文件含 sha256）及 production/scene-plan.json。
 */
export function computeSourceRevision(projectRoot: string, target: string, sceneId?: string): string {
  const hash = crypto.createHash('sha256');
  const feed = (rel: string): void => {
    const abs = path.resolve(projectRoot, rel);
    const root = path.resolve(projectRoot);
    if (abs !== root && !abs.startsWith(root + path.sep)) return;
    hash.update(rel + '\0');
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st || !st.isFile()) {
      hash.update('missing\0');
      return;
    }
    if (st.size <= 512 * 1024) {
      hash.update(fs.readFileSync(abs));
    } else {
      hash.update(`${st.size}:${Math.trunc(st.mtimeMs)}`);
    }
    hash.update('\0');
  };

  const normalized = target.replace(/\\/g, '/');
  const sceneMatch = sceneId || normalized.match(/^scenes\/([^/]+)\//)?.[1];
  if (sceneMatch) {
    feed(`scenes/${sceneMatch}/index.html`);
    feed(`scenes/${sceneMatch}/scene.json`);
    feed(`scenes/${sceneMatch}/onset-edits.json`);
    feed(`scenes/${sceneMatch}/scene.mp4`);
  } else {
    feed(normalized);
    feed('production/scene-plan.json');
  }
  return hash.digest('hex').slice(0, 16);
}

/** 列出项目全部批注（并标注每条相对当前源码是否已过期）。 */
export function listComments(
  projectRoot: string,
  filter: { status?: ReviewCommentStatus; scene_id?: string } = {},
): CommentView[] {
  const state = loadState(projectRoot);
  const out: CommentView[] = [];
  for (const c of state.comments) {
    if (filter.status && c.status !== filter.status) continue;
    if (filter.scene_id && c.anchor.scene_id !== filter.scene_id) continue;
    const current = computeSourceRevision(projectRoot, c.anchor.target, c.anchor.scene_id);
    out.push({
      ...c,
      current_source_revision: current,
      stale: current !== c.source_revision,
    });
  }
  return out;
}

/** 新增一条审片批注（支持 request_id 幂等回执与 expected_source_revision 冲突保护）。 */
export function createComment(
  projectRoot: string,
  input: CreateCommentInput,
): { comment: CommentView; replayed: boolean } {
  const text = (input.text ?? '').trim();
  if (!text || text.length > 8000) throw new Error('批注正文长度必须在 1–8000 字符内');
  validateReviewAnchor(input.anchor);

  const state = loadState(projectRoot);
  const payloadHash = canonicalHash({
    op: 'create',
    text,
    anchor: input.anchor,
    expected: input.expected_source_revision,
  });
  if (input.request_id) {
    const prev = state.receipts[input.request_id];
    if (prev) {
      if (prev.hash !== payloadHash) throw new Error('REQUEST_ID_CONFLICT：同一 request_id 不能用于不同内容的批注操作');
      const existing = state.comments.find((c) => c.id === prev.comment_id);
      if (existing) {
        const cur = computeSourceRevision(projectRoot, existing.anchor.target, existing.anchor.scene_id);
        return {
          comment: { ...existing, current_source_revision: cur, stale: cur !== existing.source_revision },
          replayed: true,
        };
      }
    }
  }

  const currentRev = computeSourceRevision(projectRoot, input.anchor.target, input.anchor.scene_id);
  if (input.expected_source_revision && input.expected_source_revision !== currentRev) {
    throw new Error('VERSION_CONFLICT：画面或源码已变更，请刷新当前帧后重新捕获批注');
  }
  if (state.comments.length >= ReviewCommentLimit) {
    throw new Error(`批注数量已达上限（${ReviewCommentLimit}），请先清理旧批注`);
  }

  const now = new Date().toISOString();
  const comment: ReviewComment = {
    id: crypto.randomUUID(),
    revision: 1,
    text,
    status: 'open',
    anchor: structuredClone(input.anchor),
    source_revision: currentRev,
    created_at: now,
    updated_at: now,
  };
  state.comments.push(comment);
  if (input.request_id) state.receipts[input.request_id] = { hash: payloadHash, comment_id: comment.id };
  saveState(projectRoot, state);
  return { comment: { ...comment, current_source_revision: currentRev, stale: false }, replayed: false };
}

/** 更新批注正文或状态（open / resolved），强制校验 expected_revision 乐观锁。 */
export function updateComment(
  projectRoot: string,
  input: UpdateCommentInput,
): { comment: CommentView; replayed: boolean } {
  if (!input.id) throw new Error('缺少批注 id');
  if (input.text === undefined && input.status === undefined) throw new Error('必须提供 text 或 status 至少一项');
  if (input.status !== undefined && input.status !== 'open' && input.status !== 'resolved') {
    throw new Error(`未知批注状态：${String(input.status)}`);
  }
  const cleanText = input.text !== undefined ? input.text.trim() : undefined;
  if (cleanText !== undefined && (!cleanText || cleanText.length > 8000)) {
    throw new Error('批注正文长度必须在 1–8000 字符内');
  }

  const state = loadState(projectRoot);
  const payloadHash = canonicalHash({
    op: 'update',
    id: input.id,
    text: cleanText,
    status: input.status,
    rev: input.expected_revision,
  });
  if (input.request_id) {
    const prev = state.receipts[input.request_id];
    if (prev) {
      if (prev.hash !== payloadHash) throw new Error('REQUEST_ID_CONFLICT：同一 request_id 不能用于不同内容的批注操作');
      const existing = state.comments.find((c) => c.id === prev.comment_id);
      if (existing) {
        const cur = computeSourceRevision(projectRoot, existing.anchor.target, existing.anchor.scene_id);
        return {
          comment: { ...existing, current_source_revision: cur, stale: cur !== existing.source_revision },
          replayed: true,
        };
      }
    }
  }

  const idx = state.comments.findIndex((c) => c.id === input.id);
  if (idx < 0) throw new Error(`找不到批注：${input.id}`);
  const before = state.comments[idx];
  if (before.revision !== input.expected_revision) {
    throw new Error(
      `COMMENT_CONFLICT：批注版本已更新（当前 ${before.revision}，期望 ${input.expected_revision}），请重新读取`,
    );
  }

  const updated: ReviewComment = {
    ...before,
    text: cleanText ?? before.text,
    status: input.status ?? before.status,
    revision: before.revision + 1,
    updated_at: new Date().toISOString(),
  };
  state.comments[idx] = updated;
  if (input.request_id) state.receipts[input.request_id] = { hash: payloadHash, comment_id: updated.id };
  saveState(projectRoot, state);

  const cur = computeSourceRevision(projectRoot, updated.anchor.target, updated.anchor.scene_id);
  return {
    comment: { ...updated, current_source_revision: cur, stale: cur !== updated.source_revision },
    replayed: false,
  };
}

/** 删除批注（校验 expected_revision 乐观锁）。 */
export function deleteComment(
  projectRoot: string,
  input: DeleteCommentInput,
): { deleted_id: string; replayed: boolean } {
  const state = loadState(projectRoot);
  const payloadHash = canonicalHash({ op: 'delete', id: input.id, rev: input.expected_revision });
  if (input.request_id) {
    const prev = state.receipts[input.request_id];
    if (prev) {
      if (prev.hash !== payloadHash) throw new Error('REQUEST_ID_CONFLICT：同一 request_id 不能用于不同内容的批注操作');
      return { deleted_id: prev.deleted_id ?? input.id, replayed: true };
    }
  }

  const idx = state.comments.findIndex((c) => c.id === input.id);
  if (idx < 0) throw new Error(`找不到批注：${input.id}`);
  const before = state.comments[idx];
  if (before.revision !== input.expected_revision) {
    throw new Error(`COMMENT_CONFLICT：批注版本已更新（当前 ${before.revision}，期望 ${input.expected_revision}）`);
  }

  state.comments.splice(idx, 1);
  if (input.request_id) state.receipts[input.request_id] = { hash: payloadHash, deleted_id: before.id };
  saveState(projectRoot, state);
  return { deleted_id: before.id, replayed: false };
}

/**
 * 将选中的多条待处理批注按镜头/目标分组，拼成可直接发给片场编排对话的批量返修指令。
 */
export function formatBatchRepairPrompt(comments: readonly ReviewComment[]): string {
  const open = comments.filter((c) => c.status === 'open');
  if (open.length === 0) return '';
  const lines: string[] = [
    `请按以下 ${open.length} 条审片批注批量返修对应镜头/画面，只修改批注指出的问题，其余已确认内容保持不变。`,
    '每修完并验证一条后，调用 review_comments_update 将该批注状态标记为 resolved（携带其当前 revision）。',
    '',
  ];
  for (let i = 0; i < open.length; i++) {
    const c = open[i];
    const where = [
      c.anchor.scene_id ? `镜头 ${c.anchor.scene_id}` : c.anchor.target,
      c.anchor.time_seconds !== undefined ? `@ ${formatFixed(c.anchor.time_seconds, 2)}s` : '',
      c.anchor.element ? `元素 ${c.anchor.element.selector}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`${i + 1}. [${c.id} rev=${c.revision}] ${where}`);
    lines.push(`   意见：${c.text}`);
    if (c.anchor.annotation && c.anchor.annotation.marks.length > 0) {
      const { width, height, marks } = c.anchor.annotation;
      const summary = marks.map((m) => {
        const pts = m.points.map((pt) => `(${Math.round(pt.x * width)},${Math.round(pt.y * height)})`).join('->');
        return m.kind === 'text' ? `标注文字「${m.text}」@${pts}` : `${m.kind}[${pts}]`;
      });
      lines.push(`   画布标绘（${width}×${height} 像素换算）：${summary.join('；')}`);
    }
  }
  return lines.join('\n');
}
