/**
 * 插件操作执行、越界检查与最近一次执行记录。
 */
import path from 'node:path';
import { envMap } from '../envutil';
import * as flow from '../flow';
import { goMap, writeJSON } from './http';
import { emit, getSession, kindNotice, listSessions } from './sessions';
import type { Project, Server } from './studio';
import { addTask, runStudioOp, runTask, runUserOp, type Task, updateTask, warnTask } from './tasks';

/** 最近一次从界面执行的结果，按「项目 站 操作」记，客户端重启就没了（站自己写的回执才是凭据）。 */
export interface LastRun {
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

/** 取某站某操作最近一次执行记录：不需要项目的操作在当前项目与无项目记录之间取较新的那次。 */
export function getLastRun(root: string, stationID: string, op: flow.ManifestOp): LastRun | undefined {
  const inProject = lastRuns.get(`${root}\n${stationID}\n${op.name}`);
  const outside = op.project === false && root !== '' ? lastRuns.get(`\n${stationID}\n${op.name}`) : undefined;
  return outside && (!inProject || outside.at > inProject.at) ? outside : inProject;
}

/** 装、去掉、更新插件：不占项目写锁（插件在用户级），没有打开项目也能做。操作的 data 放进任务的 result。 */
export function startUserTask(
  s: Server,
  type: string,
  message: string,
  name: string,
  params: Record<string, unknown>,
): Response {
  const t = addTask(s, type, message);
  runTask(s, t, async (signal) => {
    const r = await runUserOp(s, signal, name, params);
    t.result = r.data;
  });
  return writeJSON(202, goMap({ task_id: t.task_id }));
}

function progressTextHandler(s: Server, task: Task): (text: string) => void {
  let pending = '';
  return (text: string) => {
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const progress = flow.parseProgressLine(line);
      if (progress) {
        updateTask(
          s,
          task.task_id,
          'running',
          progress.message || task.message,
          Math.max(0.1, Math.min(0.99, progress.progress)),
          null,
        );
      }
    }
  };
}

/**
 * 跑一条第三方操作：插件写的 onset-progress 行变成任务进度；结果记进 lastRuns。
 *
 * 客户端启动的操作由宿主扫描项目改动，写入任务进度和结构化结果；钩子和定时操作还会在对话里发提示。
 * shared 表示网页操作未占写锁。扫描期间另有写入者时只检查片场保留路径，不归责普通改动。只有一个写入者时照常检查。
 */
export async function runStationTask(
  s: Server,
  signal: AbortSignal,
  p: Project,
  task: Task,
  id: string,
  op: string,
  params: Record<string, unknown>,
  event?: Record<string, unknown>,
  shared = false,
): Promise<void> {
  const key = `${p.path}\n${id}\n${op}`;
  const onText = progressTextHandler(s, task);
  const station = flow.loadStations().stations.find((x) => x.manifest.id === id);
  const before = station ? flow.statProject(p.path) : null;
  const epoch = s.writeEpoch(p.path);
  const hasOtherWriter = () => s.hasSharedWriter(p.path, task.task_id) || (shared && s.busyHolder(p.path) !== '');
  const othersAtStart = hasOtherWriter();
  const scope = () => {
    if (!station || !before) return null;
    const reservedOnly = othersAtStart || hasOtherWriter() || s.writeEpoch(p.path) !== epoch;
    const r = flow.scopeReport(station.manifest, before, flow.statProject(p.path), { reservedOnly });
    if (r) reportScope(s, p, task, station.manifest.name, r, event);
    return r;
  };
  const scopeFields = (r: flow.ScopeReport | null) =>
    r
      ? {
          out_of_scope: r.out_of_scope,
          out_of_scope_more: r.out_of_scope_more,
          ...(r.reserved.length > 0 ? { reserved: r.reserved } : {}),
        }
      : {};
  let browser: flow.StationBrowserLease | undefined;
  try {
    if (
      !event &&
      station?.manifest.browser &&
      station.manifest.ops.find((o) => o.name === op)?.trigger === 'user' &&
      s.config.stationBrowser
    ) {
      browser = await s.config.stationBrowser({
        id,
        name: station.manifest.name,
        origins: station.manifest.browser.origins,
        project_root: p.path,
        data_dir: path.join(flow.stationsDir(envMap()), id, 'data'),
      });
    }
    const r = await runStudioOp(
      s,
      signal,
      p,
      'station_run',
      {
        station: id,
        op,
        params: JSON.stringify(params),
        event: event ? JSON.stringify(event) : '',
        project_root: p.path,
        host_scope: true,
      },
      { onText, ...(browser ? { env: { [flow.StationBrowserEnv]: JSON.stringify(browser.connection) } } : {}) },
    );
    const report = scope();
    if (report && report.reserved.length > 0) {
      const files = report.reserved.join('、');
      const reason = report.out_of_scope.length
        ? `第三方站 ${id} 的 ${op} 写了片场自己的文件（${files}），按失败处理`
        : `插件执行期间检测到片场保留文件有改动（${files}），并发写入无法判定归属，操作按失败处理`;
      const err = new Error(reason);
      lastRuns.set(key, {
        task_id: task.task_id,
        at: new Date().toISOString(),
        ok: false,
        text: err.message,
        ...scopeFields(report),
      });
      throw Object.assign(err, { scopeReported: true });
    }
    lastRuns.set(key, {
      task_id: task.task_id,
      at: new Date().toISOString(),
      ok: true,
      text: stripProgress(r.text).slice(-maxRunText),
      ...(r.data !== undefined ? { data: r.data } : {}),
      ...scopeFields(report),
    });
    // 打开了项目时，不需要项目的操作（例如登录）也走这里：设置弹窗读 result 里插件的说明。
    task.result = taskResult(
      station?.manifest.ops.find((o) => o.name === op),
      r.data,
    );
  } catch (err) {
    if (!(err as { scopeReported?: boolean }).scopeReported) {
      lastRuns.set(key, {
        task_id: task.task_id,
        at: new Date().toISOString(),
        ok: false,
        text: (err as Error).message.slice(-maxRunText),
        ...scopeFields(scope()),
      });
    }
    throw err;
  } finally {
    browser?.dispose();
  }
}

/**
 * 用户点的、要用片场网页窗口的插件操作（清单有 browser、操作 trigger: user）：不占项目写锁。
 * 它们大多在等网站（上传一个大视频要半小时），占着写锁会挡住对话、渲染，也挡住别的插件同时上传；
 * 它们只写自己声明的目录。同一个账号的页面同一时间只归一项操作（宿主的网页容器拒绝第二个）。
 */
export function sharedStationOp(station: flow.LoadedStation, op: flow.ManifestOp): boolean {
  return !!station.manifest.browser && op.trigger === 'user';
}

/** 没打开项目时跑不需要项目的操作：不扫越界；结果记在 lastRuns 的空项目键下。 */
export async function runUserStationTask(
  s: Server,
  signal: AbortSignal,
  task: Task,
  station: flow.LoadedStation,
  op: string,
  params: Record<string, unknown>,
): Promise<void> {
  const id = station.manifest.id;
  const key = `\n${id}\n${op}`;
  const onText = progressTextHandler(s, task);
  let browser: flow.StationBrowserLease | undefined;
  try {
    if (station.manifest.browser && s.config.stationBrowser) {
      browser = await s.config.stationBrowser({
        id,
        name: station.manifest.name,
        origins: station.manifest.browser.origins,
        project_root: '',
        data_dir: path.join(flow.stationsDir(envMap()), id, 'data'),
      });
    }
    const r = await runUserOp(
      s,
      signal,
      'station_run',
      { station: id, op, params: JSON.stringify(params), event: '', project_root: '' },
      { onText, ...(browser ? { env: { [flow.StationBrowserEnv]: JSON.stringify(browser.connection) } } : {}) },
    );
    lastRuns.set(key, {
      task_id: task.task_id,
      at: new Date().toISOString(),
      ok: true,
      text: stripProgress(r.text).slice(-maxRunText),
      ...(r.data !== undefined ? { data: r.data } : {}),
    });
    // 设置里的弹窗等任务跑完后读 result 里插件的说明（例如「已登录：昵称」）。
    task.result = taskResult(
      station.manifest.ops.find((o) => o.name === op),
      r.data,
    );
  } catch (err) {
    lastRuns.set(key, {
      task_id: task.task_id,
      at: new Date().toISOString(),
      ok: false,
      text: (err as Error).message.slice(-maxRunText),
    });
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
function reportScope(
  s: Server,
  p: Project,
  task: Task,
  name: string,
  r: flow.ScopeReport,
  event?: Record<string, unknown>,
): void {
  const total = r.out_of_scope.length + r.out_of_scope_more;
  const files = r.out_of_scope.join('、') + (r.out_of_scope_more > 0 ? ` 等 ${total} 个` : '');
  const text =
    r.reserved.length > 0
      ? r.out_of_scope.length
        ? `插件「${name}」写了片场自己的文件（${files}），这次操作按失败处理。文件已经写了，没法自动撤销：可以回退那一轮对话，或者用 git 恢复。`
        : `插件「${name}」执行期间片场保留文件有改动（${r.reserved.join('、')}），并发写入无法判定归属。`
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
