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
import { envMap } from '../envutil';
import * as flow from '../flow';
import { OpScopeEnv } from '../opworker';
import { onStudioEvent } from './events';
import { DecodeError, decodeJSON, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { emitStationHook, tickStationSchedules } from './stations_hooks';
import { runStationTask, runUserStationTask, sharedStationOp, startUserTask } from './stations_run';
import {
  pageCSP,
  pageHostTimeoutMs,
  pageSDK,
  pageURL,
  petDragScript,
  readForPage,
  stationMediaAPI,
  stationUIAPI,
} from './stations_ui';
import { listStations, stationJSON } from './stations_view';
import type { Server } from './studio';
import { addTask, runStudioOp, runTask, runWriteTask, writeTaskError } from './tasks';

export {
  emitStationHook,
  listStations,
  pageCSP,
  pageHostTimeoutMs,
  pageSDK,
  pageURL,
  petDragScript,
  sharedStationOp,
  startUserTask,
  stationMediaAPI,
  stationUIAPI,
  tickStationSchedules,
};

async function readParams(request: Request): Promise<Record<string, unknown>> {
  const body = await decodeJSON(request);
  const raw = body.params ?? {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('params 要是对象');
  return raw as Record<string, unknown>;
}

export async function stationsAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const parts = rest
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);

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
    if (parts[2] === 'install') {
      return startUserTask(s, 'station.install', `装上插件：${staged.preview.name}`, 'station_install', {
        staged: token,
      });
    }
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
    if (flow.parseSource(entry.source).kind === 'link') {
      return writeError(400, 'invalid_request', `插件 ${id} 来自本机目录，改动立即生效，不需要更新`);
    }
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
    const label = `${station.manifest.name}：${op.summary}`;
    if (sharedStationOp(station, op)) {
      const t = addTask(s, 'station.run', label);
      s.beginShared(t.task_id, p.path, label);
      runTask(s, t, async (signal) => {
        try {
          await runStationTask(s, signal, p, t, id, opName, params, undefined, true);
        } finally {
          s.endShared(t.task_id);
        }
      });
      return writeJSON(202, goMap({ task_id: t.task_id }));
    }
    try {
      const t = runWriteTask(s, p, 'station.run', label, (signal, task) =>
        runStationTask(s, signal, p, task, id, opName, params),
      );
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

/**
 * 事件发生时，跑挂在这个事件上的插件操作（各自一个写任务）。插件对所有项目生效，但事件只来自当前打开的项目，
 * 操作也只在这个项目里跑。项目正忙（一轮对话、另一个写任务）时
 * 这一次跳过并记一条失败的任务说明，不排队：钩子是「顺手做」的事，不能挡住用户的下一步。
 * 第三方站自己的任务结束不触发 task.finished，免得钩子互相触发、没完没了。
 */
onStudioEvent((s, p, event, payload) => emitStationHook(s, p, event, payload));
