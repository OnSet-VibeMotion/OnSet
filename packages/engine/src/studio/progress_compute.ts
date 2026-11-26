/**
 * 制作路线状态计算与轮次归站。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as flow from '../flow';
import type * as plugin from '../plugin';
import { gateChanged, mtime, readGates } from './progress_gates';
import { type Ctx, stationDefs } from './progress_judges';
import { discoverScenes, type SceneSummary } from './scenes';
import { localRFC3339 } from './script';
import { decodeTurn, studioRoot } from './turns';

/** 一站：普通站看产物，关卡看用户的确认。step 是它归在顶栏哪一步下（页面 id）。 */
export interface Station {
  id: string;
  label: string;
  step: string;
  gate?: boolean;
  /** 可选的站（整片风格）：不做也不挡路，不会成为「现在在这」。 */
  optional?: boolean;
  /**
   * 普通站：done 做过 / skipped 没留下产物但后面已经做了 / stale 上游改过、要重做 / todo 没做。
   * 关卡：confirmed 你确认过 / passed 已经过了（没有确认记录）/ changed 确认后又改过 / todo 还没到或在等你。
   */
  status: 'done' | 'skipped' | 'stale' | 'todo' | 'confirmed' | 'passed' | 'changed';
  /** 上游改过时是哪儿改了（NodeJudge.staleNote）；没有就用通用说法。 */
  stale_note?: string;
  /** 一句结果：几个镜头、几条字幕、还差几个镜头……；没有可说的为空。 */
  detail?: string;
  /** 产物最后一次写入或确认的时间（RFC 3339，本地时区）。 */
  at?: string;
  /** 关卡是在对话里确认的：用户的原话。 */
  said?: string;
  /** 去哪看：页面 id，或 file 加 file 路径。 */
  page?: string;
  file?: string;
  /** 动过这一站的几轮对话，新的在前。 */
  turns: StationTurn[];
  /** 内置插件给这一站写的「接下来」说法（NodeJudge.guide）。 */
  guide?: {
    ai?: string;
    user?: string;
    page?: string;
    page_label?: string;
    actions?: plugin.PluginGuideAction[];
    confirm?: string;
  };
}

export interface StationTurn {
  turn_id: string;
  session_id: string;
  /** 用户那句话的第一行（截断）。 */
  message: string;
  status: string;
  at: string;
  /** 这一轮在这一站改了几个文件，及前几个的路径。 */
  files: number;
  paths: string[];
}

export interface ProgressResponse {
  /** 流程 id（flow.FlowID）。 */
  mode: flow.FlowID;
  stations: Station[];
  /** 现在在哪一站；全部做完时为空。 */
  current: string;
  /** 现在在等谁：关卡等你，其余等 AI 做。全部做完时为空。 */
  waiting_on: '' | 'user' | 'ai';
  /** 每一轮推进到了哪几站（对话里每轮结尾的标签用），值是站的 label。 */
  turns: Record<string, string[]>;
}

/** 改过的文件归到哪一站；归不到的（Studio 状态、杂项）为空。规则来自各站声明的 produces。 */
export function stationOfPath(rel: string, mode: flow.FlowID, extras: readonly flow.ExtraStation[] = []): string {
  return flow.stationOfPath(rel, mode, extras);
}

// ---------------------------------------------------------------------------
// 轮次

interface TurnSummary {
  turn_id: string;
  session_id: string;
  message: string;
  status: string;
  at: string;
  paths: string[];
}

/** 轮次记录里带着整棵文件树，一份几十 KB；按修改时间缓存摘要，免得每次都重读。 */
const turnCache = new Map<string, { mtime: number; summary: TurnSummary | null }>();

function turnSummaries(root: string): TurnSummary[] {
  const dir = path.join(studioRoot(root), 'turns');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const out: TurnSummary[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const m = mtime(file);
    let cached = turnCache.get(file);
    if (!cached || cached.mtime !== m) {
      let summary: TurnSummary | null = null;
      try {
        const turn = decodeTurn(fs.readFileSync(file, 'utf8'));
        summary = {
          turn_id: turn.turn_id,
          session_id: turn.session_id,
          message: firstLine(turn.message),
          status: turn.status,
          at: turn.ended_at || turn.started_at,
          paths: (turn.changes ?? []).map((ch) => ch.path),
        };
      } catch {
        summary = null;
      }
      cached = { mtime: m, summary };
      turnCache.set(file, cached);
    }
    if (cached.summary) out.push(cached.summary);
  }
  return out.sort((a, b) => (a.turn_id < b.turn_id ? 1 : -1));
}

function firstLine(message: string): string {
  const line =
    message
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s !== '' && !/^@\S+$/.test(s)) ?? message.trim();
  return line.length > 60 ? line.slice(0, 60) + '…' : line;
}

// ---------------------------------------------------------------------------

/**
 * computeStations 只看文件，不读轮次（顶栏用它推步骤，每次刷新都要算）。
 * 返回各站的状态与现在在哪一站。
 */
export function computeStations(
  root: string,
  scenes: SceneSummary[],
): { mode: flow.FlowID; stations: Station[]; current: string; waiting_on: '' | 'user' | 'ai' } {
  const extras = flow.stationExtras();
  const mode = flow.detectFlow(root, extras);
  const pilotGate = flow.isPilotGateEnabled(root);
  const defs = stationDefs(mode, extras, { pilotGate });
  const ctx: Ctx = { root, scenes, gates: readGates(root) };
  // 关卡有确认（批准记录、确认过的网格、gates.json）也算「后面已经做了」，前面没留产物的站因此算跳过。
  const outputs = defs.map((d) =>
    d.gate ? (ctx.gates[d.id] || (d.gateState && d.gateState(ctx).status !== 'todo') ? 1 : 0) : d.output(ctx),
  );
  const stations: Station[] = defs.map((d, i) => {
    const station: Station = { id: d.id, label: d.label, step: d.step, status: 'todo', turns: [] };
    if (d.gate) station.gate = true;
    if (d.optional) station.optional = true;
    if (d.page) station.page = d.page;
    if (d.file) station.file = d.file;
    const g = d.guideFor ? d.guideFor(ctx) : d.guide;
    if (g) {
      station.guide = {
        ai: g.ai,
        user: g.user,
        page: g.page,
        page_label: g.pageLabel,
        actions: g.actions,
        confirm: g.confirm,
      };
    }
    // 第三方站的产物不算「后面已经做了」：宿主不凭插件写的文件推断自带流程走到了哪（插件一发布，前面全成了跳过）。
    // 开启单镜打样闸门后，gate-pilot 不参与 laterDone 推断，只能由有效确认完成，避免多镜已有产物时静默跳过打样审核。
    const laterDone =
      d.id === flow.PilotGateID
        ? false
        : outputs.some((t, j) => j > i && t > 0 && !defs[j].optional && !defs[j].declared);
    if (d.gate) {
      const own = d.gateState?.(ctx);
      const record = ctx.gates[d.id];
      if (own && own.status !== 'todo') {
        station.status = own.status;
        if (own.at !== undefined) station.at = typeof own.at === 'string' ? own.at : localRFC3339(new Date(own.at));
      } else if (record) {
        station.status = gateChanged(root, record, d.id) ? 'changed' : 'confirmed';
        station.at = record.at;
        if (record.said) station.said = record.said;
      } else if (laterDone) station.status = 'passed';
    } else {
      const out = outputs[i];
      if (out > 0) {
        station.status = d.stale?.(ctx, out) ? 'stale' : 'done';
        if (station.status === 'stale') {
          const note = d.staleNote?.(ctx, out);
          if (note) station.stale_note = note;
        }
        station.at = localRFC3339(new Date(out));
      } else if ((d.id === 'render' || d.id === 'review') && d.stale?.(ctx, 0)) {
        station.status = 'stale';
      } else if (laterDone && !d.optional && !d.inProgress?.(ctx)) station.status = 'skipped';
    }
    const detail = d.detail?.(ctx);
    if (detail) station.detail = detail;
    return station;
  });
  const complete = (s: Station) => s.optional || ['done', 'skipped', 'confirmed', 'passed'].includes(s.status);
  const current = stations.find((s) => !complete(s));
  let waiting: '' | 'user' | 'ai' = !current ? '' : current.gate ? 'user' : 'ai';
  // 站点自己知道在等谁时听它的（例如发布信息只差上传前的人工检查，是在等你）。
  const own = current ? defs[stations.indexOf(current)].waiting?.(ctx) : undefined;
  if (own) waiting = own;
  return { mode, stations, current: current?.id ?? '', waiting_on: waiting };
}

/** 各站的产物里最新的一次写入（毫秒），判断编排工具的步骤标记是不是比产物新。 */
export function latestOutput(root: string, scenes: SceneSummary[]): number {
  const ctx: Ctx = { root, scenes, gates: {} };
  const extras = flow.stationExtras();
  const pilotGate = flow.isPilotGateEnabled(root);
  return Math.max(
    0,
    ...stationDefs(flow.detectFlow(root, extras), extras, { pilotGate })
      .filter((d) => !d.gate)
      .map((d) => d.output(ctx)),
  );
}

const maxStationTurns = 12;

export function readProgress(root: string): ProgressResponse {
  const scenes = discoverScenes(root);
  const base = computeStations(root, scenes);
  const extras = flow.stationExtras();
  const byID = new Map(base.stations.map((s) => [s.id, s]));
  const labels: Record<string, string[]> = {};
  for (const turn of turnSummaries(root)) {
    const groups = new Map<string, string[]>();
    for (const p of turn.paths) {
      const id = stationOfPath(p, base.mode, extras);
      if (!id || !byID.has(id)) continue;
      const list = groups.get(id) ?? [];
      list.push(p);
      groups.set(id, list);
    }
    if (groups.size === 0) continue;
    // 按站的顺序排，标签读起来是制作的先后。
    const ids = base.stations.map((s) => s.id).filter((id) => groups.has(id));
    labels[turn.turn_id] = ids.map((id) => byID.get(id)!.label);
    for (const id of ids) {
      const station = byID.get(id)!;
      if (station.turns.length >= maxStationTurns) continue;
      const paths = groups.get(id)!;
      station.turns.push({
        turn_id: turn.turn_id,
        session_id: turn.session_id,
        message: turn.message,
        status: turn.status,
        at: turn.at,
        files: paths.length,
        paths: paths.slice(0, 5),
      });
    }
  }
  return { ...base, turns: labels };
}
