import { app, BrowserWindow, dialog, ipcMain, Notification, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { newServer, type Server } from '@am/engine/studio';
import { assetsDir, shimScript } from './clishim';
import { installMenu } from './menu';
import { loginShellPath } from './shellpath';

/*
 * 桌面客户端的主进程。
 *
 * 界面从自定义协议 am://app/ 加载，于是界面里所有相对地址——fetch('/api/…')、EventSource、
 * <video src="/api/…">、合成预览的 <iframe src="/preview/…">、上传的 FormData——都落到
 * 下面同一个 handleRequest 里，界面代码不用为客户端改一行。/api 与 /preview 交给进程内的
 * Studio 后端（@am/engine/studio 的 handle），其余路径返回界面的静态文件。
 */

const SCHEME = 'am';
const ORIGIN = `${SCHEME}://app`;

// 必须在 ready 之前登记：standard + secure 才有正常的同源与相对路径；stream 让 SSE 与视频按流返回。
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

app.setName('ArticleToMotion');

// 端到端测试用（apps/desktop/e2e）：把 userData 指到临时目录，私有 am shim、单实例锁与浏览器存储都不碰
// 真实的 ~/Library/Application Support/ArticleToMotion。必须在 requestSingleInstanceLock 之前设。
if (process.env.AM_DESKTOP_USER_DATA) app.setPath('userData', process.env.AM_DESKTOP_USER_DATA);

const rendererDir = path.join(__dirname, 'renderer');
let backend: Server | null = null;

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** 界面的静态文件。不带扩展名的路径回落到 index.html；带扩展名找不到就 404（与 Go 版 static 同一条规则）。 */
async function serveStatic(pathname: string): Promise<Response> {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(rendererDir, rel || 'index.html');
  if (!target.startsWith(rendererDir + path.sep) && target !== rendererDir) return new Response('forbidden', { status: 403 });
  const ext = path.extname(target);
  try {
    const body = await fs.promises.readFile(target);
    return new Response(body, { headers: { 'content-type': mime[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' } });
  } catch {
    if (ext) return new Response('not found', { status: 404 });
    const index = await fs.promises.readFile(path.join(rendererDir, 'index.html'));
    return new Response(index, { headers: { 'content-type': mime['.html'], 'cache-control': 'no-cache' } });
  }
}

/**
 * Studio 后端写任务与编排工具调用的 am：一段私有 shim，用本应用的 Electron 当 Node 跑自带的命令行。
 * 不依赖用户有没有在菜单里「安装命令行工具」，也不会用到 ~/.local/bin 里可能是别的版本的 am。
 */
function privateCLI(): string {
  const file = path.join(app.getPath('userData'), 'bin', 'am');
  const body = shimScript();
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  if (existing !== body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', body, { mode: 0o755 });
    fs.renameSync(file + '.tmp', file);
  }
  return file;
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== 'app') return new Response('not found', { status: 404 });
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/preview/')) {
    if (!backend) return new Response(JSON.stringify({ code: 'backend_down', message: '后台服务没有启动' }), { status: 503 });
    return backend.handle(request);
  }
  return serveStatic(url.pathname);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'ArticleToMotion',
    backgroundColor: '#0b0a09',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 22 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // 外链交给系统浏览器；项目内的文件（封面原图、成片）开一个新的客户端窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${ORIGIN}/`)) return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#0b0a09' } };
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  void win.loadURL(`${ORIGIN}/`);
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // 打包后的 .app 用 build/icon.icns；开发时跑的是裸 Electron，Dock 里会是 Electron 的图标。
    if (!app.isPackaged) {
      const devIcon = path.join(__dirname, '..', 'build', 'icon.png');
      if (fs.existsSync(devIcon)) app.dock?.setIcon(devIcon);
    }
    // 端到端测试用：AM_DESKTOP_KEEP_PATH=1 时不并入登录 shell 的 PATH，否则测试放在 PATH 最前面的
    // 假编排工具（e2e/fake-bin/claude）会被登录 shell 里真实的 claude 挤到后面。
    if (process.env.AM_DESKTOP_KEEP_PATH !== '1') process.env.PATH = loginShellPath();
    // 引擎从这里读内置资产（Go 版是 go:embed 进二进制的）。
    process.env.AM_ASSETS_DIR ??= assetsDir();
    try {
      const executable = privateCLI();
      // 引擎里经 envutil.amExecutable() 找 am 的地方（子进程环境的 AM_EXECUTABLE、PATH）也认这一份。
      process.env.AM_SELF = executable;
      backend = newServer({ executable });
    } catch (err) {
      dialog.showErrorBox('后台服务起不来', err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
    protocol.handle(SCHEME, handleRequest);
    installMenu();
    // 界面报来的任务数与完成通知。通知只在没有窗口在前台时弹：人就在看着的时候不打扰。
    ipcMain.on('am:badge', (_event, count: number) => {
      app.setBadgeCount(Math.max(0, Math.trunc(Number(count) || 0)));
    });
    ipcMain.on('am:notify', (_event, message: { title?: string; body?: string }) => {
      if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
      const note = new Notification({ title: String(message?.title ?? 'ArticleToMotion'), body: String(message?.body ?? '') });
      note.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      });
      note.show();
    });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => backend?.shutdown());
}
