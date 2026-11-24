import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import type { StationBrowserLease, StationBrowserRequest } from '@onset/engine/flow';
import { app, type BrowserWindow, session } from 'electron';
import { defaultHint, toolbarDataURL } from './station-browser-cover';
import { createEmbeddedPage, teardownEmbeddedPage } from './station-browser-page';
import {
  allowed,
  assertAccount,
  type Busy,
  type EmbeddedPage,
  executeBrowserCommand,
  FlushIntervalMs,
  loadUntilReady,
  parseBusyParams,
  parseOpenParams,
  readBody,
  sessionDirectory,
} from './station-browser-storage';

export { FlushIntervalMs, loadUntilReady, sessionDirectory, UnloadGraceMs } from './station-browser-storage';

/**
 * 通用网页容器：站点脚本在插件进程里，只能控制本次操作取得的那个账号页面。
 * 每个账号页面单独一个窗口，不盖住片场主窗口：上传要等很久，用户照常在片场里工作，几个插件也能同时上传。
 * 插件自动操作时（busy）页面上盖一层半透明遮罩显示进度，挡住鼠标与键盘，免得用户的点击打乱自动填写；操作结束（连接撤销）自动揭开。
 */
export class StationBrowsers {
  private pages = new Map<string, EmbeddedPage>();
  /** 销毁已开始、还没完成的页面（草稿可能还在写）：页面虽已移出 pages，退出与移除账号仍要等它们。同一账号先后开过几个页面就记几个，互不覆盖。 */
  private closingPages = new Map<string, Set<Promise<void>>>();
  /** 正在移除的账号：存储与缓存清完前拒绝重开（同目录复用同一 Session，清掉会伤及新页面的数据）。 */
  private forgetting = new Set<string>();
  private closePromise?: Promise<void>;
  private leases = new Set<() => void>();
  private flushTimer?: NodeJS.Timeout;

  constructor(
    private getWindow: () => BrowserWindow | undefined,
    private background = false,
  ) {}

  /** 有插件页面开着就定时落盘，没有了就停。 */
  private scheduleFlush(): void {
    if (this.pages.size === 0) {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = undefined;
      }
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), FlushIntervalMs);
    this.flushTimer.unref?.();
  }

  /** 把开着的插件页面的本地存储与 cookie 写到磁盘。 */
  flush(): void {
    const sessions = new Set([...this.pages.values()].filter((page) => !page.closed).map((page) => page.session));
    for (const ses of sessions) {
      ses.flushStorageData();
      void ses.cookies.flushStore().catch(() => {});
    }
  }

  /** 「返回片场」：收起这个窗口（页面与上传都保留），回到主窗口。 */
  private hide(page: EmbeddedPage): void {
    if (page.closed || page.window.isDestroyed()) return;
    page.hidden = true;
    page.window.hide();
    const main = this.getWindow();
    if (main && !main.isDestroyed() && !this.background) {
      main.show();
      main.focus();
    }
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

  private async open(
    request: StationBrowserRequest,
    raw: Record<string, unknown>,
    owner: symbol,
  ): Promise<{ page: EmbeddedPage; reused: boolean }> {
    const { account, label, url, hint } = parseOpenParams(request, raw, defaultHint);
    const key = path.join(request.data_dir, 'web-sessions', account);
    if (this.forgetting.has(key)) throw Error('这个账号正在移除，请稍后再试');
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
    const { page, layout } = createEmbeddedPage(
      { key, account, title, hint, request, owner },
      {
        background: this.background,
        onCreated: (created) => {
          this.pages.set(key, created);
          this.scheduleFlush();
        },
        onFocus: (target) => this.focusPage(target),
        onHide: (target) => this.hide(target),
        onDestroy: (target) => this.destroyPage(target),
      },
    );
    layout();
    this.show(page);
    await this.toolbar(page);
    await loadUntilReady(page.contents, url);
    return { page, reused: false };
  }

  private toolbar(page: EmbeddedPage): Promise<void> {
    return page.controls.loadURL(toolbarDataURL(page.title, page.hint));
  }

  private async forgetAccount(
    request: StationBrowserRequest,
    rawAccount: unknown,
    owner: symbol,
    current: EmbeddedPage | undefined,
  ): Promise<boolean> {
    const account = assertAccount(rawAccount);
    const key = path.join(request.data_dir, 'web-sessions', account);
    if (this.forgetting.has(key)) throw Error('这个账号正在移除，请稍后再试');
    const page = this.pages.get(key);
    if (page && page.owner && page.owner !== owner) throw Error('这个账号正在由另一项操作使用，请稍后再试');
    // 等销毁走完再清存储：网页的关闭流程可能还在写草稿，先清掉会被它写回来（已经在关的页面也要等，一个账号有几个都等）。
    // 清理期间拒绝重开这个账号：同目录复用同一 Session，重开的新页面会被一并清掉。
    this.forgetting.add(key);
    try {
      if (page) await this.closePage(page);
      await Promise.all([...(this.closingPages.get(key) ?? [])]);
      // 移除账号：登录状态由片场保管，一并清掉（插件只删得到它自己 data_dir 里的东西）。
      // clearStorageData 不管 HTTP 缓存：登录后的个人页面可能被缓存，同一账号编号再开时还会显示旧内容。
      const ses = session.fromPath(sessionDirectory(app.getPath('userData'), request.id, account));
      await ses.clearStorageData();
      await ses.clearCache();
      return current === page;
    } finally {
      this.forgetting.delete(key);
    }
  }

  async lease(request: StationBrowserRequest): Promise<StationBrowserLease> {
    const token = randomBytes(32).toString('hex');
    const owner = Symbol();
    let active = true;
    let busy = false;
    let current: EmbeddedPage | undefined;
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      if (
        !active ||
        req.method !== 'POST' ||
        req.url !== '/' ||
        req.headers.origin ||
        req.headers.authorization !== `Bearer ${token}`
      ) {
        res.writeHead(403).end(JSON.stringify({ error: '网页连接已失效或未授权' }));
        return;
      }
      if (busy) {
        res.writeHead(409).end(JSON.stringify({ error: '请等待上一个网页请求完成' }));
        return;
      }
      busy = true;
      try {
        const body = await readBody(req);
        if (!active) throw Error('网页连接已结束');
        let result: unknown;
        if (body.action === 'open') {
          if (current) throw Error('一次操作只控制一个账号页面');
          const opened = await this.open(request, body, owner);
          current = opened.page;
          if (!active) {
            current.owner = undefined;
            throw Error('网页连接已结束');
          }
          result = { reused: opened.reused };
        } else if (body.action === 'state') {
          // 插件等用户登录时轮询：窗口被用户收起（「返回片场」）或关掉，就当用户不登了。
          result = current
            ? {
                open: !current.closed && !current.contents.isDestroyed(),
                visible: !current.closed && !current.hidden,
                busy: !!current.busy,
                url: current.contents.isDestroyed() ? '' : current.contents.getURL(),
              }
            : { open: false, visible: false, busy: false, url: '' };
        } else if (body.action === 'busy') {
          // 插件开始自动操作（上传、填写）：页面上盖半透明遮罩显示进度，用户点不到、按键也进不了页面；active: false 揭开。
          if (!current || current.closed) throw Error('请先打开账号页面');
          await this.setBusy(current, parseBusyParams(body));
          result = {};
        } else if (body.action === 'close') {
          // 关掉本次操作的页面（登录完成后自动回到片场）；登录状态留在账号的存储目录里（sessionDirectory）。
          if (current) {
            void this.closePage(current);
            current = undefined;
          }
          result = {};
        } else if (body.action === 'forget') {
          // 移除账号前关掉那个账号开着的页面：只认本插件数据目录下的账号，别的操作正在用时拒绝。
          if (await this.forgetAccount(request, body.account, owner, current)) current = undefined;
          result = {};
        } else {
          if (!current || current.contents.isDestroyed()) throw Error('请先打开账号页面');
          result = await executeBrowserCommand(current, request, body, {
            navigate: (page, targetUrl) => this.navigate(page, targetUrl),
            show: (page) => this.show(page),
          });
        }
        if (active) res.end(JSON.stringify(result));
        else res.destroy();
      } catch (error) {
        res.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : '网页操作失败' }));
      } finally {
        busy = false;
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('无法建立客户端网页连接');
    const dispose = () => {
      active = false;
      server.close();
      server.closeAllConnections();
      for (const page of this.pages.values()) {
        if (page.owner === owner) {
          page.owner = undefined;
          // 操作结束、取消或插件崩了：遮罩一并揭开，页面留给用户。
          void this.setBusy(page, undefined);
          const wc = page.contents;
          if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
        }
      }
      this.leases.delete(dispose);
    };
    this.leases.add(dispose);
    return { connection: { endpoint: `http://127.0.0.1:${address.port}/`, token }, dispose };
  }

  /** 片场替插件跳转：网页的「确定要离开吗」放行（不然编辑页上的跳转会被拦下）。 */
  private async navigate(page: EmbeddedPage, url: string): Promise<void> {
    page.leaving++;
    try {
      await loadUntilReady(page.contents, url);
    } finally {
      page.leaving--;
    }
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
    page.destroying = teardownEmbeddedPage(page);
    const done = page.destroying;
    const pending = this.closingPages.get(page.key) ?? new Set<Promise<void>>();
    this.closingPages.set(page.key, pending);
    pending.add(done);
    const settled = () => {
      pending.delete(done);
      if (pending.size === 0 && this.closingPages.get(page.key) === pending) this.closingPages.delete(page.key);
    };
    done.then(settled, settled);
    return done;
  }

  /** 退出时：撤销所有连接，关掉所有页面并等它们存完（每个最多 UnloadGraceMs）；已经在关的页面也一并等。重复调用拿同一个 Promise。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    for (const dispose of this.leases) dispose();
    for (const page of this.pages.values()) void this.destroyPage(page);
    this.pages.clear();
    this.scheduleFlush();
    this.closePromise = Promise.all([...this.closingPages.values()].flatMap((pending) => [...pending])).then(() => {});
    return this.closePromise;
  }
}
