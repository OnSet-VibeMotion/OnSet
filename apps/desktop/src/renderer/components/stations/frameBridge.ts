import { api } from '../../api';
import type { ProgressState, ProjectState, Scene } from '../../types';

/** 交给插件页面的配色变量（宿主 :root 的同名变量），页面照着用就与客户端一致。 */
const themeVars = [
  '--bg',
  '--panel',
  '--raised',
  '--well',
  '--chip',
  '--hover',
  '--line',
  '--line-strong',
  '--text',
  '--text-2',
  '--text-3',
  '--muted',
  '--faint',
  '--accent',
  '--accent-hover',
  '--accent-ink',
  '--accent-soft',
  '--accent-line',
  '--accent-text',
  '--ok',
  '--stale',
  '--bad',
  '--radius',
  '--sans',
  '--serif',
  '--mono',
];

/** 插件页面的基础样式：与客户端同一套按钮、输入框、标题，页面不写样式也像是客户端的一部分。 */
const themeCSS = `
:root { color-scheme: dark; }
body { margin: 0; padding: 16px; background: var(--panel); color: var(--text); font: 13px/1.6 var(--sans); }
h1, h2, h3 { font-family: var(--serif); font-weight: 600; margin: 0 0 10px; }
h1 { font-size: 20px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
a { color: var(--accent-text); }
small, .muted { color: var(--muted); }
button { font: 13px var(--sans); color: var(--text); background: transparent; border: 1px solid var(--line-strong); border-radius: 999px; padding: 6px 14px; cursor: pointer; }
button:hover { background: var(--hover); }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
button:disabled { opacity: .5; cursor: default; }
input, select, textarea { font: 13px var(--sans); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 8px; padding: 6px 10px; }
.card { background: var(--raised); border: 1px solid var(--line-strong); border-radius: var(--radius); padding: 14px; }
.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--stale); }
`;

export function hostTheme(): { vars: Record<string, string>; css: string } {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of themeVars) {
    const v = style.getPropertyValue(name).trim();
    if (v) vars[name] = v;
  }
  return { vars, css: themeCSS };
}

/** 项目概况：给申请了 permissions.project 的插件页面。只有摘要，不给文件内容。 */
export async function projectSummary(): Promise<Record<string, unknown>> {
  const [state, scenes, progress, publish] = await Promise.all([
    api<ProjectState>('/api/state'),
    api<{ scenes: Scene[] }>('/api/scenes'),
    api<ProgressState>('/api/progress').catch(() => null),
    api<{ available: boolean; data?: Record<string, unknown> }>('/api/publish').catch(() => null),
  ]);
  const root = state.project.path;
  return {
    name: state.project.name,
    step: state.step ?? '',
    film_style: state.metadata?.film_style ?? '',
    scenes: (scenes.scenes ?? []).map((sc) => {
      const dir = sc.directory.startsWith(root + '/') ? sc.directory.slice(root.length + 1) : sc.directory;
      return {
        id: sc.id,
        duration_seconds: sc.duration_seconds,
        rendered: sc.exists,
        stale: sc.stale,
        rendering: sc.rendering === true,
        output: sc.output ? `${dir}/${sc.output}` : '',
      };
    }),
    progress: progress
      ? {
          current: progress.current,
          waiting_on: progress.waiting_on,
          stations: progress.stations.map((s) => ({
            id: s.id,
            label: s.label,
            status: s.status,
            detail: s.detail ?? '',
          })),
        }
      : null,
    publish: publish?.available ? (publish.data ?? null) : null,
  };
}

/** 页面经 postMessage 发来的请求（协议同 /station-ui/_sdk.js）。 */
export interface PageRequest {
  onset: 'station';
  id: number;
  type: 'theme' | 'info' | 'project' | 'read' | 'list' | 'run' | 'call' | 'ask' | 'send' | 'open';
  path?: string;
  op?: string;
  page?: string;
  params?: Record<string, unknown>;
  text?: string;
}

/** 等用户确认的执行请求：本站的操作（run）或 onset 自带的操作（call）。 */
export interface PendingRun {
  id: number;
  kind: 'run' | 'call' | 'send';
  op: string;
  label: string;
  params: Record<string, unknown>;
}

export const maxAskChars = 4000;

/*
 * 插件页面里的按钮是不是用户亲手点的（不是页面脚本自己点的）。
 * 用户在 iframe 里真点一下，浏览器给整条祖先链记上「刚有用户操作」（navigator.userActivation，约 5 秒），
 * 脚本调 click() 不算（e2e 实测：脚本点的读到 false，真点的读到 true）。但这个标记不分点在哪：用户刚在片场自己的界面上
 * 点过（比如点开这一页），页面一加载就请求执行也会读到 true，所以片场自己最近 5 秒有点击或按键时不认；
 * 这个标记也不分是哪个 iframe：同时挂着几个插件页面时，用户点了 A，B 的脚本趁机发来的请求也读到 true，
 * 页面脚本能抢焦点，所以多框架时即使焦点在请求方也无法证明归属，必须确认；只有文档里唯一的 iframe 才直接放行。
 * 单框架仍要求宿主有焦点、activeElement 就是请求方，排除后台窗口与宿主自己的操作。
 * 一次点击只放行一次，同一段时间里再来的请求照旧确认。
 */
const activationWindowMs = 5000;
let lastHostInput = 0;
let lastDirectRun = 0;
if (typeof window !== 'undefined') {
  const mark = () => {
    lastHostInput = Date.now();
  };
  window.addEventListener('pointerdown', mark, true);
  window.addEventListener('keydown', mark, true);
}

export function clickedInPluginPage(frame: Element | null, now = Date.now()): boolean {
  if (typeof navigator === 'undefined' || !navigator.userActivation?.isActive) return false;
  if (!frame || !frame.ownerDocument.hasFocus() || frame.ownerDocument.activeElement !== frame) return false;
  if (frame.ownerDocument.querySelectorAll('iframe').length !== 1) return false;
  if (now - lastHostInput < activationWindowMs || now - lastDirectRun < activationWindowMs) return false;
  lastDirectRun = now;
  return true;
}

/** 只给测试用：清掉「最近的点击」。 */
export function resetPluginClicks(): void {
  lastHostInput = 0;
  lastDirectRun = 0;
}

export function paramText(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('，');
}
