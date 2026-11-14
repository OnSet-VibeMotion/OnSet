import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/*
 * 浏览器模式：把客户端自带的 Chromium 借给 HyperFrames 渲染，用户不必再下载约 390 MB 的 chrome-headless-shell。
 *
 * HyperFrames 用 puppeteer 的管道模式启动浏览器（`pipe: true`）：在 fd 3 上写、fd 4 上读，消息是以 NUL 结尾的
 * CDP JSON。Electron 的 CDP 是完整的，唯独不支持浏览器级的 `Target.createTarget`（实测报 Not supported），而
 * HyperFrames 每一帧会话都 `browser.newPage()`。所以这里做一层转发：本进程开一个只听本机的调试端口，把管道上的
 * 消息原样转给它，只拦下新建页面与关闭页面两条，换成开、关一个隐藏的 BrowserWindow。macOS 上 HyperFrames 走截图
 * 取帧（beginFrame 只在 Linux 的 headless-shell 上用），隐藏窗口截图实测正常（中文、WebGL、指定视口）。
 *
 * 启动方是包装脚本（clishim.ts 的 browserScript）：它去掉 puppeteer 加的 `--remote-debugging-pipe` 等参数——
 * 留着的话 Electron 自己也会去占 fd 3/4——再以 ONSET_BROWSER_MODE=1 启动本应用，入口（entry.ts）据此进到这里。
 */

const argv = process.argv.slice(1);

function switchValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

const userData = switchValue('user-data-dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'onset-browser-'));
app.setPath('userData', userData);
const activePortFile = path.join(userData, 'DevToolsActivePort');
fs.rmSync(activePortFile, { force: true });
app.commandLine.appendSwitch('remote-debugging-port', '0');
// 辅助程序：不进 Dock、不抢焦点。只调 dock.hide() 的话图标会先在 Dock 里闪一下，渲染时每开一个浏览器闪一次。
app.setActivationPolicy?.('accessory');

const [windowWidth, windowHeight] = (switchValue('window-size') ?? '1280,720').split(',').map((v) => Number(v) || 0);

// 页面全部关掉也不退出：退出只由 Browser.close 或管道关闭决定，与 Chrome 一致。
app.on('window-all-closed', () => {});

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: unknown;
}

// 和 puppeteer 之间的通道，两种来路：
//   - 由引导脚本接管启动时（Windows，见 engine 的 hyperframes/browserhook.ts）：连 ONSET_BROWSER_PIPE 这条本机命名管道，
//     先报口令（ONSET_BROWSER_TOKEN），之后一条连接双向用；
//   - 由包装脚本启动时（macOS）：puppeteer 的 fd 3（它写、我们读）与 fd 4（我们写、它读）。
// 管道用 net.Socket 读写，不能用 fs 流：fs 流在线程池里阻塞地 read() fd 3，退出时要等这个线程，而 puppeteer
// 正等着本进程退出、不会关管道——两边互等，Browser.close 之后进程永远退不掉（实测）。
function clientChannel(): { toClient: net.Socket; fromClient: net.Socket } {
  const address = process.env.ONSET_BROWSER_PIPE;
  if (address) {
    const socket = net.connect(address);
    socket.write(`${process.env.ONSET_BROWSER_TOKEN ?? ''}\n`);
    return { toClient: socket, fromClient: socket };
  }
  return {
    toClient: new net.Socket({ fd: 4, readable: false, writable: true }),
    fromClient: new net.Socket({ fd: 3, readable: true, writable: false }),
  };
}
const { toClient, fromClient } = clientChannel();

const debug = process.env.ONSET_BROWSER_DEBUG === '1' ? (text: string) => process.stderr.write(`[onset-browser] ${text}\n`) : () => {};

function reply(message: Message): void {
  toClient.write(JSON.stringify(message) + '\0');
}

let upstream: WebSocket | null = null;
const pendingRaw: string[] = [];
/**
 * 本进程自己发给上游的请求：id 取在 puppeteer 用不到的范围里，回复不转给客户端。
 * CDP 的 id 必须是 32 位整数，超出的话 Chromium 不回复（实测 2^40 的请求石沉大海）。
 */
let internalId = 2_000_000_000;
const internal = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function forward(raw: string): void {
  if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(raw);
  else pendingRaw.push(raw);
}

function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = internalId++;
  return new Promise((resolve, reject) => {
    internal.set(id, { resolve: resolve as (v: unknown) => void, reject });
    forward(JSON.stringify({ id, method, params }));
  });
}

/** 由本进程开的页面：targetId → 窗口。 */
const windows = new Map<string, BrowserWindow>();

function newWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: windowWidth || 1280,
    height: windowHeight || 720,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
}

async function pageTargets(): Promise<Array<{ targetId: string; type: string }>> {
  const result = await call('Target.getTargets');
  return (result.targetInfos as Array<{ targetId: string; type: string }>).filter((t) => t.type === 'page');
}

/** 新建页面要串行：靠「新出现的那个 page 目标」认出窗口对应的 targetId。 */
let createChain: Promise<unknown> = Promise.resolve();

function createTarget(url: string): Promise<string> {
  const run = async (): Promise<string> => {
    const before = new Set((await pageTargets()).map((t) => t.targetId));
    const win = newWindow();
    win.loadURL(url || 'about:blank').catch(() => {});
    for (let i = 0; i < 400; i++) {
      const fresh = (await pageTargets()).find((t) => !before.has(t.targetId));
      debug(`createTarget poll ${i} fresh=${fresh?.targetId ?? '-'}`);
      if (fresh) {
        windows.set(fresh.targetId, win);
        win.on('closed', () => windows.delete(fresh.targetId));
        return fresh.targetId;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    win.destroy();
    throw new Error('新建页面超时');
  };
  const next = createChain.then(run, run);
  createChain = next.catch(() => {});
  return next;
}

function handleClient(raw: string): void {
  let message: Message;
  try {
    message = JSON.parse(raw) as Message;
  } catch {
    return;
  }
  debug(`<- ${message.id ?? ''} ${message.method ?? ''} ${message.sessionId ?? ''}`);
  if (message.sessionId === undefined && message.id !== undefined) {
    const id = message.id;
    switch (message.method) {
      case 'Target.createTarget':
        createTarget(String(message.params?.url ?? '')).then(
          (targetId) => reply({ id, result: { targetId } }),
          (err: Error) => reply({ id, error: { code: -32000, message: err.message } }),
        );
        return;
      case 'Target.closeTarget': {
        const win = windows.get(String(message.params?.targetId ?? ''));
        if (win) {
          win.destroy();
          reply({ id, result: { success: true } });
          return;
        }
        break;
      }
      case 'Browser.close':
        reply({ id, result: {} });
        setImmediate(() => app.exit(0));
        return;
    }
  }
  forward(raw);
}

let buffer = Buffer.alloc(0);
fromClient.on('data', (chunk: Buffer | string) => {
  buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
  for (let end = buffer.indexOf(0); end !== -1; end = buffer.indexOf(0)) {
    const raw = buffer.subarray(0, end).toString('utf8');
    buffer = buffer.subarray(end + 1);
    handleClient(raw);
  }
});
// puppeteer 关掉管道（或自己退出）就跟着退出，不留孤儿进程。
fromClient.on('close', () => app.exit(0));
fromClient.on('error', () => app.exit(1));

async function readActivePort(): Promise<string> {
  for (let i = 0; i < 400; i++) {
    try {
      const [port, wsPath] = fs.readFileSync(activePortFile, 'utf8').split('\n');
      if (port && wsPath) return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    } catch {
      // 还没写出来
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Electron 没有写出 DevToolsActivePort');
}

app.whenReady().then(async () => {
  // puppeteer 启动后要等到一个初始页面，Chrome 默认开的 about:blank 就是它。
  newWindow().loadURL('about:blank').catch(() => {});
  let endpoint: string;
  try {
    endpoint = await readActivePort();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    app.exit(1);
    return;
  }
  const ws = new WebSocket(endpoint);
  ws.addEventListener('open', () => {
    upstream = ws;
    for (const raw of pendingRaw.splice(0)) ws.send(raw);
  });
  ws.addEventListener('message', (event) => {
    const raw = String(event.data);
    let message: Message;
    try {
      message = JSON.parse(raw) as Message;
    } catch {
      return;
    }
    if (message.id !== undefined && internal.has(message.id)) {
      const waiter = internal.get(message.id)!;
      internal.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    toClient.write(raw + '\0');
  });
  ws.addEventListener('close', () => app.exit(0));
  ws.addEventListener('error', () => app.exit(1));
});
