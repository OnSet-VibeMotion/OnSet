import { contextBridge, ipcRenderer } from 'electron';

// 界面只拿到这几样：「我在客户端里」、平台（给 macOS 红绿灯留位置、顶栏可拖动），以及原生菜单发来的动作。
// 界面拿不到 Node 与 Electron 的其余接口；请求照旧走 /api（由主进程经 onset:// 协议处理）。
contextBridge.exposeInMainWorld('onset', {
  desktop: true,
  platform: process.platform,
  onMenu(callback: (action: unknown) => void): () => void {
    const listener = (_event: unknown, action: unknown) => callback(action);
    ipcRenderer.on('onset:menu', listener);
    return () => ipcRenderer.removeListener('onset:menu', listener);
  },
  /** Dock 图标上的数字：正在跑的任务数，0 清掉。 */
  setBadge(count: number): void {
    ipcRenderer.send('onset:badge', count);
  },
  /** 在 Finder 中显示项目里的文件或文件夹；path 空表示项目文件夹，project 空表示当前项目。返回错误文字，成功为空。 */
  reveal(path: string, project?: string): Promise<string> {
    return ipcRenderer.invoke('onset:reveal', { path, project });
  },
  /** 系统通知；窗口在前台时主进程不弹。 */
  notify(title: string, body: string): void {
    ipcRenderer.send('onset:notify', { title, body });
  },
  /** 场记小人此刻的状态（主窗口发，桌宠窗口收；见 main/pet.ts）。 */
  setCrew(state: unknown): void {
    ipcRenderer.send('onset:crew', state);
  },
  onCrew(callback: (state: unknown) => void): () => void {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on('onset:crew', listener);
    return () => ipcRenderer.removeListener('onset:crew', listener);
  },
  /** 桌宠窗口的动作（见 renderer/components/chat/crew.ts 的 PetCommand）。 */
  pet(command: unknown): void {
    ipcRenderer.send('onset:pet', command);
  },
  /** 现在用的界面皮肤，同步取：界面在第一次画之前写上去，不先闪一下默认的黑底。 */
  skinNow(): unknown {
    return ipcRenderer.sendSync('onset:skin-now');
  },
  /** 写好皮肤、画完第一帧：主进程这时才显示窗口。 */
  painted(): void {
    ipcRenderer.send('onset:painted');
  },
  /** 界面皮肤换了：告诉主进程（带新的底色），主进程转告别的窗口。 */
  skinChanged(background: string): void {
    ipcRenderer.send('onset:skin', background);
  },
  onSkin(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on('onset:skin', listener);
    return () => ipcRenderer.removeListener('onset:skin', listener);
  },
  /** 主窗口收桌宠转来的动作（切页、答批准、发话、停下）。 */
  onPetCommand(callback: (command: unknown) => void): () => void {
    const listener = (_event: unknown, command: unknown) => callback(command);
    ipcRenderer.on('onset:pet-command', listener);
    return () => ipcRenderer.removeListener('onset:pet-command', listener);
  },
});
