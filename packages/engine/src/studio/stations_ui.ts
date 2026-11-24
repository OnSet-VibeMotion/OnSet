/**
 * 插件页面、媒体代理与客户端 SDK（/station-ui、/station-media、/api/stations/{id}/read）。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as flow from '../flow';
import { isEnvFile } from './api_ui';
import { goMap, methodNotAllowed, notFound, serveFile, writeError, writeJSON } from './http';
import { containedPath } from './sessions';
import { petPageIDs } from './skins';

/** 插件页面的地址：/station-ui/<站>/<entry>。 */
export function pageURL(stationID: string, entry: string): string {
  return `/station-ui/${encodeURIComponent(stationID)}/${entry.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 插件页面的内容安全策略。页面在 sandbox="allow-scripts"（不给 allow-same-origin）的 iframe 里，是不透明源；
 * 这里再把它能加载的东西限定在本站目录（与宿主给的 SDK）里：不能请求 onset 的接口、不能连网、不能提交表单、
 * 不能再嵌页面。要数据只能经 postMessage 请宿主转交（StationPage.tsx），宿主逐条把关。
 */
export function pageCSP(stationID: string, network: readonly string[] = []): string {
  const own = `onset://app/station-ui/${encodeURIComponent(stationID)}/`;
  const sdk = 'onset://app/station-ui/_sdk.js';
  // 当桌宠的页面里由宿主插进来的拖动脚本（petDragScript）。
  const petDrag = 'onset://app/station-ui/_pet.js';
  // 项目里的视频、封面经 /station-media/<站>/ 放（只给声明过能读的文件）。
  const media = `onset://app/station-media/${encodeURIComponent(stationID)}/`;
  // 联网只给清单 permissions.network 里写的地址（添加时与设置页里给用户看）。
  const net = network.length > 0 ? network.join(' ') : "'none'";
  return [
    "default-src 'none'",
    `script-src ${own} ${sdk} ${petDrag} 'unsafe-inline'`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own} ${media} data: blob:${network.length > 0 ? ' ' + network.join(' ') : ''}`,
    `media-src ${own} ${media} data: blob:`,
    `font-src ${own} data:`,
    `connect-src ${net}`,
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const pageHeaders = (stationID: string, network: readonly string[] = []): Record<string, string> => ({
  'Content-Security-Policy': pageCSP(stationID, network),
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache',
  'Referrer-Policy': 'no-referrer',
});

/** 页面请求等宿主回应（回答或 ack）的上限。读文件、看项目都在本机，几百毫秒内就回。 */
export const pageHostTimeoutMs = 15_000;

/**
 * 插件页面的辅助脚本：页面里 <script src="/station-ui/_sdk.js"> 后用 window.onset。宿主一侧是
 * apps/desktop 的 Stations.tsx（StationFrame）：请求 {onset:'station', id, type, …}，回答 {onset:'host', id, ok, result|error}，
 * 执行类请求先回 {onset:'host', id, ack:true}，项目变化时发 {onset:'host', type:'refresh'}。
 */
export const pageSDK = `// 片场插件页面 SDK：页面在沙箱里，只能经宿主读文件、执行操作、往对话框填字。
(() => {
  // 本站 id：页面地址 /station-ui/<站>/…
  const STATION = decodeURIComponent((location.pathname.split('/')[2]) || '');
  let seq = 0;
  const pending = new Map();
  const refreshers = [];
  // 宿主在这么久里既没回答、也没说「收到了，在等用户确认」，就当请求没送到，给页面一个清楚的错误。
  const HOST_TIMEOUT_MS = ${pageHostTimeoutMs};
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.onset !== 'host') return;
    if (m.type === 'refresh') {
      for (const f of refreshers) { try { f(); } catch (err) { console.error(err); } }
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    // 执行类请求（run、call、send）先回一条 ack：宿主已经弹出确认条，等用户多久都不算超时。
    if (m.ack) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || '宿主拒绝了这个请求'));
  });
  const call = (type, payload) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('片场没有回应这个请求（' + type + '），请重新打开这个页面再试'));
    }, HOST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage(Object.assign({ onset: 'station', id, type }, payload), '*');
  });
  // 跟随宿主的配色与基础控件：宿主把 :root 的颜色变量交过来，页面照着用 var(--accent) 等。
  const applyTheme = (theme) => {
    if (!theme) return;
    for (const [k, v] of Object.entries(theme.vars || {})) document.documentElement.style.setProperty(k, v);
    if (theme.css && !document.getElementById('onset-theme')) {
      const style = document.createElement('style');
      style.id = 'onset-theme';
      style.textContent = theme.css;
      document.head.prepend(style);
    }
  };
  const ready = call('theme', {}).then(applyTheme, () => {});
  window.onset = {
    /** 主题加载完（页面可以 await onset.ready 再显示，避免闪一下）。 */
    ready,
    /** 项目名、本站信息、操作、设置（不含密钥）与嵌入位上下文（嵌在镜头页时有镜头编号）。 */
    info: () => call('info', {}),
    /** 项目摘要：镜头、制作路线、发布信息、画幅、风格（清单 permissions.project 申请过才给）。 */
    project: () => call('project', {}),
    /** 请用户确认后调用一条 onset 自带的操作（清单 permissions.uses 申请过的），例如 scene_run、review。 */
    call: (op, params) => call('call', { op, params: params || {} }),
    /** 项目里视频、图片的地址（可以直接放进 <video>/<img>，只给声明过能读的文件）。 */
    mediaURL: (path) => '/station-media/' + encodeURIComponent(STATION) + '/' + String(path).split('/').map(encodeURIComponent).join('/'),
    /** 打开本站的另一个页面。 */
    open: (page) => call('open', { page }),
    /** 读一个项目文件（清单里声明过的）：{ path, size, text }，图片另有 data_url。 */
    read: (path) => call('read', { path }),
    /** 跑本站的一条列表操作（清单 ops[].list，只读插件自己的数据，例如已登录的账号），不用用户确认；resolve 成它的结构化结果。 */
    list: (op) => call('list', { op }),
    /** 请用户确认后执行本站的一条操作；用户拒绝时 reject。 */
    run: (op, params) => call('run', { op, params: params || {} }),
    /** 请用户确认后，把一段话作为一条消息直接发给 AI。 */
    send: (text) => call('send', { text }),
    /** 把一段话填进对话输入框（不会自动发送）。 */
    ask: (text) => call('ask', { text }),
    /** 项目有变化（任务跑完、一轮对话结束）时回调，页面据此重读。 */
    onRefresh: (f) => { refreshers.push(f); },
  };
})();
`;

/**
 * 当桌宠的插件页面里的拖动：沙箱 iframe 盖住的那一块收不到窗口的拖动区域（-webkit-app-region 在 iframe 里不起作用），
 * 所以宿主在发这种页面时插一段脚本：在不是按钮、链接、输入框（或标了 data-no-drag）的地方按下并挪动超过 3 像素，
 * 就请宿主开始拖窗口（主进程跟着鼠标挪），松开时结束；拖过之后的那一下 click 吞掉，免得拖完误点。
 * 页面作者不用做什么，自己的按钮照常能点。
 */
export const petDragScript = `(() => {
  const interactive = 'a,button,input,textarea,select,label,summary,[contenteditable],[data-no-drag]';
  let start = null;
  let dragging = false;
  let swallow = false;
  const post = (phase) => parent.postMessage({ onset: 'pet-drag', phase }, '*');
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest(interactive))) return;
    start = { id: e.pointerId, x: e.screenX, y: e.screenY };
    dragging = false;
  }, true);
  addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id || dragging) return;
    if (Math.hypot(e.screenX - start.x, e.screenY - start.y) < 3) return;
    dragging = true;
    try { document.documentElement.setPointerCapture(e.pointerId); } catch {}
    post('start');
  }, true);
  const end = () => {
    if (dragging) { post('end'); swallow = true; setTimeout(() => { swallow = false; }, 0); }
    start = null;
    dragging = false;
  };
  addEventListener('pointerup', end, true);
  addEventListener('pointercancel', end, true);
  addEventListener('lostpointercapture', end, true);
  addEventListener('blur', end);
  addEventListener('click', (e) => { if (swallow) { e.stopPropagation(); e.preventDefault(); } }, true);
})();
`;

/** 当桌宠的页面：在 </head> 前插进拖动脚本；没写 </head> 就接在最后（不能插在 doctype 前面，那会让页面进怪异模式）。 */
function withPetDrag(html: string): string {
  const tag = '<script src="/station-ui/_pet.js"></script>';
  const at = html.search(/<\/head>/i);
  return at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag;
}

/** GET /station-ui/_sdk.js 与 /station-ui/<站>/<文件>：只给页面 entry 所在目录里的文件。 */
export function stationUIAPI(s: { projectOr404(): unknown }, request: Request, rest: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET');
  if (rest === '_sdk.js') {
    return new Response(pageSDK, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (rest === '_pet.js') {
    return new Response(petDragScript, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  // 插件页面只在打开的项目里用（它要的项目数据经宿主转交）。
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const cut = rest.indexOf('/');
  if (cut <= 0) return notFound();
  const id = rest.slice(0, cut);
  const file = rest.slice(cut + 1);
  const station = flow.loadStations().stations.find((x) => x.manifest.id === id);
  if (!station || file === '' || file.split('/').some((seg) => seg === '..' || seg === '' || seg.startsWith('.'))) {
    return notFound();
  }
  const allowed = station.manifest.pages.some((pg) => {
    const dir = pg.entry.includes('/') ? pg.entry.slice(0, pg.entry.lastIndexOf('/') + 1) : '';
    return dir === '' ? file === pg.entry : file.startsWith(dir);
  });
  if (!allowed) return notFound();
  const full = path.join(station.dir, file);
  let real: string;
  try {
    real = fs.realpathSync(full);
  } catch {
    return notFound();
  }
  if (!real.startsWith(fs.realpathSync(station.dir) + path.sep)) return notFound();
  const headers = pageHeaders(id, station.manifest.permissions.network);
  // 被皮肤拿去当桌宠的页面：插进拖动脚本（见 petDragScript）。
  const petEntries = petPageIDs(station).map((pid) => station.manifest.pages.find((pg) => pg.id === pid)?.entry);
  if (petEntries.includes(file) && /\.html?$/i.test(file)) {
    return new Response(request.method === 'HEAD' ? null : withPetDrag(fs.readFileSync(real, 'utf8')), {
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return serveFile(request, real, headers);
}

/** GET /station-media/<站>/<项目里的路径>：插件页面放项目里的视频、图片（只给声明过能读的，支持拖动）。 */
export function stationMediaAPI(s: { projectOr404(): unknown }, request: Request, rest: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const root = (p as { path: string }).path;
  const cut = rest.indexOf('/');
  if (cut <= 0) return notFound();
  const station = flow.loadStations().stations.find((x) => x.manifest.id === rest.slice(0, cut));
  const rel = rest.slice(cut + 1);
  if (!station || !flow.pageMayRead(station.manifest, rel) || !fs.existsSync(path.join(root, rel))) return notFound();
  let full: string;
  try {
    full = containedPath(root, rel);
  } catch {
    return notFound();
  }
  if (isEnvFile(full)) return notFound();
  return serveFile(request, full, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
}

const maxReadBytes = 8 << 20;
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** GET /api/stations/<站>/read?path=：插件页面经宿主读项目文件，只给清单声明过的路径。 */
export function readForPage(root: string, station: flow.LoadedStation, rel: string): Response {
  const id = station.manifest.id;
  if (!flow.pageMayRead(station.manifest, rel)) {
    return writeError(403, 'forbidden', `第三方站 ${id} 没有声明要读 ${rel}`);
  }
  // pageMayRead 已保证是项目里的干净相对路径；还没生成的文件直接说没有（containedPath 解析不了不存在的路径）。
  if (!fs.existsSync(path.join(root, rel))) return writeError(404, 'not_found', `还没有 ${rel}`);
  let full: string;
  try {
    full = containedPath(root, rel);
  } catch (err) {
    return writeError(403, 'forbidden', (err as Error).message);
  }
  if (isEnvFile(full)) return writeError(403, 'forbidden', '不能读 .env');
  let body: Buffer;
  try {
    const info = fs.statSync(full);
    if (!info.isFile()) return writeError(404, 'not_found', `${rel} 不是文件`);
    if (info.size > maxReadBytes) {
      return writeError(
        413,
        'too_large',
        `${rel} 太大（${info.size} 字节），页面只能读 ${maxReadBytes} 字节以内的文件`,
      );
    }
    body = fs.readFileSync(full);
  } catch {
    return writeError(404, 'not_found', `还没有 ${rel}`);
  }
  const out: Record<string, unknown> = { path: rel, size: body.length };
  const image = imageTypes[path.extname(full).toLowerCase()];
  if (image) out.data_url = `data:${image};base64,${body.toString('base64')}`;
  else out.text = body.toString('utf8');
  return writeJSON(200, goMap(out));
}
