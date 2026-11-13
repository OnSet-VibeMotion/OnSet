import { contextBridge, ipcRenderer } from 'electron';

// 界面只拿到这几样：「我在客户端里」、平台（给 macOS 红绿灯留位置、顶栏可拖动），以及原生菜单发来的动作。
// 界面拿不到 Node 与 Electron 的其余接口；请求照旧走 /api（由主进程经 am:// 协议处理）。
contextBridge.exposeInMainWorld('am', {
  desktop: true,
  platform: process.platform,
  onMenu(callback: (action: unknown) => void): () => void {
    const listener = (_event: unknown, action: unknown) => callback(action);
    ipcRenderer.on('am:menu', listener);
    return () => ipcRenderer.removeListener('am:menu', listener);
  },
  /** Dock 图标上的数字：正在跑的任务数，0 清掉。 */
  setBadge(count: number): void {
    ipcRenderer.send('am:badge', count);
  },
  /** 系统通知；窗口在前台时主进程不弹。 */
  notify(title: string, body: string): void {
    ipcRenderer.send('am:notify', { title, body });
  },
  /** 场记小人此刻的状态（主窗口发，桌宠窗口收；见 main/pet.ts）。 */
  setCrew(state: unknown): void {
    ipcRenderer.send('am:crew', state);
  },
  onCrew(callback: (state: unknown) => void): () => void {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on('am:crew', listener);
    return () => ipcRenderer.removeListener('am:crew', listener);
  },
  /** 桌宠窗口的动作：focus 回到客户端，hide 收起桌宠。 */
  pet(action: 'focus' | 'hide'): void {
    ipcRenderer.send('am:pet', action);
  },
});
