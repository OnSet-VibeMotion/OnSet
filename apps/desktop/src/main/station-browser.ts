import { BrowserWindow, WebContentsView, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { StationBrowserLease, StationBrowserRequest } from '@onset/engine/flow';

const methods = new Set(['Page.enable', 'Page.bringToFront', 'Runtime.evaluate', 'Runtime.releaseObject', 'DOM.setFileInputFiles', 'Input.insertText']);
const escapeHTML = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type EmbeddedPage = { view: WebContentsView; bar: WebContentsView; contents: Electron.WebContents; controls: Electron.WebContents; closed: boolean; window: BrowserWindow; origins: string[]; owner?: symbol; title: string };

function allowed(url: string, origins: string[]): boolean {
  try { const parsed = new URL(url); return !parsed.username && !parsed.password && origins.includes(parsed.origin); } catch { return false; }
}
function directory(root: string, account: string): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let dir = fs.realpathSync(root);
  for (const name of ['web-sessions', account]) {
    dir = path.join(dir, name);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw Error('账号存储目录无效');
  }
  return dir;
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw Error('网页请求过大');
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('网页请求需要对象');
  return value as Record<string, unknown>;
}

/** 通用网页容器：站点脚本在插件进程里，只能控制本次操作取得的那个账号页面。 */
export class StationBrowsers {
  private pages = new Map<string, EmbeddedPage>();
  private leases = new Set<() => void>();
  constructor(private getWindow: () => BrowserWindow | undefined, private background = false) {}

  private hide(page: EmbeddedPage): void {
    if (page.closed || page.window.isDestroyed()) return;
    page.view.setVisible(false);
    page.bar.setVisible(false);
    if (!page.window.isDestroyed()) page.window.webContents.focus();
  }
  private show(page: EmbeddedPage): void {
    if (page.closed || page.window.isDestroyed() || page.contents.isDestroyed()) throw Error('客户端网页已关闭');
    for (const other of this.pages.values()) if (other.window === page.window) this.hide(other);
    page.view.setVisible(true);
    page.bar.setVisible(true);
    if (!this.background) { page.window.show(); page.window.focus(); }
    page.contents.focus();
  }
  private async open(request: StationBrowserRequest, raw: Record<string, unknown>, owner: symbol): Promise<{ page: EmbeddedPage; reused: boolean }> {
    const account = raw.account, label = raw.label, url = raw.url;
    if (typeof account !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(account)) throw Error('网页账号编号无效');
    if (typeof label !== 'string' || !label.trim() || label.length > 100) throw Error('网页账号名称无效');
    if (typeof url !== 'string' || !allowed(url, request.origins)) throw Error('网页地址不在插件声明的来源里');
    const key = path.join(request.data_dir, 'web-sessions', account);
    const existing = this.pages.get(key);
    if (existing && !existing.contents.isDestroyed()) {
      if (existing.owner && existing.owner !== owner) throw Error('这个账号正在由另一项操作填写，请稍后再试');
      // 插件更新可能收窄来源，复用时不能保留旧的放行表。
      existing.origins = request.origins;
      existing.owner = owner;
      existing.title = `${request.name} · ${label}`;
      await this.toolbar(existing);
      if (!allowed(existing.contents.getURL(), request.origins)) await existing.contents.loadURL(url);
      this.show(existing);
      return { page: existing, reused: true };
    }
    const window = this.getWindow();
    if (!window) throw Error('请先打开片场主窗口');
    const storage = session.fromPath(directory(request.data_dir, account));
    storage.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    storage.setPermissionCheckHandler(() => false);
    storage.on('will-download', event => event.preventDefault());
    const view = new WebContentsView({ webPreferences: { session: storage, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    const bar = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `station-toolbar-${randomBytes(12).toString('hex')}` } });
    // 关闭后 View.webContents 可能变成 undefined；必须保存 WebContents 的稳定引用。
    const page: EmbeddedPage = { view, bar, contents: view.webContents, controls: bar.webContents, closed: false, window, origins: request.origins, owner, title: `${request.name} · ${label}` };
    this.pages.set(key, page);
    window.contentView.addChildView(view);
    window.contentView.addChildView(bar);
    const layout = () => {
      const [width, height] = window.getContentSize();
      bar.setBounds({ x: 0, y: 0, width, height: 74 });
      view.setBounds({ x: 0, y: 74, width, height: Math.max(0, height - 74) });
    };
    window.on('resize', layout);
    window.once('closed', () => {
      window.removeListener('resize', layout);
      this.destroyPage(page);
      this.pages.delete(key);
    });
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (!allowed(url, page.origins)) event.preventDefault();
    };
    page.contents.on('will-navigate', guardNavigation);
    page.contents.on('will-redirect', guardNavigation);
    page.contents.setWindowOpenHandler(({ url }) => {
      if (allowed(url, page.origins)) void page.contents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    // 返回项目只隐藏页面，用户填到一半的内容不会因切页丢失。
    page.controls.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === 'https://onset.invalid/return') this.hide(page);
    });
    page.controls.setWindowOpenHandler(() => ({ action: 'deny' }));
    layout();
    this.show(page);
    await this.toolbar(page);
    await page.contents.loadURL(url);
    return { page, reused: false };
  }
  private toolbar(page: EmbeddedPage): Promise<void> {
    return page.controls.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;background:#171614;color:#f4eee4;font:14px system-ui;display:flex;align-items:center;gap:20px;height:74px;padding:0 24px 0 96px;box-sizing:border-box}a{color:inherit;text-decoration:none;border:1px solid #666057;padding:8px 16px;border-radius:24px}strong{flex:1}small{color:#c0b7a9}</style><a href="https://onset.invalid/return">返回项目</a><strong>${escapeHTML(page.title)}</strong><small>请检查账号与内容，发布由你确认</small>`));
  }

  async lease(request: StationBrowserRequest): Promise<StationBrowserLease> {
    const token = randomBytes(32).toString('hex'), owner = Symbol();
    let active = true, busy = false, current: EmbeddedPage | undefined;
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      if (!active || req.method !== 'POST' || req.url !== '/' || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403).end(JSON.stringify({ error: '网页连接已失效或未授权' })); return;
      }
      if (busy) { res.writeHead(409).end(JSON.stringify({ error: '请等待上一个网页请求完成' })); return; }
      busy = true;
      try {
        const body = await readBody(req);
        if (!active) throw Error('网页连接已结束');
        let result: unknown;
        if (body.action === 'open') {
          if (current) throw Error('一次操作只控制一个账号页面');
          const opened = await this.open(request, body, owner);
          current = opened.page;
          if (!active) { current.owner = undefined; throw Error('网页连接已结束'); }
          result = { reused: opened.reused };
        } else {
          if (!current || current.contents.isDestroyed()) throw Error('请先打开账号页面');
          if (body.action !== 'command' || typeof body.method !== 'string') throw Error('网页操作无效');
          const wc = current.contents;
          const params = body.params ?? {};
          if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error('网页操作参数无效');
          const p = params as Record<string, unknown>;
          if (body.method === 'Page.navigate') {
            if (typeof p.url !== 'string' || !allowed(p.url, current.origins)) throw Error('网页地址不在插件声明的来源里');
            await wc.loadURL(p.url); result = {};
          } else {
            if (!methods.has(body.method)) throw Error('不支持这个网页控制命令');
            if (!allowed(wc.getURL(), current.origins)) throw Error('页面已经离开插件声明的来源');
            if (body.method === 'DOM.setFileInputFiles') {
              if (!Array.isArray(p.files) || p.files.length === 0 || p.files.length > 20) throw Error('上传文件列表无效');
              const root = fs.realpathSync(request.project_root);
              p.files = p.files.map(file => {
                if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('上传文件必须在项目里');
                const real = fs.realpathSync(file);
                if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw Error('上传文件必须在项目里');
                return real;
              });
            }
            if (body.method === 'Page.bringToFront') { this.show(current); result = {}; }
            else {
              if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
              result = await wc.debugger.sendCommand(body.method, p);
            }
          }
        }
        if (active) res.end(JSON.stringify(result));
        else res.destroy();
      } catch (error) {
        res.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : '网页操作失败' }));
      } finally { busy = false; }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('无法建立客户端网页连接');
    const dispose = () => {
      active = false;
      server.close(); server.closeAllConnections();
      for (const page of this.pages.values()) if (page.owner === owner) {
        page.owner = undefined;
        const wc = page.contents;
        if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
      }
      this.leases.delete(dispose);
    };
    this.leases.add(dispose);
    return { connection: { endpoint: `http://127.0.0.1:${address.port}/`, token }, dispose };
  }
  private destroyPage(page: EmbeddedPage): void {
    // before-quit 和窗口 closed 都会走这里；销毁只能发生一次。
    if (page.closed) return;
    page.closed = true;
    if (!page.window.isDestroyed()) {
      page.window.contentView.removeChildView(page.view);
      page.window.contentView.removeChildView(page.bar);
    }
    for (const wc of [page.contents, page.controls]) if (!wc.isDestroyed()) {
      wc.stop();
      wc.session.flushStorageData();
      wc.close({ waitForBeforeUnload: false });
    }
  }
  close(): void {
    for (const dispose of this.leases) dispose();
    for (const page of this.pages.values()) this.destroyPage(page);
    this.pages.clear();
  }
}
