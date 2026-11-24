import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { StationBrowserRequest } from '@onset/engine/flow';
import type { BrowserWindow, WebContentsView } from 'electron';

/**
 * 插件能对自己的页面发的 CDP 命令。键盘与鼠标是为了像人一样操作网页：小红书的话题候选靠逐字输入「#」弹出、
 * 要真的点一下才选得中，element.click() 与插入文字都不行。它们只作用于这个页面，能做的不超过 Runtime.evaluate。
 */
const methods = new Set([
  'Page.enable',
  'Page.bringToFront',
  'Runtime.evaluate',
  'Runtime.releaseObject',
  'DOM.setFileInputFiles',
  'Input.insertText',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
]);
const keyTypes = new Set(['keyDown', 'keyUp', 'rawKeyDown', 'char']);
const mouseTypes = new Set(['mouseMoved', 'mousePressed', 'mouseReleased']);

/** 插件正在自动操作页面（上传、填写）时盖在页面上的遮罩：一句说明与进度（0–1，没有就只转圈）。 */
export type Busy = { message: string; progress: number | null };

export type EmbeddedPage = {
  key: string;
  window: BrowserWindow;
  view: WebContentsView;
  bar: WebContentsView;
  mask: WebContentsView;
  contents: Electron.WebContents;
  controls: Electron.WebContents;
  cover: Electron.WebContents;
  coverReady: Promise<unknown>;
  closed: boolean;
  hidden: boolean;
  closing: boolean;
  origins: string[];
  owner?: symbol;
  title: string;
  hint: string;
  busy?: Busy;
  /** 片场自己发起的关闭或跳转（插件的 Page.navigate、关窗口、退出）：网页的「确定要离开吗」直接放行。 */
  leaving: number;
  /** 销毁进行中（等网页走完关闭流程）：重复调用拿同一个。 */
  destroying?: Promise<void>;
  session: Electron.Session;
};

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

export function allowed(url: string, origins: string[]): boolean {
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password && origins.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function assertAccount(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) {
    throw Error('网页账号编号无效');
  }
  return value;
}

export function parseOpenParams(
  request: StationBrowserRequest,
  raw: Record<string, unknown>,
  fallbackHint: string,
): { account: string; label: string; url: string; hint: string } {
  const hint = raw.hint ?? fallbackHint;
  // 工具栏上的一句提示（例如登录时说明登录后会自动回来）；只是文字，宿主照样转义。
  if (typeof hint !== 'string' || !hint.trim() || hint.length > 60 || /[\x00-\x1f]/.test(hint)) {
    throw Error('网页提示无效');
  }
  const account = assertAccount(raw.account);
  const label = raw.label;
  if (typeof label !== 'string' || !label.trim() || label.length > 100) throw Error('网页账号名称无效');
  const url = raw.url;
  if (typeof url !== 'string' || !allowed(url, request.origins)) throw Error('网页地址不在插件声明的来源里');
  return { account, label, url, hint };
}

export function parseBusyParams(body: Record<string, unknown>): Busy | undefined {
  if (body.active === false) return undefined;
  const message = body.message;
  const progress = body.progress ?? null;
  if (typeof message !== 'string' || !message.trim() || message.length > 80 || /[\x00-\x1f]/.test(message)) {
    throw Error('遮罩说明无效');
  }
  if (
    progress !== null &&
    (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1)
  ) {
    throw Error('遮罩进度要在 0 到 1 之间');
  }
  return { message, progress };
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
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
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
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onFail = (_event: Electron.Event, code: number, description: string, _url: string, mainFrame: boolean) => {
      if (mainFrame && code !== -3) finish(Error(`打开网页失败：${description}`));
    };
    wc.on('dom-ready', onReady);
    wc.on('did-fail-load', onFail);
    wc.loadURL(url).then(
      () => finish(),
      (error: Error) => {
        if (!/ERR_ABORTED/.test(String(error))) {
          finish(error);
          return;
        }
        // 被顶掉后没有新页面就绪也别一直挂着：交回插件，由它看页面上有没有要的东西。
        setTimeout(() => finish(), 10_000).unref?.();
      },
    );
  });
}

export async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
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

export async function executeBrowserCommand(
  page: EmbeddedPage,
  request: StationBrowserRequest,
  body: Record<string, unknown>,
  actions: {
    navigate: (page: EmbeddedPage, url: string) => Promise<void>;
    show: (page: EmbeddedPage) => void;
  },
): Promise<unknown> {
  if (body.action !== 'command' || typeof body.method !== 'string') throw Error('网页操作无效');
  const wc = page.contents;
  const params = body.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error('网页操作参数无效');
  const p = params as Record<string, unknown>;
  if (body.method === 'Page.navigate') {
    if (typeof p.url !== 'string' || !allowed(p.url, page.origins)) throw Error('网页地址不在插件声明的来源里');
    await actions.navigate(page, p.url);
    return {};
  }
  if (!methods.has(body.method)) throw Error('不支持这个网页控制命令');
  if (!allowed(wc.getURL(), page.origins)) throw Error('页面已经离开插件声明的来源');
  if (body.method === 'DOM.setFileInputFiles') {
    if (!Array.isArray(p.files) || p.files.length === 0 || p.files.length > 20) throw Error('上传文件列表无效');
    if (!request.project_root) throw Error('没打开项目，不能上传文件');
    const root = fs.realpathSync(request.project_root);
    p.files = p.files.map((file) => {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('上传文件必须在项目里');
      const real = fs.realpathSync(file);
      if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw Error('上传文件必须在项目里');
      return real;
    });
  }
  if (body.method === 'Input.dispatchKeyEvent' && !keyTypes.has(String(p.type))) throw Error('键盘事件无效');
  if (
    body.method === 'Input.dispatchMouseEvent' &&
    (!mouseTypes.has(String(p.type)) || typeof p.x !== 'number' || typeof p.y !== 'number')
  ) {
    throw Error('鼠标事件无效');
  }
  if (body.method === 'Page.bringToFront') {
    actions.show(page);
    return {};
  }
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  return wc.debugger.sendCommand(body.method, p);
}
