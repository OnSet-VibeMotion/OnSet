import type { CanvasOption, ModeOption } from '../../types';
import type { HomeMaterial } from '../homeAttachments';

export interface ProjectSummary {
  /** 制作走到了顶栏的哪一步（与顶栏同一个来源）与它的名字；没有流程记录时为空。 */
  stage: string;
  stage_label: string;
  completed: number;
  total: number;
  busy?: string;
  missing?: boolean;
}

/**
 * 制作方式：映射到 onset init 的 --delivery 与 --narration。选项来自后端（/api/styles 的 modes：
 * 宿主的口播、内置插件登记的做法与已装的第三方插件带来的做法）；还没取到时只有口播。
 */
export const fallbackModes: ModeOption[] = [
  { id: 'speech', label: '口播讲解', hint: '配音 + 动画，最常用', delivery: 'speech', narration: 'solo' },
];

export interface Template {
  id: string;
  title: string;
  desc: string;
  canvas: string;
  mode: string;
  example: string;
}

/** 口播的几种常见形式（画幅不同）。别的做法的模板来自后端给的做法里带了 example 的那几种。 */
const speechTemplates: Template[] = [
  {
    id: 'explainer',
    title: '口播科普',
    desc: '讲清一个概念',
    canvas: 'vertical-3x4',
    mode: 'speech',
    example: '把这篇文章做成 3 分钟的口播科普，讲清楚核心概念',
  },
  {
    id: 'short',
    title: '竖屏快讲',
    desc: '一分钟抓住注意力',
    canvas: 'vertical-9x16',
    mode: 'speech',
    example: '做一条 60 秒的竖屏快讲，开头三秒就抛出反常识的结论',
  },
  {
    id: 'landscape',
    title: '横屏讲解',
    desc: '适合 B 站长视频',
    canvas: 'landscape-16x9',
    mode: 'speech',
    example: '做成 5 分钟的横屏讲解视频，分三个小节，配图表',
  },
];

/** 模板就是几种常见的视频形式：点一下把画幅、制作方式和示例填好。 */
export function templatesOf(modes: readonly ModeOption[]): Template[] {
  return [
    ...speechTemplates,
    ...modes
      .filter((m) => m.example && m.canvas)
      .map((m) => ({ id: m.id, title: m.label, desc: m.hint, canvas: m.canvas!, mode: m.id, example: m.example! })),
  ];
}

export const rotatingWords = ['科普视频', '竖屏快讲', '卡点短片', '歌曲 MV', '对白短剧'];
export const placeholders = [
  '粘贴一篇文章，做成 3 分钟的口播科普',
  '拖进一份讲稿，做一条 60 秒的竖屏视频',
  '讲讲复利是怎么回事，配上数据图表',
  '把这周的产品更新做成一条横屏讲解',
];

export const LAST_TOOL = 'onset-studio:home-tool';

export function summaryText(summary?: ProjectSummary): string {
  if (!summary) return '';
  if (summary.missing) return '目录不见了';
  if (summary.busy) return summary.busy;
  const stage = summary.stage_label;
  if (!stage) return summary.total ? `${summary.completed}/${summary.total} 镜头` : '';
  return summary.total ? `${stage} · ${summary.completed}/${summary.total} 镜头` : stage;
}

export function shortCanvas(c: CanvasOption): string {
  const ratio =
    c.width === 1080 && c.height === 1440
      ? '3:4'
      : c.width === 1080 && c.height === 1920
        ? '9:16'
        : c.width === 1920 && c.height === 1080
          ? '16:9'
          : `${c.width}×${c.height}`;
  return `${ratio} ${c.height > c.width ? '竖屏' : '横屏'}`;
}

/** 画幅 id（如 vertical-3x4）里的宽高比，认不出时按 3:4。 */
export function ratioOf(canvas: string): [number, number] {
  const m = /(\d+)x(\d+)$/.exec(canvas);
  return m ? [Number(m[1]), Number(m[2])] : [3, 4];
}

export function ratioLabel(canvas: string): string {
  const [w, h] = ratioOf(canvas);
  return `${w}:${h}`;
}

/** 备用的项目名：说的话第一句，或第一个文件名；去掉路径符号，截到 24 字。AI 起名起不出来时用它，日期由开机画面加。 */
export function projectName(message: string, files: HomeMaterial[]): string {
  let base = message.split('\n').find((line) => line.trim()) ?? '';
  if (!base && files.length)
    base = files[0].kind === 'directory' ? files[0].name : files[0].name.replace(/\.[^.]+$/, '');
  base = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[，。！？、；：,.!?;:]+.*$/, '')
    .trim()
    .replace(/\s+/g, '-');
  return Array.from(base).slice(0, 24).join('') || '新视频';
}

export function formatSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}
