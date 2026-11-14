/**
 * 前置资源：客户端的安装页，在客户端里直接安装。
 *
 * 以前客户端只读不下载，要用户自己去终端跑 am setup：理由是能看着进度、能加代理、断了能重来。
 * 可客户端用户多半不会开终端，装好应用却用不了。现在安装页满足同样的三条——每项一行的进度、
 * 可填代理、失败显示原因与日志最后几行、重试接着下——跑的是与 am setup 同一份清单（../prereqs）、
 * 同一份日志（<数据目录>/am/setup.log）。边界不变：下载只发生在这里（或 am setup），
 * 建项目、渲染、打开菜单时仍然只检查。
 *
 * 同一时间只跑一次安装（模块级的 task）；进度经 GET /api/setup 轮询，安装中界面每秒取一次。
 * 不占项目写锁：前置资源都装在用户级目录，不写项目文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '../envutil';
import { SetupCommand } from '../prereq';
import * as prereqs from '../prereqs';
import { methodNotAllowed, writeError, writeJSON } from './http';

/** 一项在这次安装里的进展。 */
export interface ItemProgress {
  state: 'pending' | 'running' | 'done' | 'failed';
  stage: string;
  /** 0–100；没有可量的进度时省略。 */
  percent?: number;
  error?: string;
}

/** 一次安装。 */
export interface SetupTask {
  running: boolean;
  started: string;
  finished?: string;
  /** 只含这次要装的项（已就绪的不在里面）。 */
  items: Record<string, ItemProgress>;
  error?: string;
  /** 失败时日志最后几行（git、npm、curl 的原始输出）。 */
  log_tail?: string[];
  log: string;
}

/** /api/setup 的结果：前置资源的就绪状态与安装进展，给首页、顶栏与安装页用。 */
export interface SetupStatus {
  /** 做片必需的项都已就绪；可选项缺了只影响对应功能。 */
  ready: boolean;
  items: prereqs.Status[];
  command: string;
  task?: SetupTask;
}

let task: SetupTask | null = null;
let controller: AbortController | null = null;

/** 测试用：清掉上一次安装的状态。 */
export function resetSetupTask(): void {
  controller?.abort();
  task = null;
  controller = null;
}

/** 客户端退出前停掉进行中的安装（curl、npm、uv 都是子进程）。 */
export function cancelSetup(): void {
  controller?.abort();
}

function statusJSON(item: prereqs.Status): Record<string, unknown> {
  return {
    id: item.id,
    group: item.group,
    name: item.name,
    version: item.version || undefined,
    required: item.required,
    ready: item.ready,
    location: item.location,
    // 安装页按它把「以后可能用到」的几项（节拍分析环境、各整片风格来源）排成单独点装的卡片；漏了它，
    // 这几项缺着时顶栏照样数出「可按需安装」，打开却只看到「已全部就位」。
    later: item.later,
  };
}

/** 浏览器端到端测试不联网、也没有真实的前置资源：与跳过技能安装用同一个开关，当作全部就绪。 */
function skipAll(): boolean {
  return process.env.AM_STUDIO_SKIP_SKILL_INSTALL === '1';
}

function currentStatus(projectRoot: string): SetupStatus {
  const env = envMap();
  const resp: SetupStatus = { ready: true, items: prereqs.check(env, prereqs.selection(env, projectRoot)), command: SetupCommand };
  if (skipAll()) for (const item of resp.items) item.ready = true;
  for (const item of resp.items) if (item.required && !item.ready) resp.ready = false;
  if (task) resp.task = task;
  return resp;
}

/** GET /api/setup：就绪状态与（有的话）安装进展。projectRoot 为空表示没有打开项目。 */
export function setupAPI(request: Request, projectRoot = ''): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const resp = currentStatus(projectRoot);
  return writeJSON(200, { ready: resp.ready, items: resp.items.map(statusJSON), command: resp.command, task: resp.task });
}

/** 从「下载 ffmpeg 45%」这样的阶段说明里取出百分比。 */
export function splitStage(text: string): { stage: string; percent?: number } {
  const m = /^(.*?)\s+(\d{1,3})%$/.exec(text);
  if (!m) return { stage: text };
  return { stage: m[1], percent: Math.min(100, Number(m[2])) };
}

/**
 * POST /api/setup/run {only?: string[], proxy?: string}：在后台准备缺的项，立即返回 202。
 * only 认的写法与 am setup --only 相同（组名或项 ID）；不给时准备全部必需项与配音、对齐工具
 * ——节拍分析环境与整片风格来源动辄上 GB，只在点名时才装。
 */
export async function setupRunAPI(request: Request, projectRoot = '', run: (fn: () => Promise<void>) => void = (fn) => void fn()): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  if (task?.running) return writeError(409, 'setup_running', '已经在安装了');
  let body: { only?: unknown; proxy?: unknown } = {};
  try {
    const text = await request.text();
    if (text.trim() !== '') body = JSON.parse(text) as typeof body;
  } catch {
    return writeError(400, 'bad_request', '请求不是合法的 JSON');
  }
  const only = Array.isArray(body.only) ? body.only.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
  const proxy = typeof body.proxy === 'string' ? body.proxy.trim() : '';
  if (proxy !== '' && !/^(https?|socks5h?):\/\/[^\s'"]+$/.test(proxy)) return writeError(400, 'bad_proxy', '代理地址要写成 http://127.0.0.1:7890 这样');

  const env = envMap();
  const all = prereqs.items(prereqs.selection(env, projectRoot));
  const wanted = new Set(only);
  for (const id of wanted) {
    if (!all.some((item) => item.id === id || item.group === id)) return writeError(400, 'unknown_item', `不认识 ${id}`);
  }
  const picked = all.filter((item) => {
    if (wanted.size > 0) return wanted.has(item.id) || wanted.has(item.group);
    return item.required || item.group === 'tts' || item.group === 'align';
  });
  const todo = skipAll() ? [] : picked.filter((item) => !item.ready(env)[0]);

  const log = prereqs.logPath(env);
  const current: SetupTask = { running: true, started: new Date().toISOString(), items: {}, log };
  for (const item of todo) current.items[item.id] = { state: 'pending', stage: '' };
  task = current;
  controller = new AbortController();
  const signal = controller.signal;

  run(async () => {
    let fd: number | null = null;
    try {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fd = fs.openSync(log, 'w');
      const out = fd;
      const writer = { write: (chunk: string) => fs.writeSync(out, chunk) };
      const prep = prereqs.newRun(env, proxy, '', writer);
      for (const item of todo) {
        const progress = current.items[item.id];
        progress.state = 'running';
        progress.stage = '准备中';
        writer.write(`\n===== ${item.name} ${item.version} =====\n`);
        prep.stage = (text) => {
          const { stage, percent } = splitStage(text);
          progress.stage = stage;
          if (percent === undefined) delete progress.percent;
          else progress.percent = percent;
        };
        try {
          await item.prepare(prep, signal);
          progress.state = 'done';
          progress.stage = '';
          progress.percent = 100;
        } catch (err) {
          const message = signal.aborted ? '已取消' : (err as Error).message;
          writer.write(`\n[am] ${message}\n`);
          progress.state = 'failed';
          progress.error = message;
          current.error = `${item.name} 没准备好：${message}`;
          break;
        }
      }
    } catch (err) {
      current.error = (err as Error).message;
    } finally {
      if (fd !== null) fs.closeSync(fd);
      if (current.error) current.log_tail = logTail(log);
      current.running = false;
      current.finished = new Date().toISOString();
      controller = null;
    }
  });
  return writeJSON(202, { task: current });
}

/** POST /api/setup/cancel：停掉进行中的安装。下载可续传，下次接着下。 */
export function setupCancelAPI(request: Request): Response {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  controller?.abort();
  return writeJSON(200, { cancelled: Boolean(task?.running) });
}

/** 日志最后 12 行（去掉 am 自己记的错误行，界面上另有显示）。 */
function logTail(file: string): string[] {
  let body = '';
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const cut = body.lastIndexOf('\n[am] ');
  if (cut >= 0) body = body.slice(0, cut);
  return body
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-12);
}
