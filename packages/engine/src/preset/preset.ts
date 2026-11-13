/**
 * 画幅预设的唯一真相源。移植自 internal/preset/preset.go。
 *
 * 安全区在这里用 anchor 语义声明，由预设生成器在构建期推导成绝对像素写进 frame.md。
 * anchor 不进项目文件：渲染工具读到的始终是现成像素值，无需自行运算。
 */

export type Anchor = 'top' | 'bottom' | 'fill';

/** 贴顶：距顶固定，高度固定，底部随画布高度浮动。 */
export const AnchorTop: Anchor = 'top';
/** 贴底：距底固定，高度固定，顶部随画布高度浮动。 */
export const AnchorBottom: Anchor = 'bottom';
/** 上下都固定边距，高度随画布吸收剩余空间。 */
export const AnchorFill: Anchor = 'fill';

export interface Canvas {
  widthPx: number;
  heightPx: number;
  fps: number;
  orientation: string;
}

/** 人类可读画幅，使用全角乘号，与文档正文里的写法一致。 */
export function canvasLabel(c: Pick<Canvas, 'widthPx' | 'heightPx'>): string {
  return `${c.widthPx}×${c.heightPx}`;
}

export interface Box {
  name: string;
  leftPx: number;
  rightPx: number;
  anchor: Anchor | string;
  /** AnchorTop / AnchorFill */
  insetTopPx?: number;
  /** AnchorBottom / AnchorFill */
  insetBottomPx?: number;
  /** AnchorTop / AnchorBottom */
  heightPx?: number;
}

/** 与 frame.md 一致的四边内缩表示，不是坐标。 */
export interface ResolvedBox {
  leftPx: number;
  rightPx: number;
  topPx: number;
  bottomPx: number;
}

export function resolveBox(b: Box, canvasHeight: number): ResolvedBox {
  const out: ResolvedBox = { leftPx: b.leftPx, rightPx: b.rightPx, topPx: 0, bottomPx: 0 };
  const top = b.insetTopPx ?? 0;
  const bottom = b.insetBottomPx ?? 0;
  const height = b.heightPx ?? 0;
  switch (b.anchor) {
    case AnchorTop:
      out.topPx = top;
      out.bottomPx = canvasHeight - top - height;
      break;
    case AnchorBottom:
      out.bottomPx = bottom;
      out.topPx = canvasHeight - bottom - height;
      break;
    case AnchorFill:
      out.topPx = top;
      out.bottomPx = bottom;
      break;
    default:
      throw new Error(`安全区 ${b.name} 的 anchor 无效：${b.anchor}`);
  }
  if (out.topPx < 0 || out.bottomPx < 0 || out.topPx + out.bottomPx >= canvasHeight) {
    throw new Error(`安全区 ${b.name} 在 ${canvasHeight}px 画布高度下无效：top=${out.topPx} bottom=${out.bottomPx}`);
  }
  return out;
}

export interface NamedBox {
  name: string;
  box: ResolvedBox;
}

/** 画幅相关的平台措辞，对应模板占位符。 */
export interface Platform {
  /** 填 {{ORIENTATION}}：竖屏 / 横屏。 */
  orientation: string;
  /** 填 {{PLATFORM_UI}}：需要主动避让的平台界面的完整说法。 */
  ui: string;
  /** 填 {{UI_ZONE}}：避让区的简称。 */
  zone: string;
  /** 生成 {{AVOIDANCE_ZONES}}：关键避让区的位置与来源，像素取自已推导的 critical_text 安全区。 */
  avoidance: (critical: ResolvedBox) => string;
}

export interface Preset {
  id: string;
  label: string;
  canvas: Canvas;
  safeArea: Box[];
  /** 这个画幅面向的平台界面，风格模板里与平台有关的措辞由它填入。 */
  platform: Platform;
  /** 追加在 frame.md 与风格说明书正文末尾的画幅构图要点；为空时不追加。 */
  layoutNotes: string;
}

/** 按声明顺序推导全部安全区，顺序与 frame.md 字段顺序一致。 */
export function resolveSafeArea(p: Preset): NamedBox[] {
  return p.safeArea.map((box) => {
    try {
      return { name: box.name, box: resolveBox(box, p.canvas.heightPx) };
    } catch (err) {
      throw new Error(`预设 ${p.id}：${(err as Error).message}`);
    }
  });
}
