import { contextBridge } from 'electron';

// 界面只需要知道「我在客户端里」和平台：据此给 macOS 的红绿灯按钮留位置、让顶栏可以拖动窗口。
// 原生菜单、通知、选目录这些能力后续按需在这里加，界面拿不到 Node 与 Electron 的其余接口。
contextBridge.exposeInMainWorld('am', {
  desktop: true,
  platform: process.platform,
});
