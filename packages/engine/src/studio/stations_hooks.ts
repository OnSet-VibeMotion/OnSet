/**
 * 插件事件钩子与定时任务调度。
 */
import * as flow from '../flow';
import { runStationTask } from './stations_run';
import type { Project, Server } from './studio';
import { runWriteTask } from './tasks';

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
        runWriteTask(
          s,
          p,
          'station.schedule',
          `${station.manifest.name}：${op.summary}（每 ${sc.every_minutes} 分钟）`,
          (signal, task) =>
            runStationTask(s, signal, p, task, station.manifest.id, op.name, params, {
              name: 'schedule',
              every_minutes: sc.every_minutes,
            }),
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

export function emitStationHook(
  s: Server,
  p: Project,
  event: flow.HookEvent,
  payload: Record<string, unknown> = {},
): void {
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
