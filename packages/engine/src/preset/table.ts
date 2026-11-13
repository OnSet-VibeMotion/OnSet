// 画幅表。
import { AnchorBottom, AnchorFill, AnchorTop, type Box, type Platform, type Preset, type ResolvedBox } from './preset';

/**
 * 两套竖屏预设共用的 anchor 声明。
 *
 * 共用是设计意图而非巧合：1080×1440 与 1080×1920 宽度相同，字幕带（190px 高）与封面标题块（720px 高）
 * 保持同样的贴底/贴顶边距，多出的 480px 全部归给 main_content 的可用垂直空间。新增竖屏画幅不应复制这张表。
 */
function baseSafeArea(): Box[] {
  return [
    { name: 'structural', leftPx: 40, rightPx: 40, anchor: AnchorFill, insetTopPx: 96, insetBottomPx: 60 },
    { name: 'main_content', leftPx: 88, rightPx: 88, anchor: AnchorFill, insetTopPx: 120, insetBottomPx: 100 },
    { name: 'critical_text', leftPx: 88, rightPx: 180, anchor: AnchorFill, insetTopPx: 120, insetBottomPx: 260 },
    { name: 'cover_title', leftPx: 88, rightPx: 180, anchor: AnchorTop, insetTopPx: 260, heightPx: 720 },
    { name: 'subtitles', leftPx: 88, rightPx: 180, anchor: AnchorBottom, insetBottomPx: 260, heightPx: 190 },
  ];
}

/** 两套竖屏画幅共用的平台措辞：面向抖音等竖屏平台，右侧互动栏与底部 UI 是关键避让区。 */
function verticalPlatform(): Platform {
  return {
    orientation: '竖屏',
    ui: '抖音右侧互动栏和底部 UI',
    zone: '右侧互动栏和底部 UI',
    avoidance: (critical: ResolvedBox) => `右侧 ${critical.rightPx}px 和底部 ${critical.bottomPx}px 是抖音互动栏与底部 UI`,
  };
}

/**
 * 16:9 横屏的安全区。横屏平台（B 站、YouTube、西瓜）没有右侧互动栏，需要让开的是底部的播放器控制栏、
 * 进度条与弹幕输入区，所以左右对称内缩、底部留得最深。字幕带贴在进度条上方；封面标题块贴顶，留出下方给主视觉。
 */
function landscapeSafeArea(): Box[] {
  return [
    { name: 'structural', leftPx: 48, rightPx: 48, anchor: AnchorFill, insetTopPx: 40, insetBottomPx: 40 },
    { name: 'main_content', leftPx: 120, rightPx: 120, anchor: AnchorFill, insetTopPx: 80, insetBottomPx: 96 },
    { name: 'critical_text', leftPx: 160, rightPx: 160, anchor: AnchorFill, insetTopPx: 96, insetBottomPx: 200 },
    { name: 'cover_title', leftPx: 160, rightPx: 160, anchor: AnchorTop, insetTopPx: 220, heightPx: 520 },
    { name: 'subtitles', leftPx: 240, rightPx: 240, anchor: AnchorBottom, insetBottomPx: 90, heightPx: 150 },
  ];
}

function landscapePlatform(): Platform {
  return {
    orientation: '横屏',
    ui: '播放器底部控制栏与进度条',
    zone: '底部控制栏与进度条',
    avoidance: (critical: ResolvedBox) => `底部 ${critical.bottomPx}px 是播放器控制栏、进度条与弹幕输入区`,
  };
}

/**
 * 横屏与竖屏构图的差异。竖屏习惯的「上下堆叠」照搬到横屏，会在两侧留出大片空白、中间挤成一条窄栏。
 */
const landscapeLayoutNotes = `

## 横屏构图要点

本项目是 16:9 横屏（1920×1080），画面的主方向是左右而不是上下。竖屏习惯的版式落到横屏时按下面的原则改排：

- 左右分栏优先于上下堆叠：命题型用「左文右图」或「左大字、右主视觉」；对照型直接左右对开；流程型沿水平方向展开，最多 5 步，超过就分两行；系统总览用横向网格。
- 不要把竖屏版式原样居中：中间一条窄栏、两侧大面积空白，是横屏最常见的「没排完」。
- 一行文字不超过 22 个汉字：横屏宽度大，单行过长会让视线来回扫，宁可断行。
- 标题字号以画面高度 1080px 为基准，与竖屏的同级字号保持一致，不因为画面变宽而放大。
- 底部控制栏与进度条是关键避让区：标题、数字、结论和字幕都不得进入 critical_text 下沿以下的区域；字幕带贴在进度条上方。
`;

/** 顺序即 am init 选择框里的展示顺序，第一项是默认值。 */
const builtin: Preset[] = [
  {
    id: 'vertical-3x4',
    label: '3:4  竖屏  1080×1440',
    canvas: { widthPx: 1080, heightPx: 1440, fps: 30, orientation: 'vertical' },
    safeArea: baseSafeArea(),
    platform: verticalPlatform(),
    layoutNotes: '',
  },
  {
    id: 'vertical-9x16',
    label: '9:16 竖屏  1080×1920',
    canvas: { widthPx: 1080, heightPx: 1920, fps: 30, orientation: 'vertical' },
    safeArea: baseSafeArea(),
    platform: verticalPlatform(),
    layoutNotes: '',
  },
  {
    id: 'landscape-16x9',
    label: '16:9 横屏  1920×1080',
    canvas: { widthPx: 1920, heightPx: 1080, fps: 30, orientation: 'landscape' },
    safeArea: landscapeSafeArea(),
    platform: landscapePlatform(),
    layoutNotes: landscapeLayoutNotes,
  },
];

const clone = (p: Preset): Preset => ({ ...p, canvas: { ...p.canvas }, safeArea: p.safeArea.map((b) => ({ ...b })) });

/** 全部内置画幅的副本：调用方改动不影响内置表。 */
export function all(): Preset[] {
  return builtin.map(clone);
}

export function defaultPreset(): Preset {
  return clone(builtin[0]);
}

export function ids(): string[] {
  return builtin.map((p) => p.id);
}

export function byID(id: string): Preset | undefined {
  const p = builtin.find((item) => item.id === id);
  return p && clone(p);
}

/** 供 validate 从 frame.md 的 canvas 反查预设。 */
export function byCanvas(width: number, height: number, fps: number, orientation: string): Preset | undefined {
  const p = builtin.find((item) => {
    const c = item.canvas;
    return c.widthPx === width && c.heightPx === height && c.fps === fps && c.orientation === orientation;
  });
  return p && clone(p);
}
