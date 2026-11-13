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
  /** 在 Finder 中显示项目里的文件或文件夹；path 空表示项目文件夹，project 空表示当前项目。返回错误文字，成功为空。 */
  reveal(path: string, project?: string): Promise<string> {
    return ipcRenderer.invoke('am:reveal', { path, project });
  },
  /** 系统通知；窗口在前台时主进程不弹。 */
  notify(title: string, body: string): void {
    ipcRenderer.send('am:notify', { title, body });
  },
});
