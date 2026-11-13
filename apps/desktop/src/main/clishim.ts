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

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * 随客户端下发的 npm（打包前由 scripts/vendor.mjs 取到 vendor/npm，打进 .app/Contents/Resources/npm）。
 * 没有时（开发时没跑过 npm run vendor）为空，am 退回 PATH 里的 npm。
 */
export function npmCLI(): string {
  const file = app.isPackaged ? path.join(resourcesDir(), 'npm', 'bin', 'npm-cli.js') : path.join(resourcesDir(), 'apps', 'desktop', 'vendor', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(file) ? file : '';
}

/** 借给 HyperFrames 渲染的浏览器（包装脚本 browserScript）的位置，与私有 am 放在一起。 */
export function browserPath(): string {
  return path.join(app.getPath('userData'), 'bin', 'am-browser');
}

/** shim 的内容：用本应用的 Electron 当 Node 运行命令行。路径用单引号包住，含空格或中文都没关系。 */
export function shimScript(): string {
  const npm = npmCLI();
  const npmVar = npm === '' ? '' : ` AM_NPM_CLI=${q(npm)}`;
  return [
    '#!/bin/sh',
    '# 由 ArticleToMotion 客户端写出：用客户端自带的运行时执行 am 命令行。重装客户端后在菜单里重新安装即可。',
    `ELECTRON_RUN_AS_NODE=1 AM_ASSETS_DIR=${q(assetsDir())} AM_BROWSER=${q(browserPath())}${npmVar} AM_SELF="$0" exec ${q(process.execPath)} ${q(cliEntry())} "$@"`,
    '',
  ].join('\n');
}

/**
 * 浏览器包装脚本：HyperFrames 把它当 Chrome 启动（HYPERFRAMES_BROWSER_PATH），它以浏览器模式启动本应用（browser.ts）。
 * 去掉 puppeteer 加的调试管道与端口参数（浏览器模式自己接管 fd 3/4）、无头参数（Electron 不认，窗口本来就不显示），
 * 以及 `--single-process`（HyperFrames 在 codex 沙箱里会加，Electron 不支持单进程）。
 * 开发时 Electron 不知道要加载哪个应用，要把应用目录作为第一个参数；打包后它总是加载自己。
 * HyperFrames 开工前会跑一次 `--version` 确认浏览器能用，并从中取主版本号：直接回答，不必真的启动。
 */
export function browserScript(): string {
  const appArg = app.isPackaged ? '' : ` ${q(app.getAppPath())}`;
  return [
    '#!/bin/sh',
    '# 由 ArticleToMotion 客户端写出：HyperFrames 渲染用的浏览器，借用客户端自带的 Chromium。',
    'unset ELECTRON_RUN_AS_NODE',
    `if [ "$1" = --version ]; then echo 'Chromium ${process.versions.chrome} (ArticleToMotion)'; exit 0; fi`,
    'for a; do',
    '  shift',
    '  case "$a" in',
    '    --remote-debugging-pipe|--remote-debugging-port=*|--headless|--headless=*|--single-process) ;;',
    '    *) set -- "$@" "$a" ;;',
    '  esac',
    'done',
    `AM_BROWSER_MODE=1 exec ${q(process.execPath)}${appArg} "$@"`,
    '',
  ].join('\n');
}

/** 把内容写到 file（内容相同就不动），可执行。 */
export function writeScript(file: string, body: string): void {
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  if (existing === body) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', body, { mode: 0o755 });
  fs.renameSync(file + '.tmp', file);
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
