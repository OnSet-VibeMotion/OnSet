/**
 * 多形态矢量审片批注（Review Comments）数据结构与严格校验。
 *
 * 批注保存在项目的 production/studio/review-comments.json，不改写镜头源码；
 * 画面标绘统一采用 [0, 1] 归一化坐标并记录原画布尺寸，支持画笔、矩形、椭圆、箭头与文字标签。
 */
export interface ReviewPoint {
  x: number;
  y: number;
}

export type ReviewMarkKind = 'pen' | 'rectangle' | 'ellipse' | 'arrow' | 'text';

export interface ReviewMark {
  kind: ReviewMarkKind;
  points: ReviewPoint[];
  text?: string;
}

export interface ReviewAnnotation {
  version: 1;
  coordinate_space: 'normalized';
  width: number;
  height: number;
  marks: ReviewMark[];
}

export interface ReviewElementRef {
  selector: string;
  source_file: string;
  tag_name: string;
  label?: string;
  text?: string;
  box?: { x: number; y: number; width: number; height: number };
}

export interface ReviewAnchor {
  scope: 'project' | 'frame' | 'element';
  /** 锚定对象路径，例如 scenes/scene-001/scene.mp4、scenes/scene-001/index.html 或 final.mp4。 */
  target: string;
  scene_id?: string;
  time_seconds?: number;
  annotation?: ReviewAnnotation;
  element?: ReviewElementRef;
}

export type ReviewCommentStatus = 'open' | 'resolved';

export interface ReviewComment {
  id: string;
  revision: number;
  text: string;
  status: ReviewCommentStatus;
  anchor: ReviewAnchor;
  /** 批注捕获时锚定对象的摘要，项目改动后用于检测旧标绘是否已过期。 */
  source_revision: string;
  created_at: string;
  updated_at: string;
}

export const ReviewMarkLimit = 20;
export const ReviewPointLimit = 2048;
export const ReviewCommentLimit = 2000;

const AllowedMarkKinds = new Set<string>(['pen', 'rectangle', 'ellipse', 'arrow', 'text']);

export function validateReviewAnnotation(ann: ReviewAnnotation): void {
  if (!ann || typeof ann !== 'object') throw new Error('无效的画面标绘');
  if (ann.version !== 1 || ann.coordinate_space !== 'normalized') {
    throw new Error('画面标绘仅支持 version=1 且 coordinate_space="normalized"');
  }
  if (
    !Number.isFinite(ann.width) ||
    ann.width <= 0 ||
    ann.width > 16384 ||
    !Number.isFinite(ann.height) ||
    ann.height <= 0 ||
    ann.height > 16384
  ) {
    throw new Error('画面标绘宽高必须是 (0, 16384] 范围内的有限数字');
  }
  if (!Array.isArray(ann.marks) || ann.marks.length === 0 || ann.marks.length > ReviewMarkLimit) {
    throw new Error(`画面标绘图元数必须在 1–${ReviewMarkLimit} 之间`);
  }
  let totalPoints = 0;
  for (const mark of ann.marks) {
    if (!mark || !AllowedMarkKinds.has(mark.kind) || !Array.isArray(mark.points)) {
      throw new Error('包含不支持的标绘图元类型');
    }
    const n = mark.points.length;
    if (mark.kind === 'text') {
      if (n !== 1 || typeof mark.text !== 'string' || mark.text.trim() === '' || mark.text.length > 160) {
        throw new Error('文字标签图元必须含 1 个锚点且文字长度在 1–160 字符内');
      }
    } else {
      if (mark.text !== undefined) throw new Error(`${mark.kind} 图元不允许附带 text 字段`);
      if (mark.kind === 'pen' ? n < 2 || n > 1000 : n !== 2) {
        throw new Error(`${mark.kind} 图元点数不合法（当前 ${n}）`);
      }
    }
    for (const pt of mark.points) {
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y) || pt.x < 0 || pt.x > 1 || pt.y < 0 || pt.y > 1) {
        throw new Error('画面标绘坐标必须在 [0, 1] 归一化区间内');
      }
    }
    totalPoints += n;
  }
  if (totalPoints > ReviewPointLimit) {
    throw new Error(`画面标绘总点数超过上限（${ReviewPointLimit}）`);
  }
}

export function validateReviewAnchor(anchor: ReviewAnchor): void {
  if (!anchor || typeof anchor !== 'object') throw new Error('缺少批注锚点');
  if (anchor.scope !== 'project' && anchor.scope !== 'frame' && anchor.scope !== 'element') {
    throw new Error(`未知批注作用域：${String((anchor as { scope?: unknown }).scope)}`);
  }
  if (
    typeof anchor.target !== 'string' ||
    anchor.target.trim() === '' ||
    anchor.target.includes('..') ||
    anchor.target.startsWith('/')
  ) {
    throw new Error(`非法批注目标路径：${String(anchor.target)}`);
  }
  if (anchor.scope === 'project') {
    if (anchor.time_seconds !== undefined || anchor.element !== undefined || anchor.annotation !== undefined) {
      throw new Error('整片级（project）批注不能携带帧时间、元素或画布标绘');
    }
  } else {
    if (
      anchor.time_seconds === undefined ||
      !Number.isFinite(anchor.time_seconds) ||
      anchor.time_seconds < 0 ||
      anchor.time_seconds > 86400
    ) {
      throw new Error('帧级或元素级批注必须提供有效时间点（time_seconds）');
    }
  }
  if (anchor.scope === 'element') {
    if (
      !anchor.element ||
      !anchor.element.selector?.trim() ||
      !anchor.element.source_file?.trim() ||
      !anchor.element.tag_name?.trim()
    ) {
      throw new Error('元素级批注必须提供完整的 element（selector / source_file / tag_name）');
    }
  } else if (anchor.element !== undefined) {
    throw new Error('仅元素级批注允许携带 element 字段');
  }
  if (anchor.annotation !== undefined) {
    validateReviewAnnotation(anchor.annotation);
  }
}
