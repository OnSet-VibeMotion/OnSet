import { createRoot } from 'react-dom/client';
import { App } from './app';
import { Pet } from './components/Pet';
import type { CrewSignal, PetCommand } from './components/chat/crew';
import { installSkin } from './skin';
import { installExclusiveAudioPlayback } from './media';
import type { SkinView } from './types';
import './styles.css';

/** 原生菜单发给界面的动作，与主进程 menu.ts 的 MenuAction 一致。 */
export type MenuAction = { type: 'new' } | { type: 'home' } | { type: 'open'; path: string } | { type: 'step'; index: number } | { type: 'settings' } | { type: 'panel' } | { type: 'reveal' };

declare global {
  interface Window {
    /** 客户端的 preload 注入；浏览器里没有。 */
    onset?: {
      desktop: boolean;
      platform: string;
      windowCommand?: (command: 'close' | 'minimize' | 'maximize') => void;
      showApplicationMenu?: (position: { x: number; y: number }) => void;
      /** Windows 系统文件夹选择器；取消不改变当前位置。 */
      selectDirectory?: (defaultPath?: string) => Promise<string | null>;
      /** 原生菜单的动作：new / home / open（带路径）/ step（第几步）。返回取消订阅。 */
      onMenu?: (callback: (action: MenuAction) => void) => () => void;
      setBadge?: (count: number) => void;
      notify?: (title: string, body: string) => void;
      /** 桌宠：主窗口报状态、桌宠窗口收状态、桌宠窗口的按钮（见 main/pet.ts）。 */
      setCrew?: (state: CrewSignal | null) => void;
      onCrew?: (callback: (state: CrewSignal | null) => void) => () => void;
      pet?: (command: PetCommand) => void;
      onPetCommand?: (callback: (command: PetCommand) => void) => () => void;
      /** 界面皮肤：本窗口换了皮肤告诉别的窗口（带新的底色给窗口背景），别的窗口收到后重取。 */
      skinChanged?: (background: string) => void;
      skinNow?: () => SkinView | null;
      painted?: () => void;
      onSkin?: (callback: () => void) => () => void;
      /** 在 Finder 中显示；path 空是项目文件夹，project 空是当前项目。返回错误文字，成功为空。 */
      reveal?: (path: string, project?: string) => Promise<string>;
    };
  }
}

// 在客户端里：给红绿灯按钮留位置、让顶栏可以拖动窗口（见 styles.css 的 .desktop 规则）。
if (window.onset?.desktop) document.documentElement.classList.add('desktop', `platform-${window.onset.platform}`);

// 桌宠窗口（main/pet.ts）载入的是 /pet：同一份界面产物，只画像素工作室。
const petWindow = location.pathname === '/pet';
if (petWindow) document.documentElement.classList.add('pet-window');

// 界面皮肤：两个窗口都在画之前开始取（studio/skins.ts），取到前是放映室的默认色。
installSkin();
installExclusiveAudioPlayback();

createRoot(document.getElementById('app')!).render(petWindow ? <Pet /> : <App />);
