/**
 * 插件（/api/stations）。插件装在用户级，对所有项目生效；装、去掉、更新、设置不要打开项目：
 *   GET  /api/stations                         全部插件（内置与已装的第三方插件：清单、设置、权限、页面、嵌入位、命令）与读不出来的
 *   POST /api/stations                         取回给用户看（任务 station_add，不占项目写锁）：任务的 result 是 {staged, preview}，还没装上
 *   GET  /api/stations/staged/{编号}           再看一次待装插件的实情
 *   POST /api/stations/staged/{编号}/install   用户看过、点了「装上」（任务 station_install）
 *   POST /api/stations/staged/{编号}/discard   取消：清掉暂存
 *   POST /api/stations/{id}/remove             去掉（任务 station_remove）
 *   POST /api/stations/{id}/update             取回新版本给用户看（任务 station_update，result 同上，带差异），确认后同样走 install
 *   POST /api/stations/{id}/settings           改一项插件设置（用户级，不进项目）
 * 下面几样针对当前项目：
 *   POST /api/stations/{id}/ops/{操作}         执行本站的一条操作（写任务 station_run）
 *   POST /api/stations/{id}/call/{操作}        替插件页面调一条 onset 自带的操作（清单 permissions.uses 里申请过的）
 *   GET  /api/stations/{id}/read?path=         插件页面读项目文件（只给声明过的）
 *
 * 改项目文件的一律走写任务，与一轮对话互斥；客户端自己不写项目文件。钩子与定时只对当前打开的项目跑。插件页面发来的执行请求，
 * 界面先请用户确认才会打到这里（StationPage.tsx）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '../envutil';
import * as flow from '../flow';
import * as plugin from '../plugin';
import { OpScopeEnv } from '../opworker';
import { isEnvFile } from './api_ui';
import { decodeJSON, DecodeError, fieldString, goMap, methodNotAllowed, notFound, serveFile, writeError, writeJSON } from './http';
import { containedPath } from './sessions';
import type { Project, Server } from './studio';
import { onStudioEvent } from './events';
import { emit, getSession, kindNotice, listSessions } from './sessions';
import { addTask, runStudioOp, runTask, runUserOp, runWriteTask, updateTask, warnTask, writeTaskError, type Task } from './tasks';
import { listSkins, petPageIDs } from './skins';

/** 最近一次从界面执行的结果，按「项目 站 操作」记，客户端重启就没了（站自己写的回执才是凭据）。 */
interface LastRun {
  task_id: string;
  at: string;
  ok: boolean;
  text: string;
  data?: unknown;
  /** 写了声明范围之外的项目文件（flow.scopeReport）；没有越界时不出现。 */
  out_of_scope?: string[];
  out_of_scope_more?: number;
  /** 其中属于 onset 自己的文件（这次操作因此算失败）。 */
  reserved?: string[];
}

const lastRuns = new Map<string, LastRun>();
const maxRunText = 4000;

/** 提示词全文给界面看（添加后可以核对它让编排工具做什么），过长截断。 */
const maxPromptChars = 20000;

function stationJSON(root: string, s: flow.LoadedStation): Record<string, unknown> {
  let prompt = '';
  if (s.manifest.prompt !== '') {
    try {
      prompt = fs.readFileSync(path.join(s.dir, s.manifest.prompt), 'utf8');
    } catch {
      prompt = '';
    }
  }
  if (prompt.length > maxPromptChars) prompt = prompt.slice(0, maxPromptChars) + '\n…';
  const m = s.manifest;
  const pageInfo = (id: string) => m.pages.find((pg) => pg.id === id)!;
  const settings = flow.publicSettings(envMap(), m);
  // 被皮肤拿去当桌宠的页面：插件菜单不列。
  const petPages = petPageIDs(s);
  // 内置插件的站、操作、渲染技能、页面在 apply 里登记，不在清单里：另列在 contents 里，设置页「详情」照实显示
  // 这个功能带了什么（不并进 nodes、pages：那两样给第三方站的页面与路线用）。
  const owned = <T>(list: plugin.Owned<T>[]) => (s.builtin ? list.filter((x) => x.owner === m.id).map((x) => x.value) : []);
  const contents = s.builtin
    ? {
        nodes: owned(plugin.pluginStations()).flatMap((st) => st.nodes.map((n) => n.label)),
        ops: owned(plugin.pluginOps())
          .filter((o) => (o.scopes ?? ['orchestrator']).includes('orchestrator'))
          .map((o) => ({ name: o.name, summary: o.summary, verb: o.verb ?? '' })),
        skills: owned(plugin.pluginSkills()).map((sk) => sk.name),
        blocks: owned(plugin.pluginSceneBlocks()).map((b) => b.key),
        pages: owned(plugin.pluginPages()).map((pg) => pg.label),
        flows: owned(plugin.pluginFlows()).map((f) => f.name),
        film_styles: owned(plugin.pluginFilmStyleSources()).map((src) => src.name()),
        skins: owned(plugin.pluginSkins()).map((sk) => sk.name),
      }
    : null;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    builtin: s.builtin === true,
    contents,
    source: s.entry.source,
    commit: s.entry.commit,
    linked: s.entry.commit === '',
    /** 用到的实验性字段（以后的版本可能调整）。内置插件不标。 */
    experimental: s.builtin ? [] : flow.experimentalFields(m),
    replaces: m.replaces,
    after: m.after,
    prompt,
    nodes: m.nodes.map((n) => ({ id: n.id, label: n.label, step: n.step, gate: n.gate === true })),
    pages: m.pages.map((pg) => ({ id: pg.id, label: pg.label, tab: flow.pageTab(m.id, pg.id), url: pageURL(m.id, pg.entry), reads: pg.reads, ...(petPages.includes(pg.id) ? { pet: true } : {}) })),
    skins: s.builtin ? [] : listSkins().skins.filter((e) => e.key.startsWith(m.id + '/')).map((e) => e.skin.name),
    ops: m.ops.map((o) => {
      // 不需要项目的操作：这个项目里的与没打开项目时的，取较新的那次。
      const inProject = lastRuns.get(`${root}\n${m.id}\n${o.name}`);
      const outside = o.project === false && root !== '' ? lastRuns.get(`\n${m.id}\n${o.name}`) : undefined;
      const last = outside && (!inProject || outside.at > inProject.at) ? outside : inProject;
      return {
        name: o.name,
        tool: o.trigger === 'agent' ? flow.toolName(m.id, o.name) : '',
        summary: o.summary,
        description: o.description ?? '',
        trigger: o.trigger,
        /** false：不需要项目，设置页里没打开项目也能点。 */
        project: o.project !== false,
        /** 返回列表（账号卡片这类），设置里自动执行并画成卡片。 */
        list: o.list === true,
        /** false：设置里不给它出按钮表单。 */
        form: o.form !== false,
        params: Object.entries(o.params).map(([key, p]) => ({ key, type: p.type, description: p.description, required: p.required === true, default: p.default })),
        last_run: last,
      };
    }),
    settings: m.settings.map((x) => ({
      key: x.key,
      label: x.label,
      type: x.type,
      description: x.description,
      options: x.options,
      default: x.default,
      ...(x.type === 'secret' ? { set: settings.secrets_set[x.key] === true } : { value: settings.values[x.key] }),
    })),
    permissions: m.permissions,
    browser: m.browser,
    hooks: m.hooks,
    schedules: m.schedules,
    inserts: m.inserts.map((ins) => ins.stage),
    provides: { tts: m.provides.tts?.name ?? '', align: m.provides.align?.name ?? '' },
    renderer_skills: m.renderer_skills.map((r) => ({ name: r.name, summary: r.summary, scenes: r.scenes })),
    film_styles: m.film_styles?.name ?? '',
    flow: m.flow ? { name: m.flow.name, stations: m.flow.stations, first_tab: toFirstTab(m) } : null,
    slots: m.slots.map((sl) => ({ at: sl.at, page: sl.page, height: sl.height, tab: flow.pageTab(m.id, sl.page), url: pageURL(m.id, pageInfo(sl.page).entry) })),
    commands: m.commands.map((c) => ({ ...c, tab: c.page ? flow.pageTab(m.id, c.page) : '' })),
  };
}

function toFirstTab(m: flow.Manifest): string {
  if (!m.flow) return '';
  return flow.builtinFirstPages().includes(m.flow.first_page) ? m.flow.first_page : flow.pageTab(m.id, m.flow.first_page);
}

/** 全部插件；root 是当前项目（没有打开项目为空），只用来带上这个项目里最近一次执行的结果。 */
export function listStations(root: string): Record<string, unknown> {
  const { stations, problems } = flow.loadStations();
  return {
    stations: stations.map((s) => stationJSON(root, s)),
    // 读不出来的插件：设置页显示原因，给「更新 / 去掉」。
    problems: problems.map((p) => ({ id: p.id, message: p.message, linked: p.entry ? flow.parseSource(p.entry.source).kind === 'link' : false })),
  };
}

/** 装、去掉、更新插件：不占项目写锁（插件在用户级），没有打开项目也能做。操作的 data 放进任务的 result。 */
export function startUserTask(s: Server, type: string, message: string, name: string, params: Record<string, unknown>): Response {
  const t = addTask(s, type, message);
  runTask(s, t, async (signal) => {
    const r = await runUserOp(s, signal, name, params);
    t.result = r.data;
  });
  return writeJSON(202, goMap({ task_id: t.task_id }));
}

async function readParams(request: Request): Promise<Record<string, unknown>> {
  const body = await decodeJSON(request);
  const raw = body.params ?? {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('params 要是对象');
  return raw as Record<string, unknown>;
}

/**
 * 跑一条第三方操作：插件写的 onset-progress 行变成任务进度；结果记进 lastRuns。
 *
 * 越界检查在执行进程里（flow.runStationOp）已经做过一遍，结果写进了操作的文字，给编排工具看；这里在调用点
 * 外面再扫一遍项目，拿到结构化的列表给界面（任务、发布页的按钮、插件页面）。执行进程的协议只回传插件自己的 data，
 * 不为它另开字段；两遍都只 stat，代价很小。钩子与定时触发的（event 不为空）越界时另发一条 notice。
 */
async function runStationTask(s: Server, signal: AbortSignal, p: Project, task: Task, id: string, op: string, params: Record<string, unknown>, event?: Record<string, unknown>): Promise<void> {
  const key = `${p.path}\n${id}\n${op}`;
  let pending = '';
  const onText = (text: string) => {
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const progress = flow.parseProgressLine(line);
      if (progress) updateTask(s, task.task_id, 'running', progress.message || task.message, Math.max(0.1, Math.min(0.99, progress.progress)), null);
    }
  };
  const station = flow.loadStations().stations.find((x) => x.manifest.id === id);
  const before = station ? flow.statProject(p.path) : null;
  const scope = () => {
    if (!station || !before) return null;
    const r = flow.scopeReport(station.manifest, before, flow.statProject(p.path));
    if (r) reportScope(s, p, task, station.manifest.name, r, event);
    return r;
  };
  const scopeFields = (r: flow.ScopeReport | null) =>
    r ? { out_of_scope: r.out_of_scope, out_of_scope_more: r.out_of_scope_more, ...(r.reserved.length > 0 ? { reserved: r.reserved } : {}) } : {};
  let browser: flow.StationBrowserLease | undefined;
  try {
    if (!event && station?.manifest.browser && station.manifest.ops.find(o => o.name === op)?.trigger === 'user' && s.config.stationBrowser) {
      browser = await s.config.stationBrowser({ id, name: station.manifest.name, origins: station.manifest.browser.origins, project_root: p.path, data_dir: path.join(flow.stationsDir(envMap()), id, 'data') });
    }
    const r = await runStudioOp(
      s,
      signal,
      p,
      'station_run',
      { station: id, op, params: JSON.stringify(params), event: event ? JSON.stringify(event) : '', project_root: p.path },
      { onText, ...(browser ? { env: { [flow.StationBrowserEnv]: JSON.stringify(browser.connection) } } : {}) },
    );
    lastRuns.set(key, { task_id: task.task_id, at: new Date().toISOString(), ok: true, text: stripProgress(r.text).slice(-maxRunText), ...(r.data !== undefined ? { data: r.data } : {}), ...scopeFields(scope()) });
    // 打开了项目时，不需要项目的操作（例如登录）也走这里：设置弹窗读 result 里插件的说明。
    task.result = taskResult(station?.manifest.ops.find((o) => o.name === op), r.data);
  } catch (err) {
    lastRuns.set(key, { task_id: task.task_id, at: new Date().toISOString(), ok: false, text: (err as Error).message.slice(-maxRunText), ...scopeFields(scope()) });
    throw err;
  } finally {
    browser?.dispose();
  }
}

/** 没打开项目时跑不需要项目的操作：不扫越界；结果记在 lastRuns 的空项目键下。 */
async function runUserStationTask(s: Server, signal: AbortSignal, task: Task, station: flow.LoadedStation, op: string, params: Record<string, unknown>): Promise<void> {
  const id = station.manifest.id;
  const key = `\n${id}\n${op}`;
  let pending = '';
  const onText = (text: string) => {
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const progress = flow.parseProgressLine(line);
      if (progress) updateTask(s, task.task_id, 'running', progress.message || task.message, Math.max(0.1, Math.min(0.99, progress.progress)), null);
    }
  };
  let browser: flow.StationBrowserLease | undefined;
  try {
    if (station.manifest.browser && s.config.stationBrowser) {
      browser = await s.config.stationBrowser({ id, name: station.manifest.name, origins: station.manifest.browser.origins, project_root: '', data_dir: path.join(flow.stationsDir(envMap()), id, 'data') });
    }
    const r = await runUserOp(
      s,
      signal,
      'station_run',
      { station: id, op, params: JSON.stringify(params), event: '', project_root: '' },
      { onText, ...(browser ? { env: { [flow.StationBrowserEnv]: JSON.stringify(browser.connection) } } : {}) },
    );
    lastRuns.set(key, { task_id: task.task_id, at: new Date().toISOString(), ok: true, text: stripProgress(r.text).slice(-maxRunText), ...(r.data !== undefined ? { data: r.data } : {}) });
    // 设置里的弹窗等任务跑完后读 result 里插件的说明（例如「已登录：昵称」）。
    task.result = taskResult(station.manifest.ops.find((o) => o.name === op), r.data);
  } catch (err) {
    lastRuns.set(key, { task_id: task.task_id, at: new Date().toISOString(), ok: false, text: (err as Error).message.slice(-maxRunText) });
    throw err;
  } finally {
    browser?.dispose();
  }
}

/**
 * 插件操作交给任务的 result：只留插件的一句说明。任务连同 result 会写进打开着的项目的
 * production/studio/tasks.json，插件的完整结果（账号列表的昵称、头像、按钮参数）不能跟着项目被拷走、分享出去；
 * 列表操作（ops[].list）的结果设置弹窗从 /api/stations 的 last_run（只在内存里）读，任务里什么都不留。
 */
function taskResult(op: flow.ManifestOp | undefined, data: unknown): Record<string, string> | undefined {
  if (op?.list) return undefined;
  const message = (data as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message !== '' ? { message: message.slice(0, 500) } : undefined;
}

/** 越界写入：记在任务上；钩子、定时这类没人在看的触发，另在最近的对话里发一条 notice。 */
function reportScope(s: Server, p: Project, task: Task, name: string, r: flow.ScopeReport, event?: Record<string, unknown>): void {
  const total = r.out_of_scope.length + r.out_of_scope_more;
  const files = r.out_of_scope.join('、') + (r.out_of_scope_more > 0 ? ` 等 ${total} 个` : '');
  const text =
    r.reserved.length > 0
      ? `插件「${name}」写了片场自己的文件（${files}），这次操作按失败处理。文件已经写了，没法自动撤销：可以回退那一轮对话，或者用 git 恢复。`
      : `插件「${name}」改了它没有声明会写的项目文件：${files}。`;
  warnTask(s, task.task_id, text);
  if (!event) return;
  try {
    const latest = listSessions(s, p.path)[0];
    const sess = latest ? getSession(s, p.path, latest.session_id) : undefined;
    if (sess) emit(sess, '', { kind: kindNotice, text: `${event.name === 'schedule' ? '定时' : '自动'}执行的${text}` });
  } catch {
    // 发不出 notice 不影响任务上的提醒。
  }
}

function stripProgress(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.startsWith(flow.ProgressPrefix))
    .join('\n');
}

export async function stationsAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);

  if (parts.length === 0) {
    if (request.method === 'GET') return writeJSON(200, goMap(listStations(s.projectRoot())));
    if (request.method !== 'POST') return methodNotAllowed('GET, POST');
    let source: string;
    try {
      source = fieldString(await decodeJSON(request), 'source').trim();
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    if (source === '') return writeError(400, 'invalid_request', '写上插件的来源');
    try {
      flow.parseSource(source);
    } catch (err) {
      return writeError(400, 'invalid_request', (err as Error).message);
    }
    return startUserTask(s, 'station.stage', `取回插件：${source}`, 'station_add', { source });
  }

  // 待装的插件：看、装上、取消。
  if (parts[0] === 'staged' && parts.length >= 2) {
    const token = decodeURIComponent(parts[1]);
    let staged: flow.Staged;
    try {
      staged = flow.readStaged(token);
    } catch (err) {
      return writeError(404, 'not_found', (err as Error).message);
    }
    if (parts.length === 2) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      return writeJSON(200, goMap({ staged: staged.token, preview: staged.preview }));
    }
    if (request.method !== 'POST') return methodNotAllowed('POST');
    if (parts[2] === 'install') return startUserTask(s, 'station.install', `装上插件：${staged.preview.name}`, 'station_install', { staged: token });
    if (parts[2] === 'discard') {
      flow.discardStaged(token);
      return writeJSON(200, goMap({ staged: token }));
    }
    return writeError(404, 'not_found', 'Studio API 路径不存在');
  }

  const id = decodeURIComponent(parts[0]);
  if (parts.length === 2 && (parts[1] === 'remove' || parts[1] === 'update')) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    // 读不出来的插件（例如内容被改过）也能更新、去掉：只看已装插件清单，不读插件目录。
    let entry: flow.InstalledEntry | undefined;
    try {
      entry = flow.installedEntry(id);
    } catch (err) {
      return writeError(500, 'invalid_installed', (err as Error).message);
    }
    if (!entry) return writeError(404, 'not_found', `没有装插件 ${id}`);
    if (parts[1] === 'remove') return startUserTask(s, 'station.remove', `去掉插件：${id}`, 'station_remove', { id });
    if (flow.parseSource(entry.source).kind === 'link') return writeError(400, 'invalid_request', `插件 ${id} 来自本机目录，改动立即生效，不需要更新`);
    return startUserTask(s, 'station.stage', `取回插件的新版本：${id}`, 'station_update', { id });
  }

  const station = flow.loadStations().stations.find((x) => x.manifest.id === id);
  if (!station) return writeError(404, 'not_found', `没有装插件 ${id}`);

  if (parts.length === 2 && parts[1] === 'settings') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    try {
      const body = await decodeJSON(request);
      flow.writeStationSetting(envMap(), station.manifest, fieldString(body, 'key'), body.value);
    } catch (err) {
      return writeError(400, 'invalid_setting', (err as Error).message);
    }
    return writeJSON(200, goMap(stationJSON(s.projectRoot(), station)));
  }

  // 不需要项目的操作（清单 ops[].project: false，登录、管理账号这类插件自己的配置）在没打开项目时：
  // 不占项目写锁，与装、去掉插件一样是用户级的后台任务。打开了项目就照常在项目里跑（插件的页面靠它写进项目的文件）。
  // 返回列表的操作（ops[].list）只读插件自己的数据、会被设置页自动执行：一律这样跑，打开了项目也不占写锁，
  // 不然它跑着的时候用户点的项目操作会因为「项目正忙」被拒。
  if (parts.length === 3 && parts[1] === 'ops') {
    const op = station.manifest.ops.find((o) => o.name === decodeURIComponent(parts[2]));
    if (op && (op.list === true || (op.project === false && s.projectRoot() === ''))) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      let params: Record<string, unknown>;
      try {
        params = flow.checkParams(op, await readParams(request));
      } catch (err) {
        return writeError(400, 'invalid_request', err instanceof DecodeError ? err.message : (err as Error).message);
      }
      const t = addTask(s, 'station.run', `${station.manifest.name}：${op.summary}`);
      runTask(s, t, (signal) => runUserStationTask(s, signal, t, station, op.name, params));
      return writeJSON(202, goMap({ task_id: t.task_id }));
    }
  }

  // 下面几样针对当前项目。
  const p = s.projectOr404();
  if (p instanceof Response) return p;

  if (parts.length === 2 && parts[1] === 'read') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return readForPage(p.path, station, new URL(request.url).searchParams.get('path') ?? '');
  }

  if (parts.length === 3 && parts[1] === 'ops') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const opName = decodeURIComponent(parts[2]);
    const op = station.manifest.ops.find((o) => o.name === opName);
    if (!op) return writeError(404, 'not_found', `第三方站 ${id} 没有操作 ${opName}`);
    let params: Record<string, unknown>;
    try {
      params = flow.checkParams(op, await readParams(request));
    } catch (err) {
      return writeError(400, 'invalid_request', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    try {
      const t = runWriteTask(s, p, 'station.run', `${station.manifest.name}：${op.summary}`, (signal, task) => runStationTask(s, signal, p, task, id, opName, params));
      return writeJSON(202, goMap({ task_id: t.task_id }));
    } catch (err) {
      return writeTaskError(err);
    }
  }

  if (parts.length === 3 && parts[1] === 'call') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const opName = decodeURIComponent(parts[2]);
    if (!station.manifest.permissions.uses.includes(opName) || !flow.pageCallableOp(opName)) {
      return writeError(403, 'forbidden', `插件「${station.manifest.name}」没有申请调用 ${opName}`);
    }
    let params: Record<string, unknown>;
    try {
      params = await readParams(request);
    } catch (err) {
      return writeError(400, 'invalid_request', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    // 项目根由宿主定，插件给的不算。
    delete params.project_root;
    try {
      const t = runWriteTask(s, p, 'station.call', `${station.manifest.name} 调用 ${opName}`, async (signal) => {
        // 执行进程只跑编排工具本来就能用的操作（ONSET_OP_SCOPE），清单写什么都越不过去。
        await runStudioOp(s, signal, p, opName, params, { env: { [OpScopeEnv]: 'orchestrator' } });
      });
      return writeJSON(202, goMap({ task_id: t.task_id }));
    } catch (err) {
      return writeTaskError(err);
    }
  }
  return writeError(404, 'not_found', 'Studio API 路径不存在');
}

// ---------------------------------------------------------------------------
// 事件钩子

/**
 * 事件发生时，跑挂在这个事件上的插件操作（各自一个写任务）。插件对所有项目生效，但事件只来自当前打开的项目，
 * 操作也只在这个项目里跑。项目正忙（一轮对话、另一个写任务）时
 * 这一次跳过并记一条失败的任务说明，不排队：钩子是「顺手做」的事，不能挡住用户的下一步。
 * 第三方站自己的任务结束不触发 task.finished，免得钩子互相触发、没完没了。
 */
onStudioEvent((s, p, event, payload) => emitStationHook(s, p, event, payload));

/** 定时任务上一次跑的时间：按「项目 站 操作」记，客户端重启后从头算（重启后第一次检查就跑一次）。 */
const lastScheduled = new Map<string, number>();

/**
 * 检查插件的定时任务，到点的在当前打开的项目里各起一个写任务（没打开项目就不跑）。项目正忙就等下一次检查，不排队、不补跑。
 * 客户端每分钟调一次（Server 的定时器）；返回这次起了哪些，测试用。
 */
export function tickStationSchedules(s: Server, now = Date.now()): string[] {
  let p: Project;
  try {
    p = s.currentProject();
  } catch {
    return [];
  }
  let stations: flow.LoadedStation[];
  try {
    stations = flow.loadStations().stations;
  } catch {
    return [];
  }
  const started: string[] = [];
  for (const station of stations) {
    for (const sc of station.manifest.schedules) {
      const key = `${p.path}\n${station.manifest.id}\n${sc.op}`;
      const last = lastScheduled.get(key);
      if (last !== undefined && now - last < sc.every_minutes * 60_000) continue;
      const op = station.manifest.ops.find((o) => o.name === sc.op);
      if (!op) continue;
      let params: Record<string, unknown>;
      try {
        params = flow.checkParams(op, {});
      } catch {
        continue;
      }
      try {
        runWriteTask(s, p, 'station.schedule', `${station.manifest.name}：${op.summary}（每 ${sc.every_minutes} 分钟）`, (signal, task) =>
          runStationTask(s, signal, p, task, station.manifest.id, op.name, params, { name: 'schedule', every_minutes: sc.every_minutes }),
        );
        lastScheduled.set(key, now);
        started.push(`${station.manifest.id}/${op.name}`);
      } catch {
        // 项目正忙：下一次检查再说。
      }
    }
  }
  return started;
}

export function emitStationHook(s: Server, p: Project, event: flow.HookEvent, payload: Record<string, unknown> = {}): void {
  let stations: flow.LoadedStation[];
  try {
    stations = flow.loadStations().stations;
  } catch {
    return;
  }
  for (const station of stations) {
    for (const hook of station.manifest.hooks) {
      if (hook.on !== event) continue;
      const op = station.manifest.ops.find((o) => o.name === hook.op);
      if (!op) continue;
      let params: Record<string, unknown>;
      try {
        params = flow.checkParams(op, {});
      } catch {
        continue; // 有必填参数的操作挂不了钩子：没人替它填。
      }
      try {
        runWriteTask(s, p, 'station.hook', `${station.manifest.name}：${op.summary}（${event}）`, (signal, task) =>
          runStationTask(s, signal, p, task, station.manifest.id, op.name, params, { name: event, ...payload }),
        );
      } catch {
        // 项目正忙：这次不跑。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 插件页面

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
  if (rest === '_sdk.js') return new Response(pageSDK, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
  if (rest === '_pet.js') return new Response(petDragScript, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
  // 插件页面只在打开的项目里用（它要的项目数据经宿主转交）。
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const cut = rest.indexOf('/');
  if (cut <= 0) return notFound();
  const id = rest.slice(0, cut);
  const file = rest.slice(cut + 1);
  const station = flow.loadStations().stations.find((x) => x.manifest.id === id);
  if (!station || file === '' || file.split('/').some((seg) => seg === '..' || seg === '' || seg.startsWith('.'))) return notFound();
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
    return new Response(request.method === 'HEAD' ? null : withPetDrag(fs.readFileSync(real, 'utf8')), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
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
const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

/** GET /api/stations/<站>/read?path=：插件页面经宿主读项目文件，只给清单声明过的路径。 */
function readForPage(root: string, station: flow.LoadedStation, rel: string): Response {
  const id = station.manifest.id;
  if (!flow.pageMayRead(station.manifest, rel)) return writeError(403, 'forbidden', `第三方站 ${id} 没有声明要读 ${rel}`);
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
    if (info.size > maxReadBytes) return writeError(413, 'too_large', `${rel} 太大（${info.size} 字节），页面只能读 ${maxReadBytes} 字节以内的文件`);
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
