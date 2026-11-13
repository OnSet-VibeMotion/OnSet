/**
 * 制作路线：把整片制作拆成十几站，告诉用户做过什么、现在在哪、在等谁。
 *
 * 每一站做没做只看项目里的产物（不靠编排工具汇报，它会忘、会标错）；上游产物比下游新时，下游标成
 * 「上游改过」。审核关卡另记用户的确认（`production/studio/gates.json`，界面的「确认」按钮写）：
 * 记下确认时相关文件的状态，文件之后又变了就算「改过，要重新确认」；没有记录但下游已经做了的，算
 * 「已经过了」（在对话里点头的、老项目）。「做了什么」取自轮次记录：每一轮改过的文件按路径归到站上。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as beat from '../beat';
import * as flow from '../flow';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import * as plugin from '../plugin';
import * as studioview from '../studioview';
import { promptSource } from '../project/runprompt';
import { sameDownbeats } from './api_ui';
import { writeError, writeJSON } from './http';
import { discoverScenes, fileExists, type SceneSummary } from './scenes';
import { readStoryboard } from './storyboard';
import { localRFC3339 } from './script';
import type { Server } from './studio';
import { emitStudioEvent } from './events';
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
  /** 一句结果：几个镜头、几条字幕、还差几个镜头……；没有可说的为空。 */
  detail?: string;
  /** 产物最后一次写入或确认的时间（RFC 3339，本地时区）。 */
  at?: string;
  /** 去哪看：页面 id，或 file 加 file 路径。 */
  page?: string;
  file?: string;
  /** 动过这一站的几轮对话，新的在前。 */
  turns: StationTurn[];
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
  /** 制作说明用的是项目里改过的那份文件（只在是的时候出现）：路线页提示用户。 */
  custom_prompt?: true;
}

/** 关卡确认记录。 */
export const gatesPath = 'production/studio/gates.json';

interface GateRecord {
  at: string;
  files: Record<string, string>;
}

/** 关卡绑定的文件：确认后它们变了，确认就不算数。来自各站的声明，项目加的第三方站的关卡也算。 */
function gateFilesFor(root: string): Record<string, string[]> {
  const out = flow.gateFiles();
  for (const x of flow.projectExtras(root)) {
    for (const node of x.station.nodes) if (node.gateFiles && !out[node.id]) out[node.id] = node.gateFiles;
  }
  return out;
}

/** 可以经界面按钮记确认的关卡。试听确认（approval.json）与节拍确认（grid.json）由编排与 am 写，不在这里。 */
export function gateIDs(root = ''): string[] {
  return Object.keys(root === '' ? flow.gateFiles() : gateFilesFor(root));
}

// ---------------------------------------------------------------------------
// 文件状态

const maxHashBytes = 2 << 20;

/** 小文件记内容摘要，大文件（音频、视频）只记大小与修改时间；读不到为空串。 */
function fileState(file: string): string {
  try {
    const info = fs.statSync(file);
    if (!info.isFile()) return '';
    if (info.size > maxHashBytes) return `stat:${info.size}:${Math.floor(info.mtimeMs)}`;
    return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 目录里最新的文件修改时间（不进子目录以外的深处：只看两层），没有文件为 0。 */
function dirMtime(dir: string, depth = 2): number {
  let newest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) newest = Math.max(newest, mtime(full));
    else if (entry.isDirectory() && depth > 1) newest = Math.max(newest, dirMtime(full, depth - 1));
  }
  return newest;
}

/** 目录里的文件数（同 dirMtime 只看两层，不算点开头的）。 */
function countFiles(dir: string, depth = 2): number {
  let n = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile()) n++;
    else if (entry.isDirectory() && depth > 1) n += countFiles(path.join(dir, entry.name), depth - 1);
  }
  return n;
}

export function readGates(root: string): Record<string, GateRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, gatesPath), 'utf8')) as Record<string, unknown>;
    const gates = raw.gates;
    if (gates === null || typeof gates !== 'object' || Array.isArray(gates)) return {};
    const out: Record<string, GateRecord> = {};
    for (const [id, value] of Object.entries(gates as Record<string, unknown>)) {
      const v = value as Record<string, unknown> | null;
      if (!v || typeof v.at !== 'string' || v.files === null || typeof v.files !== 'object') continue;
      out[id] = { at: v.at, files: v.files as Record<string, string> };
    }
    return out;
  } catch {
    return {};
  }
}

/** 记下用户确认了某个关卡：绑定的文件一个都没有时拒绝（没东西可确认）。 */
export function recordGate(root: string, id: string, now = new Date()): GateRecord {
  const bound = gateFilesFor(root)[id];
  if (!bound) throw new Error(`没有这个审核关卡：${id}`);
  const files: Record<string, string> = {};
  for (const rel of bound) {
    const state = fileState(path.join(root, rel));
    if (state) files[rel] = state;
  }
  if (Object.keys(files).length === 0) throw new Error('要确认的内容还没写出来');
  const gates = readGates(root);
  const record = { at: localRFC3339(now), files };
  gates[id] = record;
  const sorted: Record<string, GateRecord> = {};
  for (const key of Object.keys(gates).sort()) sorted[key] = gates[key];
  atomicWrite(path.join(root, gatesPath), marshalIndent({ version: 1, gates: sorted }) + '\n', 0o644);
  return record;
}

function gateChanged(root: string, record: GateRecord): boolean {
  return Object.entries(record.files).some(([rel, state]) => fileState(path.join(root, rel)) !== state);
}

// ---------------------------------------------------------------------------
// 站的定义

interface Ctx {
  root: string;
  scenes: SceneSummary[];
  gates: Record<string, GateRecord>;
}

/**
 * 一站做没做的判断。站点的名字、归哪一步、是不是关卡来自流程声明（flow.route）。
 * 与内置插件在 apply 里登记的判断函数是同一种写法（plugin.NodeJudge）。
 */
type Judge = plugin.NodeJudge<Ctx>;

type Def = flow.RouteNode & Judge & { output: (c: Ctx) => number };

const f = (c: Ctx, rel: string) => mtime(path.join(c.root, rel));
const anyOf = (c: Ctx, ...rels: string[]) => Math.max(0, ...rels.map((rel) => f(c, rel)));

function sceneOutputs(c: Ctx): number[] {
  return c.scenes.filter((sc) => sc.exists && sc.output).map((sc) => mtime(path.join(sc.directory, sc.output!)));
}

function storyboardDetail(c: Ctx): string | undefined {
  try {
    const board = readStoryboard(c.root);
    if (board.scenes.length === 0) return undefined;
    const chapters = new Set(board.scenes.map((sc) => sc.chapter).filter(Boolean));
    return `${board.scenes.length} 个镜头` + (chapters.size > 0 ? ` · ${chapters.size} 章` : '');
  } catch {
    return undefined;
  }
}

function readGrid(root: string, rel: string): beat.Grid | null {
  if (!fileExists(path.join(root, rel))) return null;
  try {
    return beat.readDraft(path.join(root, rel));
  } catch {
    return null;
  }
}

/** 宿主自带的站的判断，键是「站:站点」：口播与卡点的「拆分镜头」同叫 plan，判断不同。内置插件的判断随它登记（pluginJudges）。 */
const judges: Record<string, Judge> = {
  'intake:intake': { output: (c) => anyOf(c, 'production/input-inventory.md', 'production/production-config.json') },
  'script:script': {
    output: (c) => f(c, 'production/script-final.md'),
    detail: (c) => {
      try {
        // 以 # 开头的行是标题，不进配音，不算字数。
        const text = fs
          .readFileSync(path.join(c.root, 'production', 'script-final.md'), 'utf8')
          .split('\n')
          .filter((line) => !line.startsWith('#'))
          .join('\n');
        const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
        return han > 0 ? `约 ${han} 字` : undefined;
      } catch {
        return undefined;
      }
    },
  },
  // 不按稿子比配音新判过期：编排常在配好音后再改稿里的读法、短语标记，朗读的字没变。
  'voice:voice': { output: (c) => f(c, 'production/audio/voice.wav') },
  'timeline:timeline': {
    output: (c) => f(c, 'production/audio/voice.srt'),
    stale: (c, out) => f(c, 'production/audio/voice.wav') > out,
    detail: (c) => {
      try {
        const n = fs.readFileSync(path.join(c.root, 'production', 'audio', 'voice.srt'), 'utf8').split('-->').length - 1;
        return n > 0 ? `${n} 条字幕` : undefined;
      } catch {
        return undefined;
      }
    },
  },
  'style:style': {
    output: (c) => f(c, '.agents/skills/am-film-style/am-film-style.json') || f(c, '.agents/skills/lemo-film-style/lemo-upstream.json'),
    detail: (c) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(c.root, '.agents/skills/am-film-style/am-film-style.json'), 'utf8')) as Record<string, unknown>;
        return typeof raw.cn === 'string' && raw.cn ? raw.cn : undefined;
      } catch {
        return undefined;
      }
    },
  },
  'plan:plan': {
    output: (c) => f(c, 'production/scene-plan.json'),
    stale: (c, out) => f(c, 'production/audio/voice.srt') > out,
    detail: storyboardDetail,
  },
  // 渲染：全部镜头出片才算做完，结果写几个出了片。
  'render:render': {
    output: (c) => {
      if (c.scenes.length === 0 || !c.scenes.every((sc) => sc.exists)) return 0;
      return Math.max(0, ...sceneOutputs(c));
    },
    stale: (c) => c.scenes.some((sc) => sc.stale),
    detail: (c) => {
      if (c.scenes.length === 0) return undefined;
      const done = c.scenes.filter((sc) => sc.exists && !sc.stale).length;
      const stale = c.scenes.filter((sc) => sc.exists && sc.stale).length;
      return `${done} / ${c.scenes.length} 个镜头出片` + (stale ? `，${stale} 个要重渲染` : '');
    },
  },
  'visual-qc:visual-qc': {
    output: (c) => dirMtime(path.join(c.root, 'production', 'visual-qc')),
    detail: (c) => {
      const n = countFiles(path.join(c.root, 'production', 'visual-qc'));
      return n > 0 ? `${n} 份截图与检查记录` : undefined;
    },
  },
  'assemble:assemble': {
    output: (c) => f(c, 'production/silent-master.mp4'),
    stale: (c, out) => sceneOutputs(c).some((t) => t > out),
  },
  'sound:sound': {
    output: (c) => f(c, 'production/audio/candidate.mp4'),
    stale: (c, out) => f(c, 'production/silent-master.mp4') > out,
  },
  'review:review': {
    output: (c) => f(c, 'production/review/review.json'),
    stale: (c, out) => f(c, 'production/audio/candidate.mp4') > out,
    detail: (c) => {
      try {
        const report = JSON.parse(fs.readFileSync(path.join(c.root, 'production', 'review', 'review.json'), 'utf8')) as Record<string, unknown>;
        const problems = Array.isArray(report.problems) ? report.problems.length : 0;
        return problems === 0 ? '机器检查没有问题' : `${problems} 个问题`;
      } catch {
        return undefined;
      }
    },
  },
  'review:gate-final': {
    gateState: (c) => {
      const file = path.join(c.root, 'production', 'approval.json');
      const approved = mtime(file);
      if (approved === 0) return { status: 'todo' };
      let at: number | string = approved;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (typeof raw.approved_at === 'string' && !Number.isNaN(Date.parse(raw.approved_at))) at = Date.parse(raw.approved_at);
      } catch {
        // 写坏的批准记录照样算有，时间取文件的。
      }
      return { status: f(c, 'production/audio/candidate.mp4') > approved ? 'changed' : 'confirmed', at };
    },
  },
  'beat-story:story': { output: (c) => f(c, beat.Store + '/story.md') },
  'beat-music:music': { output: (c) => f(c, beat.TrackFile) },
  'beat-music:grid': {
    output: (c) => anyOf(c, beat.DraftFile, beat.GridFile),
    stale: (c, out) => f(c, beat.TrackFile) > out,
  },
  'beat-music:gate-grid': {
    gateState: (c) => {
      const grid = readGrid(c.root, beat.GridFile);
      if (!grid) return { status: 'todo' };
      const draft = readGrid(c.root, beat.DraftFile);
      const pending = draft !== null && !sameDownbeats(draft, grid);
      return { status: pending ? 'changed' : 'confirmed', at: f(c, beat.GridFile) };
    },
  },
  'beat-plan:plan': {
    output: (c) => f(c, beat.PlanFile),
    stale: (c, out) => f(c, beat.GridFile) > out,
  },
};

/** 内置插件在 apply 里登记的判断，键同 judges。 */
function pluginJudges(): Record<string, Judge> {
  const out: Record<string, Judge> = {};
  for (const { value: s } of plugin.pluginStations()) for (const [node, judge] of Object.entries(s.judges ?? {})) out[`${s.id}:${node}`] = judge;
  return out;
}

/** 第三方站点的声明式判断：outputs 里最新的修改时间；stale_after 里的站点产物比它新就要重做。 */
function declaredJudge(node: flow.RouteNode, byID: Map<string, Def>): Judge {
  const declared = node.declared!;
  const output = (c: Ctx) => Math.max(0, ...declared.outputs.map((rel) => {
    const full = path.join(c.root, rel);
    try {
      return fs.statSync(full).isDirectory() ? dirMtime(full) : mtime(full);
    } catch {
      return 0;
    }
  }));
  if (node.gate) return {};
  return {
    output,
    stale: declared.stale_after.length === 0 ? undefined : (c, out) => declared.stale_after.some((id) => (byID.get(id)?.output(c) ?? 0) > out),
  };
}

/** 流程的站点连同判断。内置的普通站必须有判断函数，漏了直接报错，不让一站永远显示「没做」。 */
export function stationDefs(id: flow.FlowID, extras: readonly flow.ExtraStation[] = []): Def[] {
  const byID = new Map<string, Def>();
  const registered = pluginJudges();
  return flow.route(id, extras).map(({ station, node }) => {
    const key = `${station}:${node.id}`;
    const judge = node.declared ? declaredJudge(node, byID) : judges[key] ?? registered[key] ?? {};
    if (!node.gate && !judge.output) throw new Error(`站点 ${station}:${node.id} 没有判断函数`);
    const def: Def = { ...node, ...judge, output: judge.output ?? (() => 0) };
    byID.set(node.id, def);
    return def;
  });
}

// ---------------------------------------------------------------------------
// 文件归站

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
  const line = message.split('\n').map((s) => s.trim()).find((s) => s !== '' && !/^@\S+$/.test(s)) ?? message.trim();
  return line.length > 60 ? line.slice(0, 60) + '…' : line;
}

// ---------------------------------------------------------------------------

/**
 * computeStations 只看文件，不读轮次（顶栏用它推步骤，每次刷新都要算）。
 * 返回各站的状态与现在在哪一站。
 */
export function computeStations(root: string, scenes: SceneSummary[]): { mode: flow.FlowID; stations: Station[]; current: string; waiting_on: '' | 'user' | 'ai' } {
  const extras = flow.projectExtras(root);
  const mode = flow.detectFlow(root, extras);
  const defs = stationDefs(mode, extras);
  const ctx: Ctx = { root, scenes, gates: readGates(root) };
  // 关卡有确认（批准记录、确认过的网格、gates.json）也算「后面已经做了」，前面没留产物的站因此算跳过。
  const outputs = defs.map((d) => (d.gate ? (ctx.gates[d.id] || (d.gateState && d.gateState(ctx).status !== 'todo') ? 1 : 0) : d.output(ctx)));
  const stations: Station[] = defs.map((d, i) => {
    const station: Station = { id: d.id, label: d.label, step: d.step, status: 'todo', turns: [] };
    if (d.gate) station.gate = true;
    if (d.optional) station.optional = true;
    if (d.page) station.page = d.page;
    if (d.file) station.file = d.file;
    // 第三方站的产物不算「后面已经做了」：宿主不凭插件写的文件推断自带流程走到了哪（插件一发布，前面全成了跳过）。
    const laterDone = outputs.some((t, j) => j > i && t > 0 && !defs[j].optional && !defs[j].declared);
    if (d.gate) {
      const own = d.gateState?.(ctx);
      const record = ctx.gates[d.id];
      if (own && own.status !== 'todo') {
        station.status = own.status;
        if (own.at !== undefined) station.at = typeof own.at === 'string' ? own.at : localRFC3339(new Date(own.at));
      } else if (record) {
        station.status = gateChanged(root, record) ? 'changed' : 'confirmed';
        station.at = record.at;
      } else if (laterDone) station.status = 'passed';
    } else {
      const out = outputs[i];
      if (out > 0) {
        station.status = d.stale?.(ctx, out) ? 'stale' : 'done';
        station.at = localRFC3339(new Date(out));
      } else if (d.id === 'render' && d.stale?.(ctx, 0)) {
        station.status = 'stale';
      } else if (laterDone && !d.optional) station.status = 'skipped';
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
  const extras = flow.projectExtras(root);
  return Math.max(0, ...stationDefs(flow.detectFlow(root, extras), extras).filter((d) => !d.gate).map((d) => d.output(ctx)));
}

const maxStationTurns = 12;

export function readProgress(root: string): ProgressResponse {
  const scenes = discoverScenes(root);
  const base = computeStations(root, scenes);
  const extras = flow.projectExtras(root);
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
  const out: ProgressResponse = { ...base, turns: labels };
  if (promptSource(root) === 'custom') out.custom_prompt = true;
  return out;
}

export async function progressAPI(s: Server, request: Request, rest: string): Promise<Response> {
  let root: string;
  try {
    root = s.currentProject().path;
  } catch (err) {
    return writeError(404, 'no_project', (err as Error).message);
  }
  if (rest === '') {
    if (request.method !== 'GET') return writeError(405, 'method_not_allowed', '只支持 GET');
    return writeJSON(200, readProgress(root));
  }
  const match = /^gates\/([a-z-]+)$/.exec(rest);
  if (!match) return writeError(404, 'not_found', 'Studio API 路径不存在');
  if (request.method !== 'POST') return writeError(405, 'method_not_allowed', '只支持 POST');
  if (!gateFilesFor(root)[match[1]]) return writeError(404, 'not_found', `没有这个审核关卡：${match[1]}`);
  try {
    const record = recordGate(root, match[1]);
    emitStudioEvent(s, s.currentProject(), 'gate.confirmed', { gate: match[1] });
    return writeJSON(200, record);
  } catch (err) {
    return writeError(400, 'invalid_request', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// 流程声明：界面按它排顶栏，不按片型写死

/** /api/state 的 flow：这个项目用的流程，以及顶栏据此怎么排。 */
export interface FlowView {
  /** 流程 id：speech、beat、song，或第三方的 x:<站>。 */
  id: string;
  name: string;
  /** 顶栏第一步打开哪一页。 */
  first_page: string;
  /** 顶栏的步骤（页面 id），第一步是 first_page，其余是宿主的骨架（studioview.StepIDs 里不是「第一步页」的那几个）。 */
  steps: string[];
  /** 别的流程的第一步页（这个项目用不上）：不在顶栏与更多页面里列（编排工具仍能切过去）。 */
  hidden_pages: string[];
  /** 这几个步骤标记都算第一步（编排工具 studio_step 标的 script / beat 落在第一步上）。 */
  first_steps: string[];
  /** 还没有镜头时打开项目先落在这一页；用不上的页（hidden_pages）也改切到它。空是不落。 */
  land_page: string;
  /** 制作说明用的是项目里改过的那份文件（有流程记录的项目才可能）。 */
  custom_prompt: boolean;
}

/** 内置流程（含内置插件的）各自的第一步页：script、beat。 */
function builtinFirstPages(): string[] {
  const out: string[] = [];
  for (const f of flow.allFlows()) if (f.first_page && !f.first_page.startsWith('x:') && !out.includes(f.first_page)) out.push(f.first_page);
  return out;
}

export function flowView(root: string, customPrompt: boolean): FlowView {
  const extras = flow.projectExtras(root);
  const id = flow.detectFlow(root, extras);
  const def = flow.flow(id, extras);
  // 第三方流程叠在项目自己的片型上：用不上的页、落在哪一页仍按项目自己的片型（新建时记的或标记文件）。
  const base = id.startsWith('x:') ? flow.flow(flow.detectFlow(root), []) : def;
  const firstPages = builtinFirstPages();
  const baseFirst = base.first_page ?? 'script';
  const first = def.first_page ?? baseFirst;
  return {
    id,
    name: def.name,
    first_page: first,
    steps: [first, ...stepsAfterFirst(firstPages)],
    hidden_pages: firstPages.filter((p) => p !== baseFirst),
    first_steps: [...new Set([first, ...firstPages])],
    land_page: base.land_first ? baseFirst : '',
    custom_prompt: customPrompt,
  };
}

/** 宿主骨架里第一步之后的步骤。 */
function stepsAfterFirst(firstPages: readonly string[]): string[] {
  return studioview.StepIDs.filter((s) => !firstPages.includes(s));
}
