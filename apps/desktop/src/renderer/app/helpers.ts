import { type Tab, tabs } from '../components/Preview';
import { pageView } from '../components/pageViews';
import { scriptFinalPath } from '../components/Script';
import { isStationTab, stationPageLabel } from '../components/Stations';
import { storyboardFiles } from '../components/Storyboard';

export const tabLabel = (id: Tab) => tabs.find(([t]) => t === id)?.[1] ?? stationPageLabel(id) ?? id;

/** 画幅写成比例（1080x1440 → 3:4），帧率不在顶栏里出现。 */
export function canvasLabel(canvas: string): string {
  const m = /^(\d+)\s*[x×]\s*(\d+)/.exec(canvas);
  if (!m) return canvas;
  const [w, h] = [Number(m[1]), Number(m[2])];
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h) || 1;
  return `${w / g}:${h / g}`;
}

/** 有专门页面的项目文件：口播稿开口播稿页，分镜计划与处理方案开分镜页，publish.md 开发布页，不在文件页里显示原文。 */
export const pageForFile = (path: string): 'script' | 'storyboard' | 'publish' | null =>
  path === scriptFinalPath
    ? 'script'
    : storyboardFiles.includes(path)
      ? 'storyboard'
      : path === 'publish.md'
        ? 'publish'
        : null;

export const SESSION_KEY = 'onset-studio-session:';
export const PANEL_OPEN_KEY = 'onset-studio.panel-open';
export const PANEL_WIDTH_KEY = 'onset-studio.panel-width:';

/** 看画面的页面面板默认宽一些，读文字的页面窄一些；宽度按这两类分别记住。 */
export type PanelKind = 'media' | 'doc';

export const panelKind = (tab: Tab): PanelKind =>
  ['scene', 'compose', 'final', 'review', 'style', 'motion', 'audition'].includes(tab) ||
  pageView(tab)?.media ||
  isStationTab(tab)
    ? 'media'
    : 'doc';

export const panelDefault: Record<PanelKind, number> = { media: 0.58, doc: 0.45 };
/** 对话栏最窄 420px，面板最窄 360px：拖动时两边都夹住。 */
export const minChat = 420;
export const minPanel = 360;

export function readNumber(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return value > 0 && value < 1 ? value : fallback;
  } catch {
    return fallback;
  }
}

export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 记不住只是下次回到默认值。
  }
}

export function remember(projectId: string, sessionId: string) {
  try {
    if (sessionId) localStorage.setItem(SESSION_KEY + projectId, sessionId);
    else localStorage.removeItem(SESSION_KEY + projectId);
  } catch {
    // 隐私模式下 localStorage 不可用，只是少了「记住上次的会话」。
  }
}

export function recall(projectId: string): string {
  try {
    return localStorage.getItem(SESSION_KEY + projectId) ?? '';
  } catch {
    return '';
  }
}
