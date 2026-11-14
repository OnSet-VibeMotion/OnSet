import { BrowserWindow, ipcMain, Menu, type IpcMainEvent } from 'electron';
import { mainWindow } from './pet';

/** Windows 的红黄绿按钮只控制主窗口，预览页面与桌宠不能代发窗口指令。 */
function senderWindow(event: IpcMainEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && win === mainWindow() && event.senderFrame === event.sender.mainFrame ? win : null;
}

export function installWindowsChrome(): void {
  if (process.platform !== 'win32') return;
  ipcMain.on('onset:window-command', (event, command: unknown) => {
    const win = senderWindow(event);
    if (!win) return;
    switch (command) {
      case 'close': win.close(); break;
      case 'minimize': win.minimize(); break;
      case 'maximize':
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        break;
    }
  });
  ipcMain.on('onset:application-menu', (event, position: unknown) => {
    const win = senderWindow(event);
    if (!win || !position || typeof position !== 'object') return;
    const { x, y } = position as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const [width, height] = win.getContentSize();
    // 继续用同一份原生菜单，菜单项、快捷键与桌宠开关不另造一份。
    Menu.getApplicationMenu()?.popup({
      window: win,
      x: Math.max(0, Math.min(width - 1, Math.round(x))),
      y: Math.max(0, Math.min(height - 1, Math.round(y))),
    });
  });
}
