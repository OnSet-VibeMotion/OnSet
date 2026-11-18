import { BrowserWindow, WebContentsView, app, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { StationBrowserLease, StationBrowserRequest } from '@onset/engine/flow';

/**
 * 插件能对自己的页面发的 CDP 命令。键盘与鼠标是为了像人一样操作网页：小红书的话题候选靠逐字输入「#」弹出、
 * 要真的点一下才选得中，element.click() 与插入文字都不行。它们只作用于这个页面，能做的不超过 Runtime.evaluate。
 */
const methods = new Set(['Page.enable', 'Page.bringToFront', 'Runtime.evaluate', 'Runtime.releaseObject', 'DOM.setFileInputFiles', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent']);
const keyTypes = new Set(['keyDown', 'keyUp', 'rawKeyDown', 'char']);
const mouseTypes = new Set(['mouseMoved', 'mousePressed', 'mouseReleased']);
const escapeHTML = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type EmbeddedPage = { key: string; view: WebContentsView; bar: WebContentsView; contents: Electron.WebContents; controls: Electron.WebContents; closed: boolean; hidden: boolean; window: BrowserWindow; origins: string[]; owner?: symbol; title: string; hint: string; layout?: () => void };
const defaultHint = '请检查账号与内容，发布由你确认';

function allowed(url: string, origins: string[]): boolean {
  try { const parsed = new URL(url); return !parsed.username && !parsed.password && origins.includes(parsed.origin); } catch { return false; }
}
/*
 * 插件内嵌网页的登录存储（每个插件、每个账号一份）放在应用数据目录下：<userData>/station-sessions/<插件>/<账号>。
 * session.fromPath 只有路径在 userData 里才把 cookie 写盘（Electron 45 实测）；以前放在插件的 data_dir 下，
 * 只存下了 Local Storage，登录拿到的 cookie 只在内存里，客户端一重启「选了账号还要登录」。
 */
export function sessionDirectory(userData: string, station: string, account: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(station)) throw Error('插件编号无效');
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  let dir = fs.realpathSync(userData);
  for (const name of ['station-sessions', station, account]) {
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
    page.hidden = true;
    page.view.setVisible(false);
    page.bar.setVisible(false);
    if (!page.window.isDestroyed()) page.window.webContents.focus();
  }
  private show(page: EmbeddedPage): void {
    if (page.closed || page.window.isDestroyed() || page.contents.isDestroyed()) throw Error('客户端网页已关闭');
    for (const other of this.pages.values()) if (other.window === page.window) this.hide(other);
    page.hidden = false;
    page.view.setVisible(true);
    page.bar.setVisible(true);
    if (!this.background) { page.window.show(); page.window.focus(); }
    page.contents.focus();
  }
  private async open(request: StationBrowserRequest, raw: Record<string, unknown>, owner: symbol): Promise<{ page: EmbeddedPage; reused: boolean }> {
    const account = raw.account, label = raw.label, url = raw.url, hint = raw.hint ?? defaultHint;
    // 工具栏上的一句提示（例如登录时说明登录后会自动回来）；只是文字，宿主照样转义。
    if (typeof hint !== 'string' || !hint.trim() || hint.length > 60 || /[\x00-\x1f]/.test(hint)) throw Error('网页提示无效');
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
      existing.hint = hint;
      await this.toolbar(existing);
      if (!allowed(existing.contents.getURL(), request.origins)) await existing.contents.loadURL(url);
      this.show(existing);
      return { page: existing, reused: true };
    }
    const window = this.getWindow();
    if (!window) throw Error('请先打开片场主窗口');
    const storage = session.fromPath(sessionDirectory(app.getPath('userData'), request.id, account));
    storage.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    storage.setPermissionCheckHandler(() => false);
    storage.on('will-download', event => event.preventDefault());
    const view = new WebContentsView({ webPreferences: { session: storage, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    const defaultUA = view.webContents.getUserAgent();
    const chromiumUA = defaultUA
      .replace(` ${app.getName()}/${app.getVersion()}`, '')
      .replace(` Electron/${process.versions.electron}`, '');
    if (chromiumUA !== defaultUA) view.webContents.setUserAgent(chromiumUA);
    const bar = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `station-toolbar-${randomBytes(12).toString('hex')}` } });
    // 关闭后 View.webContents 可能变成 undefined；必须保存 WebContents 的稳定引用。
    const page: EmbeddedPage = { key, view, bar, contents: view.webContents, controls: bar.webContents, closed: false, hidden: false, window, origins: request.origins, owner, title: `${request.name} · ${label}`, hint };
    this.pages.set(key, page);
    window.contentView.addChildView(view);
    window.contentView.addChildView(bar);
    const layout = () => {
      const [width, height] = window.getContentSize();
      bar.setBounds({ x: 0, y: 0, width, height: 74 });
      view.setBounds({ x: 0, y: 74, width, height: Math.max(0, height - 74) });
    };
    page.layout = layout;
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
    return page.controls.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;background:#171614;color:#f4eee4;font:14px system-ui;display:flex;align-items:center;gap:20px;height:74px;padding:0 24px 0 96px;box-sizing:border-box}a{color:inherit;text-decoration:none;border:1px solid #666057;padding:8px 16px;border-radius:24px}strong{flex:1}small{color:#c0b7a9}</style><a href="https://onset.invalid/return">返回片场</a><strong>${escapeHTML(page.title)}</strong><small>${escapeHTML(page.hint)}</small>`));
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
        } else if (body.action === 'state') {
          // 插件等用户登录时轮询：窗口被用户收起或关掉，就当用户不登了。
          result = current ? { open: !current.closed && !current.contents.isDestroyed(), visible: !current.closed && !current.hidden, url: current.contents.isDestroyed() ? '' : current.contents.getURL() } : { open: false, visible: false, url: '' };
        } else if (body.action === 'close') {
          // 关掉本次操作的页面（登录完成后自动回到片场）；登录状态留在账号的存储目录里（sessionDirectory）。
          if (current) { this.closePage(current); current = undefined; }
          result = {};
        } else if (body.action === 'forget') {
          // 移除账号前关掉那个账号开着的页面：只认本插件数据目录下的账号，别的操作正在用时拒绝。
          const account = body.account;
          if (typeof account !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(account)) throw Error('网页账号编号无效');
          const page = this.pages.get(path.join(request.data_dir, 'web-sessions', account));
          if (page && page.owner && page.owner !== owner) throw Error('这个账号正在由另一项操作使用，请稍后再试');
          if (page) this.closePage(page);
          if (current === page) current = undefined;
          // 移除账号：登录状态由片场保管，一并清掉（插件只删得到它自己 data_dir 里的东西）。
          // clearStorageData 不管 HTTP 缓存：登录后的个人页面可能被缓存，同一账号编号再开时还会显示旧内容。
          const ses = session.fromPath(sessionDirectory(app.getPath('userData'), request.id, account));
          await ses.clearStorageData();
          await ses.clearCache();
          result = {};
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
              if (!request.project_root) throw Error('没打开项目，不能上传文件');
              const root = fs.realpathSync(request.project_root);
              p.files = p.files.map(file => {
                if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('上传文件必须在项目里');
                const real = fs.realpathSync(file);
                if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw Error('上传文件必须在项目里');
                return real;
              });
            }
            if (body.method === 'Input.dispatchKeyEvent' && !keyTypes.has(String(p.type))) throw Error('键盘事件无效');
            if (body.method === 'Input.dispatchMouseEvent' && (!mouseTypes.has(String(p.type)) || typeof p.x !== 'number' || typeof p.y !== 'number')) throw Error('鼠标事件无效');
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
  private closePage(page: EmbeddedPage): void {
    const wc = page.contents;
    if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
    if (page.layout && !page.window.isDestroyed()) page.window.removeListener('resize', page.layout);
    this.destroyPage(page);
    this.pages.delete(page.key);
    if (!page.window.isDestroyed()) page.window.webContents.focus();
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
      // 登录状态马上落盘：cookie 平时攒一阵才写，客户端被强退时刚登录的就丢了。
      wc.session.flushStorageData();
      void wc.session.cookies.flushStore().catch(() => {});
      wc.close({ waitForBeforeUnload: false });
    }
  }
  close(): void {
    for (const dispose of this.leases) dispose();
    for (const page of this.pages.values()) this.destroyPage(page);
    this.pages.clear();
  }
}
