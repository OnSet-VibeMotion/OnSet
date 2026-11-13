import { app, BrowserWindow, dialog, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { startGoBackend, type GoBackend } from './gobackend';
import { loginShellPath } from './shellpath';

/*
 * 桌面客户端的主进程。
 *
 * 界面从自定义协议 am://app/ 加载，于是界面里所有相对地址——fetch('/api/…')、EventSource、
 * <video src="/api/…">、合成预览的 <iframe src="/preview/…">、上传的 FormData——都落到
 * 下面同一个 handleRequest 里，界面代码不用为客户端改一行。过渡期 /api 与 /preview 转给后台的
 * Go 版 am studio（gobackend.ts），其余路径返回界面的静态文件。
 */

const SCHEME = 'am';
const ORIGIN = `${SCHEME}://app`;

// 必须在 ready 之前登记：standard + secure 才有正常的同源与相对路径；stream 让 SSE 与视频按流返回。
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

app.setName('ArticleToMotion');

const rendererDir = path.join(__dirname, 'renderer');
let backend: GoBackend | null = null;

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

/** 转给后台 Go 版 am studio。请求体与响应体都按流转发：上传不进内存，SSE 与视频边到边给。 */
async function proxy(request: Request, url: URL): Promise<Response> {
  if (!backend) return new Response(JSON.stringify({ code: 'backend_down', message: '后台服务没有启动' }), { status: 503 });
  const target = `${backend.origin}${url.pathname}${url.search}`;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: request.headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  };
  if (hasBody) init.duplex = 'half';
  const response = await fetch(target, init);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== 'app') return new Response('not found', { status: 404 });
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/preview/')) return proxy(request, url);
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
    process.env.PATH = loginShellPath();
    const logFile = path.join(app.getPath('logs'), 'am-studio.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = (line: string) => fs.appendFile(logFile, line, () => {});
    try {
      backend = await startGoBackend(process.env, log);
    } catch (err) {
      dialog.showErrorBox('后台服务起不来', `${err instanceof Error ? err.message : String(err)}\n\n日志：${logFile}`);
      app.quit();
      return;
    }
    protocol.handle(SCHEME, handleRequest);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => backend?.stop());
}
