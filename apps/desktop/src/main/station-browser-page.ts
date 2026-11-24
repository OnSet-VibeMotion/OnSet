import { randomBytes } from 'node:crypto';
import type { StationBrowserRequest } from '@onset/engine/flow';
import { app, BrowserWindow, dialog, session, WebContentsView } from 'electron';
import { pluginWindows } from './pluginwindows';
import { barHeight, coverDataURL } from './station-browser-cover';
import { allowed, type EmbeddedPage, loadUntilReady, sessionDirectory, UnloadGraceMs } from './station-browser-storage';

export type PageLifecycleHooks = {
  background: boolean;
  onCreated: (page: EmbeddedPage) => void;
  onFocus: (page: EmbeddedPage) => void;
  onHide: (page: EmbeddedPage) => void;
  onDestroy: (page: EmbeddedPage) => Promise<void>;
};

export function createEmbeddedPage(
  params: {
    key: string;
    account: string;
    title: string;
    hint: string;
    request: StationBrowserRequest;
    owner: symbol;
  },
  hooks: PageLifecycleHooks,
): { page: EmbeddedPage; layout: () => void } {
  const { key, account, title, hint, request, owner } = params;
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    title,
    show: false,
    backgroundColor: '#171614',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: `station-frame-${randomBytes(12).toString('hex')}`,
    },
  });
  pluginWindows.add(window);
  window.setMenuBarVisibility(false);
  const storage = session.fromPath(sessionDirectory(app.getPath('userData'), request.id, account));
  storage.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  storage.setPermissionCheckHandler(() => false);
  storage.on('will-download', (event) => event.preventDefault());
  const view = new WebContentsView({
    webPreferences: {
      session: storage,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  const defaultUA = view.webContents.getUserAgent();
  const chromiumUA = defaultUA
    .replace(` ${app.getName()}/${app.getVersion()}`, '')
    .replace(` Electron/${process.versions.electron}`, '');
  if (chromiumUA !== defaultUA) view.webContents.setUserAgent(chromiumUA);
  const chrome = (prefix: string) =>
    new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: `${prefix}-${randomBytes(12).toString('hex')}`,
      },
    });
  const bar = chrome('station-toolbar');
  const mask = chrome('station-mask');
  mask.setBackgroundColor('#00000000');
  mask.setVisible(false);
  // 关闭后 View.webContents 可能变成 undefined；必须保存 WebContents 的稳定引用。
  const page: EmbeddedPage = {
    key,
    window,
    view,
    bar,
    mask,
    contents: view.webContents,
    controls: bar.webContents,
    cover: mask.webContents,
    coverReady: Promise.resolve(),
    closed: false,
    hidden: false,
    closing: false,
    origins: request.origins,
    owner,
    title,
    hint,
    leaving: 0,
    session: storage,
  };
  hooks.onCreated(page);
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
  window.on('focus', () => hooks.onFocus(page));
  // 用户点关闭：不让窗口当场关掉，交给 destroyPage 先藏起窗口、等网页存完再销毁。
  // 插件正在自动操作时关窗口会打断上传：先问一句（测试在后台跑，不弹框）。
  window.on('close', (event) => {
    if (page.closed) return;
    event.preventDefault();
    if (!page.busy || page.closing || hooks.background) {
      void hooks.onDestroy(page);
      return;
    }
    page.closing = true;
    void dialog
      .showMessageBox(window, {
        type: 'warning',
        buttons: ['继续等待', '关闭窗口'],
        defaultId: 0,
        cancelId: 0,
        message: '插件正在自动操作这个页面',
        detail: '关闭窗口会中断正在进行的上传与填写，已传的内容可能需要重新上传。',
      })
      .then(({ response }) => {
        page.closing = false;
        if (response === 1 && !window.isDestroyed()) void hooks.onDestroy(page);
      });
  });
  window.once('closed', () => void hooks.onDestroy(page));
  page.contents.once('destroyed', () => void hooks.onDestroy(page));
  // 网页在 beforeunload 里要求确认离开（抖音存完草稿会这样做）。片场自己关、自己跳转时直接放行；
  // 用户在网页里点的跳转照网页的意思问一句（后台运行的测试里不弹框，直接放行）。不处理的话 Electron 默认当作取消，
  // 插件把编辑页跳回上传页、关窗口都会被拦住。
  page.contents.on('will-prevent-unload', (event) => {
    if (page.leaving > 0 || page.closed || hooks.background) {
      event.preventDefault();
      return;
    }
    const choice = dialog.showMessageBoxSync(page.window, {
      type: 'question',
      buttons: ['离开', '留下'],
      defaultId: 1,
      cancelId: 1,
      message: '离开这个页面吗？',
      detail: '网页提示离开后，正在编辑的内容可能不会保存。',
    });
    if (choice === 0) event.preventDefault();
  });
  const guardNavigation = (event: Electron.Event, targetUrl: string) => {
    if (!allowed(targetUrl, page.origins)) event.preventDefault();
  };
  page.contents.on('will-navigate', guardNavigation);
  page.contents.on('will-redirect', guardNavigation);
  page.contents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (allowed(targetUrl, page.origins)) void loadUntilReady(page.contents, targetUrl).catch(() => {});
    return { action: 'deny' };
  });
  // 返回片场只收起窗口，用户填到一半的内容、正在进行的上传都不会丢。
  page.controls.on('will-navigate', (event, targetUrl) => {
    event.preventDefault();
    if (targetUrl === 'https://onset.invalid/return') hooks.onHide(page);
  });
  for (const wc of [page.controls, page.cover]) {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
  page.cover.on('will-navigate', (event) => event.preventDefault());
  page.coverReady = page.cover.loadURL(coverDataURL()).catch(() => {});
  return { page, layout };
}

export async function teardownEmbeddedPage(page: EmbeddedPage): Promise<void> {
  for (const wc of [page.controls, page.cover]) {
    if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false });
  }
  const wc = page.contents;
  if (!wc.isDestroyed()) {
    if (wc.debugger.isAttached()) {
      try {
        wc.debugger.detach();
      } catch {
        /* 已经断开 */
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false });
        resolve();
      }, UnloadGraceMs);
      wc.once('destroyed', () => {
        clearTimeout(timer);
        resolve();
      });
      wc.close({ waitForBeforeUnload: true });
    });
  }
  // 网页刚在关闭时写的本地存储（草稿）与登录 cookie 马上落盘：平时攒一阵才写，客户端退出时就丢了。
  page.session.flushStorageData();
  await page.session.cookies.flushStore().catch(() => {});
  if (!page.window.isDestroyed()) page.window.destroy();
}
