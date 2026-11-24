import type { ReactNode } from 'react';
import type { ProjectState, ProjectUsage, Scene, Usage } from '../../types';

export type BuiltinTab =
  | 'progress'
  | 'script'
  | 'storyboard'
  | 'scene'
  | 'compose'
  | 'final'
  | 'style'
  | 'motion'
  | 'voice'
  | 'review'
  | 'publish'
  | 'memory'
  | 'evidence'
  | 'audition'
  | 'file';

/** 按钮触发的写任务：返回 task_id 的接口。App 负责发请求、提示与刷新任务列表。 */
export type RunAction = (path: string, payload?: Record<string, unknown>, onAccepted?: () => void) => void;

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export const FPS = 30;

export function sceneStatus(scene: Scene): 'ok' | 'stale' | 'todo' | 'rendering' {
  if (scene.rendering) return 'rendering';
  if (!scene.exists) return 'todo';
  return scene.stale ? 'stale' : 'ok';
}

export const statusText = { ok: '已出片', stale: '输入改过，产物已过期', todo: '未出片', rendering: '渲染中' };

/** 镜头页的快捷动作：带上镜头编号直接发给编排工具，由它改项目文件、重渲染。 */
export const quickActions: { label: string; needsOutput?: boolean; text: (id: string) => string }[] = [
  {
    label: '重做这个镜头',
    text: (id) =>
      `重做镜头 ${id}：保留文案、时长和与相邻镜头的交接约定，换一个更贴合文案的视觉方案。改好这个镜头的 prompt.md 后用 scene_run 工具重渲染它，渲染完用几句话说明新方案。`,
  },
  {
    label: '节奏放慢',
    needsOutput: true,
    text: (id) => `镜头 ${id} 的动画节奏放慢：元素出现更从容，关键信息多停留一会，总时长不变。改好后重渲染这个镜头。`,
  },
  {
    label: '节奏加快',
    needsOutput: true,
    text: (id) => `镜头 ${id} 的动画节奏加快：减少等待和空镜，信息更紧凑，总时长不变。改好后重渲染这个镜头。`,
  },
  {
    label: '文字太多',
    needsOutput: true,
    text: (id) =>
      `镜头 ${id} 画面上的文字太多、读不过来：精简成关键词，信息交给画面和字幕，每块文字留够阅读时间。改好后重渲染这个镜头。`,
  },
];

export function clock(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

export function relativeScene(state: ProjectState | null, scene: Scene): string {
  const root = state?.project.path ?? '';
  return scene.directory.startsWith(root + '/') ? scene.directory.slice(root.length + 1) : scene.directory;
}

/** 没有选中镜头时的提示：新项目还没有镜头，也就没有时间线。 */
export function noSceneText(scenes: Scene[]): string {
  return scenes.length > 0
    ? '在下方时间线里选一个镜头。'
    : '还没有镜头。点右上「开始制作」，分镜完成后镜头会出现在下方的时间线里。';
}

/** 紧凑写法：12.3M token · $4.17 · 2 次渲染；按额度计费的工具写「额度 43.0」。 */
export function usageLabel(scene: Scene): string {
  const u = scene.usage;
  if (!u || !u.source) return `${scene.attempts} 次渲染 · 未读到用量`;
  return [...spendParts(u), `${scene.attempts} 次渲染`].join(' · ');
}

/**
 * 用量的几段：token、费用、额度。qoder 这类按额度计费的工具不报 token（报 0），
 * 这时不写「0 token」，只写额度；有的尝试没读到时数字后面加「+」（是下限）。
 */
export function spendParts(u: Usage): string[] {
  const plus = u.partial ? '+' : '';
  const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  const parts: string[] = [];
  if (total > 0 || u.credits == null) parts.push(`${compact(total)} token${plus}`);
  if (u.cost_usd != null && (u.cost_usd > 0 || u.credits == null)) parts.push(`$${u.cost_usd.toFixed(2)}`);
  if (u.credits != null) parts.push(`额度 ${u.credits.toFixed(1)}${plus}`);
  return parts;
}

export function usageTitle(scene: Scene): string {
  const u = scene.usage;
  if (!u || !u.source) return '渲染工具没有报用量';
  const credits = u.credits != null ? ` · 额度 ${u.credits.toFixed(2)}` : '';
  return `全部 ${scene.attempts} 次渲染合计：输入 ${(u.input_tokens ?? 0).toLocaleString()}（其中缓存 ${(u.cached_input_tokens ?? 0).toLocaleString()}）· 输出 ${(u.output_tokens ?? 0).toLocaleString()}${credits}${u.partial ? '；有的尝试没读到用量，这是下限' : ''}`;
}

/** 紧凑写法：12.3M token · $4.17；没读到用量时如实说。 */
export function tokenLabel(u: Usage): string {
  if (!u.source) return u.partial ? '未读到用量' : '0 token';
  return spendParts(u).join(' · ');
}

const usageSources: Record<string, string> = { studio: 'Studio 对话', consolidate: '整理记忆' };

export function projectUsageTitle(u: ProjectUsage): string {
  const lines = [
    `渲染：${u.attempts} 次尝试 · ${tokenLabel(u.renders)}`,
    `编排：${u.orchestrator.calls} 次调用 · ${tokenLabel(u.orchestrator.total)}`,
  ];
  for (const [source, value] of Object.entries(u.orchestrator.by_source ?? {})) {
    lines.push(`  ${usageSources[source] ?? source}：${tokenLabel(value)}`);
  }
  if (u.total.partial) lines.push('有的调用没读到用量或费用，这是下限');
  return lines.join('\n');
}

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
