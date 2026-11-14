import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { mainWindow } from './pet';

/** 插件目录，以及 Windows 的保存位置与项目目录共用系统文件夹选择器。 */
export function installDirectoryPicker(): void {
  ipcMain.handle('onset:select-directory', async (event, requested: unknown): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner !== mainWindow() || event.senderFrame !== event.sender.mainFrame) return null;
    let defaultPath: string | undefined;
    if (typeof requested === 'string' && path.isAbsolute(requested)) {
      try {
        if (fs.statSync(requested).isDirectory()) defaultPath = requested;
      } catch {
        // 上次使用的目录可能已被移动，让系统选择器使用自己的默认位置。
      }
    }
    const result = await dialog.showOpenDialog(owner, {
      title: '选择文件夹',
      buttonLabel: '选择文件夹',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
}
