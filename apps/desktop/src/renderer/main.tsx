import { createRoot } from 'react-dom/client';
import { App } from './app';
import { Pet } from './components/Pet';
import type { CrewSignal } from './components/chat/crew';
import './styles.css';

/** 原生菜单发给界面的动作，与主进程 menu.ts 的 MenuAction 一致。 */
export type MenuAction = { type: 'new' } | { type: 'home' } | { type: 'open'; path: string } | { type: 'step'; index: number } | { type: 'settings' } | { type: 'panel' };

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
      /** 桌宠：主窗口报状态、桌宠窗口收状态、桌宠窗口的按钮（见 main/pet.ts）。 */
      setCrew?: (state: CrewSignal | null) => void;
      onCrew?: (callback: (state: CrewSignal | null) => void) => () => void;
      pet?: (action: 'focus' | 'hide') => void;
    };
  }
}

// 在客户端里：给红绿灯按钮留位置、让顶栏可以拖动窗口（见 styles.css 的 .desktop 规则）。
if (window.am?.desktop) document.documentElement.classList.add('desktop', `platform-${window.am.platform}`);

// 桌宠窗口（main/pet.ts）载入的是 /pet：同一份界面产物，只画像素工作室。
const petWindow = location.pathname === '/pet';
if (petWindow) document.documentElement.classList.add('pet-window');

createRoot(document.getElementById('app')!).render(petWindow ? <Pet /> : <App />);
