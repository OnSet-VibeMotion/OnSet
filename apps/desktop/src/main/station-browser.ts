import { BrowserWindow, WebContentsView, app, dialog, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { StationBrowserLease, StationBrowserRequest } from '@onset/engine/flow';
import { pluginWindows } from './pluginwindows';

/**
 * 插件能对自己的页面发的 CDP 命令。键盘与鼠标是为了像人一样操作网页：小红书的话题候选靠逐字输入「#」弹出、
 * 要真的点一下才选得中，element.click() 与插入文字都不行。它们只作用于这个页面，能做的不超过 Runtime.evaluate。
 */
const methods = new Set(['Page.enable', 'Page.bringToFront', 'Runtime.evaluate', 'Runtime.releaseObject', 'DOM.setFileInputFiles', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent']);
const keyTypes = new Set(['keyDown', 'keyUp', 'rawKeyDown', 'char']);
const mouseTypes = new Set(['mouseMoved', 'mousePressed', 'mouseReleased']);
const escapeHTML = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** 插件正在自动操作页面（上传、填写）时盖在页面上的遮罩：一句说明与进度（0–1，没有就只转圈）。 */
type Busy = { message: string; progress: number | null };
type EmbeddedPage = {
  key: string; window: BrowserWindow; view: WebContentsView; bar: WebContentsView; mask: WebContentsView;
  contents: Electron.WebContents; controls: Electron.WebContents; cover: Electron.WebContents; coverReady: Promise<unknown>;
  closed: boolean; hidden: boolean; closing: boolean; origins: string[]; owner?: symbol; title: string; hint: string; busy?: Busy;
  /** 片场自己发起的关闭或跳转（插件的 Page.navigate、关窗口、退出）：网页的「确定要离开吗」直接放行。 */
  leaving: number;
  /** 销毁进行中（等网页走完关闭流程）：重复调用拿同一个。 */
  destroying?: Promise<void>;
  session: Electron.Session;
};
const defaultHint = '请检查账号与内容，发布由你确认';
const barHeight = 56;
/**
 * 关页面前给网页多久走完关闭流程（beforeunload、pagehide）。抖音的编辑页只在 beforeunload 里把编辑中的内容存成草稿
 * （publish_form_cache，2026-11-19 在它的前端代码里核对过），直接销毁页面草稿就没了。
 */
export const UnloadGraceMs = 3000;
/**
 * 插件页面开着时多久把它们的本地存储与 cookie 写一次盘。Chromium 平时把网页写的本地存储攒在内存里，过一阵才落盘
 * （实测抖音草稿在磁盘上能落后几分钟），客户端崩溃或被强退就丢了。网页往浏览器里写了什么，几秒内就该在磁盘上。
 */
export const FlushIntervalMs = 5000;

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
/**
 * 导航到地址，页面结构就绪（dom-ready）就返回，不等图片、统计脚本这些全部加载完：插件本来就会自己等要用的元素出现。
 * 抖音创作者中心整页加载完要 3–4 秒，结构就绪不到 1 秒（2026-11-19 实测）。主框架加载失败照样报错；
 * 被页面自己的跳转顶掉（ERR_ABORTED）不算失败，等新页面就绪（最多 10 秒）。
 */
export function loadUntilReady(wc: Electron.WebContents, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      wc.removeListener('dom-ready', onReady);
      wc.removeListener('did-fail-load', onFail);
      if (error) reject(error); else resolve();
    };
    const onReady = () => finish();
    const onFail = (_event: Electron.Event, code: number, description: string, _url: string, mainFrame: boolean) => {
      if (mainFrame && code !== -3) finish(Error(`打开网页失败：${description}`));
    };
    wc.on('dom-ready', onReady);
    wc.on('did-fail-load', onFail);
    wc.loadURL(url).then(() => finish(), (error: Error) => {
      if (!/ERR_ABORTED/.test(String(error))) { finish(error); return; }
      // 被顶掉后没有新页面就绪也别一直挂着：交回插件，由它看页面上有没有要的东西。
      setTimeout(() => finish(), 10_000).unref?.();
    });
  });
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

/**
 * 通用网页容器：站点脚本在插件进程里，只能控制本次操作取得的那个账号页面。
 * 每个账号页面单独一个窗口，不盖住片场主窗口：上传要等很久，用户照常在片场里工作，几个插件也能同时上传。
 * 插件自动操作时（busy）页面上盖一层半透明遮罩显示进度，挡住鼠标与键盘，免得用户的点击打乱自动填写；操作结束（连接撤销）自动揭开。
 */
export class StationBrowsers {
  private pages = new Map<string, EmbeddedPage>();
  /** 销毁已开始、还没完成的页面（草稿可能还在写）：页面虽已移出 pages，退出与移除账号仍要等它们。 */
  private closingPages = new Map<string, Promise<void>>();
  private closePromise?: Promise<void>;
  private leases = new Set<() => void>();
  private flushTimer?: NodeJS.Timeout;
  constructor(private getWindow: () => BrowserWindow | undefined, private background = false) {}

  /** 有插件页面开着就定时落盘，没有了就停。 */
  private scheduleFlush(): void {
    if (this.pages.size === 0) {
      if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = undefined; }
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), FlushIntervalMs);
    this.flushTimer.unref?.();
  }
  /** 把开着的插件页面的本地存储与 cookie 写到磁盘。 */
  flush(): void {
    const sessions = new Set([...this.pages.values()].filter(page => !page.closed).map(page => page.session));
    for (const session of sessions) {
      session.flushStorageData();
      void session.cookies.flushStore().catch(() => {});
    }
  }

  /** 「返回片场」：收起这个窗口（页面与上传都保留），回到主窗口。 */
  private hide(page: EmbeddedPage): void {
    if (page.closed || page.window.isDestroyed()) return;
    page.hidden = true;
    page.window.hide();
    const main = this.getWindow();
    if (main && !main.isDestroyed() && !this.background) { main.show(); main.focus(); }
  }
  private show(page: EmbeddedPage): void {
    if (page.closed || page.window.isDestroyed() || page.contents.isDestroyed()) throw Error('客户端网页已关闭');
    page.hidden = false;
    if (!this.background) {
      if (page.window.isMinimized()) page.window.restore();
      page.window.show();
      page.window.focus();
    }
    this.focusPage(page);
  }
  /** 有遮罩时焦点给遮罩：用户的按键不进页面。 */
  private focusPage(page: EmbeddedPage): void {
    if (page.closed) return;
    const target = page.busy ? page.cover : page.contents;
    if (!target.isDestroyed()) target.focus();
  }
  private async setBusy(page: EmbeddedPage, busy: Busy | undefined): Promise<void> {
    if (page.closed) return;
    page.busy = busy;
    page.mask.setVisible(!!busy);
    if (busy) {
      await page.coverReady;
      if (!page.closed && page.busy === busy && !page.cover.isDestroyed()) {
        await page.cover.executeJavaScript(`update(${JSON.stringify(busy)})`).catch(() => {});
      }
    }
    if (!page.window.isDestroyed() && page.window.isFocused()) this.focusPage(page);
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
    if (existing && !existing.closed && !existing.contents.isDestroyed()) {
      if (existing.owner && existing.owner !== owner) throw Error('这个账号正在由另一项操作填写，请稍后再试');
      // 插件更新可能收窄来源，复用时不能保留旧的放行表。
      existing.origins = request.origins;
      existing.owner = owner;
      existing.title = `${request.name} · ${label}`;
      existing.hint = hint;
      existing.window.setTitle(existing.title);
      await this.toolbar(existing);
      if (!allowed(existing.contents.getURL(), request.origins)) await this.navigate(existing, url);
      this.show(existing);
      return { page: existing, reused: true };
    }
    const title = `${request.name} · ${label}`;
    const window = new BrowserWindow({
      width: 1280, height: 860, minWidth: 820, minHeight: 560, title, show: false, backgroundColor: '#171614', autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `station-frame-${randomBytes(12).toString('hex')}` },
    });
    pluginWindows.add(window);
    window.setMenuBarVisibility(false);
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
    const chrome = (prefix: string) => new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `${prefix}-${randomBytes(12).toString('hex')}` } });
    const bar = chrome('station-toolbar');
    const mask = chrome('station-mask');
    mask.setBackgroundColor('#00000000');
    mask.setVisible(false);
    // 关闭后 View.webContents 可能变成 undefined；必须保存 WebContents 的稳定引用。
    const page: EmbeddedPage = {
      key, window, view, bar, mask, contents: view.webContents, controls: bar.webContents, cover: mask.webContents, coverReady: Promise.resolve(),
      closed: false, hidden: false, closing: false, origins: request.origins, owner, title, hint, leaving: 0, session: storage,
    };
    this.pages.set(key, page);
    this.scheduleFlush();
    window.contentView.addChildView(view);
    window.contentView.addChildView(bar);
    window.contentView.addChildView(mask);
    const layout = () => {
      if (window.isDestroyed()) return;
      const [width, height] = window.getContentSize();
      bar.setBounds({ x: 0, y: 0, width, height: barHeight });
      const body = { x: 0, y: barHeight, width, height: Math.max(0, height - barHeight) };
      view.setBounds(body);
      mask.setBounds(body);
    };
    window.on('resize', layout);
    window.on('focus', () => this.focusPage(page));
    // 插件正在自动操作时关窗口会打断上传：先问一句（测试在后台跑，不弹框）。
    // 用户点关闭：不让窗口当场关掉，交给 destroyPage 先藏起窗口、等网页存完再销毁。
    // 插件正在自动操作时关窗口会打断上传：先问一句（测试在后台跑，不弹框）。
    window.on('close', event => {
      if (page.closed) return;
      event.preventDefault();
      if (!page.busy || page.closing || this.background) { void this.destroyPage(page); return; }
      page.closing = true;
      void dialog.showMessageBox(window, {
        type: 'warning', buttons: ['继续等待', '关闭窗口'], defaultId: 0, cancelId: 0,
        message: '插件正在自动操作这个页面', detail: '关闭窗口会中断正在进行的上传与填写，已传的内容可能需要重新上传。',
      }).then(({ response }) => {
        page.closing = false;
        if (response === 1 && !window.isDestroyed()) void this.destroyPage(page);
      });
    });
    window.once('closed', () => void this.destroyPage(page));
    page.contents.once('destroyed', () => void this.destroyPage(page));
    // 网页在 beforeunload 里要求确认离开（抖音存完草稿会这样做）。片场自己关、自己跳转时直接放行；
    // 用户在网页里点的跳转照网页的意思问一句（后台运行的测试里不弹框，直接放行）。不处理的话 Electron 默认当作取消，
    // 插件把编辑页跳回上传页、关窗口都会被拦住。
    page.contents.on('will-prevent-unload', event => {
      if (page.leaving > 0 || page.closed || this.background) { event.preventDefault(); return; }
      const choice = dialog.showMessageBoxSync(page.window, {
        type: 'question', buttons: ['离开', '留下'], defaultId: 1, cancelId: 1,
        message: '离开这个页面吗？', detail: '网页提示离开后，正在编辑的内容可能不会保存。',
      });
      if (choice === 0) event.preventDefault();
    });
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (!allowed(url, page.origins)) event.preventDefault();
    };
    page.contents.on('will-navigate', guardNavigation);
    page.contents.on('will-redirect', guardNavigation);
    page.contents.setWindowOpenHandler(({ url }) => {
      if (allowed(url, page.origins)) void loadUntilReady(page.contents, url).catch(() => {});
      return { action: 'deny' };
    });
    // 返回片场只收起窗口，用户填到一半的内容、正在进行的上传都不会丢。
    page.controls.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === 'https://onset.invalid/return') this.hide(page);
    });
    for (const wc of [page.controls, page.cover]) {
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
    page.cover.on('will-navigate', event => event.preventDefault());
    page.coverReady = page.cover.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(coverHTML)).catch(() => {});
    layout();
    this.show(page);
    await this.toolbar(page);
    await loadUntilReady(page.contents, url);
    return { page, reused: false };
  }
  private toolbar(page: EmbeddedPage): Promise<void> {
    return page.controls.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;background:#171614;color:#f4eee4;font:14px system-ui;display:flex;align-items:center;gap:20px;height:${barHeight}px;padding:0 20px;box-sizing:border-box;user-select:none}a{color:inherit;text-decoration:none;border:1px solid #666057;padding:6px 14px;border-radius:20px;white-space:nowrap}strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}small{color:#c0b7a9;white-space:nowrap}</style><a href="https://onset.invalid/return">返回片场</a><strong>${escapeHTML(page.title)}</strong><small>${escapeHTML(page.hint)}</small>`));
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
          // 插件等用户登录时轮询：窗口被用户收起（「返回片场」）或关掉，就当用户不登了。
          result = current ? { open: !current.closed && !current.contents.isDestroyed(), visible: !current.closed && !current.hidden, busy: !!current.busy, url: current.contents.isDestroyed() ? '' : current.contents.getURL() } : { open: false, visible: false, busy: false, url: '' };
        } else if (body.action === 'busy') {
          // 插件开始自动操作（上传、填写）：页面上盖半透明遮罩显示进度，用户点不到、按键也进不了页面；active: false 揭开。
          if (!current || current.closed) throw Error('请先打开账号页面');
          if (body.active === false) await this.setBusy(current, undefined);
          else {
            const message = body.message, progress = body.progress ?? null;
            if (typeof message !== 'string' || !message.trim() || message.length > 80 || /[\x00-\x1f]/.test(message)) throw Error('遮罩说明无效');
            if (progress !== null && (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1)) throw Error('遮罩进度要在 0 到 1 之间');
            await this.setBusy(current, { message, progress });
          }
          result = {};
        } else if (body.action === 'close') {
          // 关掉本次操作的页面（登录完成后自动回到片场）；登录状态留在账号的存储目录里（sessionDirectory）。
          if (current) { void this.closePage(current); current = undefined; }
          result = {};
        } else if (body.action === 'forget') {
          // 移除账号前关掉那个账号开着的页面：只认本插件数据目录下的账号，别的操作正在用时拒绝。
          const account = body.account;
          if (typeof account !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(account)) throw Error('网页账号编号无效');
          const key = path.join(request.data_dir, 'web-sessions', account);
          const page = this.pages.get(key);
          if (page && page.owner && page.owner !== owner) throw Error('这个账号正在由另一项操作使用，请稍后再试');
          // 等销毁走完再清存储：网页的关闭流程可能还在写草稿，先清掉会被它写回来（已经在关的页面也要等）。
          if (page) await this.closePage(page);
          await this.closingPages.get(key);
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
            await this.navigate(current, p.url); result = {};
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
        // 操作结束、取消或插件崩了：遮罩一并揭开，页面留给用户。
        void this.setBusy(page, undefined);
        const wc = page.contents;
        if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
      }
      this.leases.delete(dispose);
    };
    this.leases.add(dispose);
    return { connection: { endpoint: `http://127.0.0.1:${address.port}/`, token }, dispose };
  }
  /** 片场替插件跳转：网页的「确定要离开吗」放行（不然编辑页上的跳转会被拦下）。 */
  private async navigate(page: EmbeddedPage, url: string): Promise<void> {
    page.leaving++;
    try { await loadUntilReady(page.contents, url); } finally { page.leaving--; }
  }
  private closePage(page: EmbeddedPage): Promise<void> {
    const wc = page.contents;
    if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
    const destroying = this.destroyPage(page);
    const main = this.getWindow();
    if (main && !main.isDestroyed() && !this.background) main.focus();
    return destroying;
  }
  /**
   * 关掉一个页面：窗口先藏起来（用户看到的是马上关了），网页在后台正常走完关闭流程（beforeunload / pagehide，
   * 最多 UnloadGraceMs），网站借此保存草稿；再把本地存储与 cookie 写到磁盘，写完才真正销毁窗口。
   * 用户点关闭、插件关页面、移除账号、退出都走这里，只做一次。
   */
  private destroyPage(page: EmbeddedPage): Promise<void> {
    if (page.destroying) return page.destroying;
    page.closed = true;
    page.busy = undefined;
    page.leaving++;
    if (this.pages.get(page.key) === page) this.pages.delete(page.key);
    this.scheduleFlush();
    if (!page.window.isDestroyed()) page.window.hide();
    page.destroying = (async () => {
      for (const wc of [page.controls, page.cover]) if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false });
      const wc = page.contents;
      if (!wc.isDestroyed()) {
        if (wc.debugger.isAttached()) { try { wc.debugger.detach(); } catch { /* 已经断开 */ } }
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); resolve(); }, UnloadGraceMs);
          wc.once('destroyed', () => { clearTimeout(timer); resolve(); });
          wc.close({ waitForBeforeUnload: true });
        });
      }
      // 网页刚在关闭时写的本地存储（草稿）与登录 cookie 马上落盘：平时攒一阵才写，客户端退出时就丢了。
      page.session.flushStorageData();
      await page.session.cookies.flushStore().catch(() => {});
      if (!page.window.isDestroyed()) page.window.destroy();
    })();
    const done = page.destroying;
    this.closingPages.set(page.key, done);
    const settled = () => { if (this.closingPages.get(page.key) === done) this.closingPages.delete(page.key); };
    done.then(settled, settled);
    return done;
  }
  /** 退出时：撤销所有连接，关掉所有页面并等它们存完（每个最多 UnloadGraceMs）；已经在关的页面也一并等。重复调用拿同一个 Promise。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    for (const dispose of this.leases) dispose();
    for (const page of this.pages.values()) this.destroyPage(page);
    this.pages.clear();
    this.scheduleFlush();
    this.closePromise = Promise.all([...this.closingPages.values()]).then(() => {});
    return this.closePromise;
  }
}

/** 遮罩页：只有宿主写的这一页，文字经 update() 用 textContent 填，不拼 HTML。 */
const coverHTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%}
body{background:rgba(12,11,10,.6);display:flex;align-items:center;justify-content:center;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#f4eee4;cursor:progress;user-select:none}
.card{width:min(440px,calc(100vw - 64px));box-sizing:border-box;background:rgba(26,24,22,.94);border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:26px 28px 22px;box-shadow:0 24px 64px rgba(0,0,0,.5)}
.top{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.spin{flex:none;width:18px;height:18px;border:2px solid rgba(244,238,228,.2);border-top-color:#e8a24a;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:15px;font-weight:600;margin:0;letter-spacing:.02em}
#message{color:#ddd5c8;margin:0 0 16px;line-height:1.55;min-height:22px;word-break:break-all}
.track{height:6px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}
#bar{height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,#e8a24a,#f3c784);transition:width .5s ease}
.track.wait #bar{width:32%;animation:wait 1.4s ease-in-out infinite}
@keyframes wait{from{transform:translateX(-100%)}to{transform:translateX(320%)}}
.foot{margin:12px 0 0;color:#a49b8e;font-size:12px}
</style>
<div class="card" role="status" aria-live="polite"><div class="top"><div class="spin"></div><h1>插件正在自动操作，请勿操作此页面</h1></div>
<p id="message"></p><div class="track wait" id="track"><div id="bar"></div></div>
<p class="foot">完成后自动解开，可以先回片场继续工作</p></div>
<script>
window.update = function (state) {
  document.getElementById('message').textContent = state.message;
  // 进度条是整次操作的进度；这一步走到哪（例如上传百分比）写在说明里。
  var track = document.getElementById('track');
  track.className = typeof state.progress === 'number' ? 'track' : 'track wait';
  document.getElementById('bar').style.width = typeof state.progress === 'number' ? Math.round(state.progress * 100) + '%' : '';
};
</script>`;
