import { createRoot } from 'react-dom/client';
import { App } from './app';
import './styles.css';

/** 原生菜单发给界面的动作，与主进程 menu.ts 的 MenuAction 一致。 */
export type MenuAction = { type: 'new' } | { type: 'home' } | { type: 'open'; path: string } | { type: 'step'; index: number } | { type: 'settings' };

declare global {
  interface Window {
    /** 客户端的 preload 注入；浏览器里没有。 */
    am?: {
      desktop: boolean;
      platform: string;
      /** 原生菜单的动作：new / home / open（带路径）/ step（第几步）。返回取消订阅。 */
      onMenu?: (callback: (action: MenuAction) => void) => () => void;
      setBadge?: (count: number) => void;
      notify?: (title: string, body: string) => void;
    };
  }
}

// 在客户端里：给红绿灯按钮留位置、让顶栏可以拖动窗口（见 styles.css 的 .desktop 规则）。
if (window.am?.desktop) document.documentElement.classList.add('desktop', `platform-${window.am.platform}`);

createRoot(document.getElementById('app')!).render(<App />);
