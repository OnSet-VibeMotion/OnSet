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
});
