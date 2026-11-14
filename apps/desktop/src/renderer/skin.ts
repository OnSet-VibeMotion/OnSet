import { api } from './api';
import type { SkinView } from './types';

/**
 * 界面皮肤（后端 studio/skins.ts）：把一份皮肤的变量写到 <html> 的内联样式上，盖过 styles.css `:root` 的默认值。
 * 主窗口与桌宠窗口启动时各取一次；设置页换了皮肤后经主进程通知别的窗口（am:skin）再取一次。
 * 皮肤里的值后端已经逐个校验过（只有颜色与字体名），这里照写。
 */

/** 上一份写上去的变量，换皮肤时先清掉，免得前一套里有、这一套里没有的变量留下来。 */
let applied: string[] = [];
const listeners = new Set<(skin: SkinView) => void>();
let current: SkinView | null = null;

export function applySkin(skin: SkinView): void {
  const root = document.documentElement;
  for (const name of applied) root.style.removeProperty(name);
  const next: [string, string][] = [
    ...Object.entries(skin.tokens).map(([k, v]): [string, string] => [`--${k}`, v]),
    ...Object.entries(skin.fonts).map(([k, v]): [string, string] => [`--${k}`, v]),
  ];
  if (skin.radius !== null) next.push(['--radius', `${skin.radius}px`]);
  for (const [k, v] of next) root.style.setProperty(k, v);
  applied = next.map(([k]) => k);
  root.style.colorScheme = skin.scheme;
  root.dataset.skin = skin.id;
  root.dataset.scheme = skin.scheme;
  current = skin;
  for (const l of listeners) l(skin);
}

/** 取现在用的皮肤并写上去。取不到（后台还没起来）就保持默认的放映室。 */
export async function loadSkin(): Promise<void> {
  try {
    const { skin } = await api<{ skin: SkinView; missing: string }>('/api/skins/current');
    applySkin(skin);
  } catch {
    // 放映室就是 styles.css 的默认值。
  }
}

/** 换皮肤：写进用户登记，写到本窗口，并告诉别的窗口（桌宠）重取。 */
export async function chooseSkin(id: string): Promise<SkinView> {
  const { skin } = await api<{ skin: SkinView }>('/api/skins/current', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  applySkin(skin);
  window.am?.skinChanged?.(skin.tokens.bg ?? '');
  return skin;
}

export function currentSkin(): SkinView | null {
  return current;
}

/** 皮肤换了就回调（桌宠按它换材质与人的衣着）。返回取消订阅。 */
export function onSkin(listener: (skin: SkinView) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 启动时挂上：客户端里同步向主进程要现在的皮肤，在 React 画第一帧之前写上，画完再请主进程显示窗口
 * （浅色皮肤不先闪一下黑底）；不在客户端里（浏览器调试）退回经接口取。之后别的窗口换了皮肤时再取。
 */
export function installSkin(): void {
  let initial: SkinView | null = null;
  try {
    initial = window.am?.skinNow?.() ?? null;
  } catch {
    initial = null;
  }
  if (initial) applySkin(initial);
  else void loadSkin();
  requestAnimationFrame(() => requestAnimationFrame(() => window.am?.painted?.()));
  window.am?.onSkin?.(() => void loadSkin());
}
