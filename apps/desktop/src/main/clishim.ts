import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * am 命令行。客户端自带 Node（Electron 以 ELECTRON_RUN_AS_NODE=1 运行即是 Node），所以命令行是打包进资源目录的
 * 一个 JS 文件（resources/cli/am.cjs），由一段 shim 脚本调起。编排工具在提示词里调用的 am 就是这个 shim：
 * AM_SELF 指向它，am 据此把自己所在目录放进子进程的 PATH、写进 AM_EXECUTABLE。
 */

/** 资源目录：打包后是 .app/Contents/Resources，开发时是仓库根。 */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../..');
}

/** 命令行入口文件。开发时用 packages/cli/dist。 */
export function cliEntry(): string {
  return app.isPackaged ? path.join(resourcesDir(), 'cli', 'am.cjs') : path.join(resourcesDir(), 'packages', 'cli', 'dist', 'am.cjs');
}

/** 内置资产目录。 */
export function assetsDir(): string {
  return path.join(resourcesDir(), 'assets');
}

/** shim 的内容：用本应用的 Electron 当 Node 运行命令行。路径用单引号包住，含空格或中文都没关系。 */
export function shimScript(): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    '# 由 ArticleToMotion 客户端写出：用客户端自带的运行时执行 am 命令行。重装客户端后在菜单里重新安装即可。',
    `ELECTRON_RUN_AS_NODE=1 AM_ASSETS_DIR=${q(assetsDir())} AM_SELF="$0" exec ${q(process.execPath)} ${q(cliEntry())} "$@"`,
    '',
  ].join('\n');
}

export const shimPath = path.join(os.homedir(), '.local', 'bin', 'am');

/** 菜单「安装命令行工具…」：写 ~/.local/bin/am。已有不是本应用写的 am 时先确认，不静默覆盖。 */
export async function installCLIShim(): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const body = shimScript();
  let existing = '';
  try {
    existing = fs.readFileSync(shimPath, 'utf8');
  } catch {
    existing = '';
  }
  if (existing === body) {
    await dialog.showMessageBox({ ...(win ? {} : {}), type: 'info', message: '命令行工具已安装', detail: shimPath });
    return;
  }
  if (existing !== '' && !existing.includes('由 ArticleToMotion 客户端写出')) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['替换', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: `${shimPath} 已经有一个 am`,
      detail: '多半是之前装的 Go 版 am。替换后，终端里与编排工具调用的 am 都会换成客户端自带的这一版。',
    });
    if (response !== 0) return;
  }
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  const tmp = shimPath + '.tmp';
  fs.writeFileSync(tmp, body, { mode: 0o755 });
  fs.renameSync(tmp, shimPath);
  await dialog.showMessageBox({ type: 'info', message: '命令行工具已安装', detail: `${shimPath}\n确认 ~/.local/bin 在终端的 PATH 里。` });
}
