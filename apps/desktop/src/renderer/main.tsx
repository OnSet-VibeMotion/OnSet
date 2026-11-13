import { createRoot } from 'react-dom/client';
import { App } from './app';
import './styles.css';

declare global {
  interface Window {
    /** 客户端的 preload 注入；浏览器里没有。 */
    am?: { desktop: boolean; platform: string };
  }
}

// 在客户端里：给红绿灯按钮留位置、让顶栏可以拖动窗口（见 styles.css 的 .desktop 规则）。
if (window.am?.desktop) document.documentElement.classList.add('desktop', `platform-${window.am.platform}`);

createRoot(document.getElementById('app')!).render(<App />);
