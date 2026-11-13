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
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import * as validate from '../validate';
import { sameDownbeats } from './api_ui';
import { writeError, writeJSON } from './http';
import { discoverScenes, fileExists, type SceneSummary } from './scenes';
import { readStoryboard } from './storyboard';
import { localRFC3339 } from './script';
import type { Server } from './studio';
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
  mode: 'speech' | 'beat';
  stations: Station[];
  /** 现在在哪一站；全部做完时为空。 */
  current: string;
  /** 现在在等谁：关卡等你，其余等 AI 做。全部做完时为空。 */
  waiting_on: '' | 'user' | 'ai';
  /** 每一轮推进到了哪几站（对话里每轮结尾的标签用），值是站的 label。 */
  turns: Record<string, string[]>;
}

/** 关卡确认记录。 */
export const gatesPath = 'production/studio/gates.json';

interface GateRecord {
  at: string;
  files: Record<string, string>;
}

/** 关卡绑定的文件：确认后它们变了，确认就不算数。 */
const gateFiles: Record<string, string[]> = {
  'gate-script': ['production/script-final.md'],
  'gate-voice': ['production/audio/voice.wav'],
  'gate-storyboard': ['production/scene-plan.json', 'production/treatment.md'],
  'gate-story': [beat.Store + '/story.md'],
  'gate-beat-storyboard': [beat.PlanFile],
};

/** 可以经界面按钮记确认的关卡。试听确认（approval.json）与节拍确认（grid.json）由编排与 am 写，不在这里。 */
export function gateIDs(): string[] {
  return Object.keys(gateFiles);
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
  const bound = gateFiles[id];
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

interface Def {
  id: string;
  label: string;
  step: string;
  gate?: boolean;
  optional?: boolean;
  page?: string;
  file?: string;
  /** 产物的修改时间（毫秒）；0 表示没做。 */
  output: (c: Ctx) => number;
  /** 上游产物比这一站的产物新：要重做。 */
  stale?: (c: Ctx, out: number) => boolean;
  detail?: (c: Ctx) => string | undefined;
  /** 关卡的状态不经 gates.json 时（试听确认、节拍确认）自己判断。 */
  gateState?: (c: Ctx) => { status: 'confirmed' | 'changed' | 'todo'; at?: number | string };
}

const f = (c: Ctx, rel: string) => mtime(path.join(c.root, rel));
const anyOf = (c: Ctx, ...rels: string[]) => Math.max(0, ...rels.map((rel) => f(c, rel)));

function sceneOutputs(c: Ctx): number[] {
  return c.scenes.filter((sc) => sc.exists && sc.output).map((sc) => mtime(path.join(sc.directory, sc.output!)));
}

/** 渲染：全部镜头出片才算做完，结果写几个出了片。 */
const renderDef: Def = {
  id: 'render',
  label: '渲染镜头',
  step: 'scene',
  page: 'scene',
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
};

const tailDefs: Def[] = [
  renderDef,
  {
    id: 'visual-qc',
    label: '画面验收',
    step: 'scene',
    output: (c) => dirMtime(path.join(c.root, 'production', 'visual-qc')),
    detail: (c) => {
      const n = countFiles(path.join(c.root, 'production', 'visual-qc'));
      return n > 0 ? `${n} 份截图与检查记录` : undefined;
    },
  },
  {
    id: 'assemble',
    label: '拼接母版',
    step: 'final',
    file: 'production/silent-master.mp4',
    output: (c) => f(c, 'production/silent-master.mp4'),
    stale: (c, out) => sceneOutputs(c).some((t) => t > out),
  },
  {
    id: 'sound',
    label: '配乐、音效与混音',
    step: 'final',
    file: 'production/audio/candidate.mp4',
    output: (c) => f(c, 'production/audio/candidate.mp4'),
    stale: (c, out) => f(c, 'production/silent-master.mp4') > out,
  },
  {
    id: 'review',
    label: '整片复查',
    step: 'final',
    page: 'review',
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
  {
    id: 'gate-final',
    label: '试听确认',
    step: 'final',
    gate: true,
    page: 'final',
    output: () => 0,
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
  {
    id: 'publish',
    label: '封面与发布信息',
    step: 'publish',
    page: 'publish',
    // 发布信息要到「ready」才算做完；写了但还有人工检查没做的，停在这一站。
    output: (c) => (publishStatus(c.root) === 'ready' ? f(c, 'publish.md') : 0),
    detail: (c) => {
      const status = publishStatus(c.root);
      const label: Record<string, string> = { draft: '草稿', pending_manual_checks: '还剩人工检查', blocked: '有问题挡着', ready: '可以发布' };
      return status ? label[status] ?? status : undefined;
    },
  },
];

function publishStatus(root: string): string {
  const file = path.join(root, 'publish.md');
  if (!fileExists(file)) return '';
  try {
    const data = validate.readPublish(file);
    return typeof data?.publish_status === 'string' ? data.publish_status : 'draft';
  } catch {
    return 'draft';
  }
}

const styleDef: Def = {
  id: 'style',
  label: '定整片风格',
  step: 'storyboard',
  optional: true,
  page: 'style',
  output: (c) => f(c, '.agents/skills/am-film-style/am-film-style.json') || f(c, '.agents/skills/lemo-film-style/lemo-upstream.json'),
  detail: (c) => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(c.root, '.agents/skills/am-film-style/am-film-style.json'), 'utf8')) as Record<string, unknown>;
      return typeof raw.cn === 'string' && raw.cn ? raw.cn : undefined;
    } catch {
      return undefined;
    }
  },
};

const speechDefs: Def[] = [
  {
    id: 'intake',
    label: '盘点素材与规格',
    step: 'script',
    file: 'production/input-inventory.md',
    output: (c) => anyOf(c, 'production/input-inventory.md', 'production/production-config.json'),
  },
  {
    id: 'script',
    label: '整理口播稿',
    step: 'script',
    page: 'script',
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
  { id: 'gate-script', label: '稿件审核', step: 'script', gate: true, page: 'script', output: () => 0 },
  {
    id: 'voice',
    label: '配音',
    step: 'script',
    file: 'production/audio/voice.wav',
    // 不按稿子比配音新判过期：编排常在配好音后再改稿里的读法、短语标记，朗读的字没变。
    output: (c) => f(c, 'production/audio/voice.wav'),
  },
  { id: 'gate-voice', label: '配音审核', step: 'script', gate: true, file: 'production/audio/voice.wav', output: () => 0 },
  {
    id: 'timeline',
    label: '字幕时间轴',
    step: 'script',
    file: 'production/audio/voice.srt',
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
  styleDef,
  {
    id: 'plan',
    label: '拆分镜头',
    step: 'storyboard',
    page: 'storyboard',
    output: (c) => f(c, 'production/scene-plan.json'),
    stale: (c, out) => f(c, 'production/audio/voice.srt') > out,
    detail: storyboardDetail,
  },
  { id: 'gate-storyboard', label: '分镜审核', step: 'storyboard', gate: true, page: 'storyboard', output: () => 0 },
  ...tailDefs,
];

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

const beatDefs: Def[] = [
  { id: 'story', label: '故事与文案', step: 'beat', page: 'beat', output: (c) => f(c, beat.Store + '/story.md') },
  { id: 'gate-story', label: '故事审核', step: 'beat', gate: true, page: 'beat', output: () => 0 },
  { id: 'music', label: '导入音乐', step: 'beat', page: 'beat', output: (c) => f(c, beat.TrackFile) },
  {
    id: 'grid',
    label: '分析节拍',
    step: 'beat',
    page: 'beat',
    output: (c) => anyOf(c, beat.DraftFile, beat.GridFile),
    stale: (c, out) => f(c, beat.TrackFile) > out,
  },
  {
    id: 'gate-grid',
    label: '试听节拍',
    step: 'beat',
    gate: true,
    page: 'beat',
    output: () => 0,
    gateState: (c) => {
      const grid = readGrid(c.root, beat.GridFile);
      if (!grid) return { status: 'todo' };
      const draft = readGrid(c.root, beat.DraftFile);
      const pending = draft !== null && !sameDownbeats(draft, grid);
      return { status: pending ? 'changed' : 'confirmed', at: f(c, beat.GridFile) };
    },
  },
  styleDef,
  {
    id: 'plan',
    label: '分镜计划',
    step: 'beat',
    page: 'beat',
    output: (c) => f(c, beat.PlanFile),
    stale: (c, out) => f(c, beat.GridFile) > out,
  },
  { id: 'gate-beat-storyboard', label: '分镜审核', step: 'storyboard', gate: true, page: 'storyboard', output: () => 0 },
  ...tailDefs,
];

// ---------------------------------------------------------------------------
// 文件归站

/** 改过的文件归到哪一站；归不到的（Studio 状态、杂项）为空。 */
export function stationOfPath(rel: string, mode: 'speech' | 'beat'): string {
  const p = rel.replaceAll('\\', '/');
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (p.startsWith('production/studio/') || p.startsWith('production/usage/') || p.startsWith('production/memory-exams/')) return '';
  if (p.startsWith(beat.Store + '/')) {
    if (p === beat.Store + '/story.md') return 'story';
    if (p === beat.PlanFile) return 'plan';
    if (p === beat.TrackFile || base.startsWith('music')) return 'music';
    return 'grid';
  }
  if (p === beat.ConfigFile) return 'music';
  if (p === 'production/input-inventory.md' || p === 'production/input-manifest.json' || p === 'production/production-config.json' || p === 'article-to-motion.conf')
    return 'intake';
  if (p === 'production/script-final.md' || p === 'production/script-change-log.md' || p === 'script.md' || p === 'SCRIPT.md') return mode === 'beat' ? '' : 'script';
  if (p.startsWith('production/audio/')) {
    if (/^(music|sfx|premaster|premix|candidate|cue-sheet|asset-ledger|sound-checklist|machine-qc)/.test(base)) return 'sound';
    if (base.startsWith('align') || base.startsWith('voice-16k') || base === 'voice.srt' || base.startsWith('production-srt')) return 'timeline';
    return 'voice';
  }
  if (
    p === 'production/phrase-timeline.json' ||
    p === 'production/phrase-adjust.json' ||
    p === 'production/timing-report.json' ||
    p === 'transcription-production.srt' ||
    p === 'transcription.srt'
  )
    return 'timeline';
  if (p.startsWith('.agents/skills/am-film-style/') || p.startsWith('.agents/am-film-styles/') || p.startsWith('assets/style-guide/') || p === 'frame.md' || p === 'docs/style-brief.md')
    return 'style';
  if (p === 'production/treatment.md' || p.startsWith('production/scene-plan') || p === 'production/visible-event-inventory.json') return 'plan';
  if (p.startsWith('scenes/')) return base === 'scene.json' || base === 'prompt.md' ? 'plan' : 'render';
  if (p.startsWith('production/visual-qc/')) return 'visual-qc';
  if (p.startsWith('production/silent-master') || p.startsWith('production/review-silent')) return 'assemble';
  if (p.startsWith('production/review/') || p === 'production/final-check.json') return 'review';
  if (p === 'production/approval.json' || p === 'final.mp4' || p === 'production/final.mp4') return 'gate-final';
  if (p === 'publish.md' || p.startsWith('covers/')) return 'publish';
  return '';
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
export function computeStations(root: string, scenes: SceneSummary[]): { mode: 'speech' | 'beat'; stations: Station[]; current: string; waiting_on: '' | 'user' | 'ai' } {
  const mode = fileExists(path.join(root, beat.ConfigFile)) ? 'beat' : 'speech';
  const defs = mode === 'beat' ? beatDefs : speechDefs;
  const ctx: Ctx = { root, scenes, gates: readGates(root) };
  // 关卡有确认（批准记录、确认过的网格、gates.json）也算「后面已经做了」，前面没留产物的站因此算跳过。
  const outputs = defs.map((d) => (d.gate ? (ctx.gates[d.id] || (d.gateState && d.gateState(ctx).status !== 'todo') ? 1 : 0) : d.output(ctx)));
  const stations: Station[] = defs.map((d, i) => {
    const station: Station = { id: d.id, label: d.label, step: d.step, status: 'todo', turns: [] };
    if (d.gate) station.gate = true;
    if (d.optional) station.optional = true;
    if (d.page) station.page = d.page;
    if (d.file) station.file = d.file;
    const laterDone = outputs.some((t, j) => j > i && t > 0 && !defs[j].optional);
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
  // 发布信息只差人工检查（上传前的几项手动核对）时，是在等你。
  if (current?.id === 'publish' && publishStatus(root) === 'pending_manual_checks') waiting = 'user';
  return { mode, stations, current: current?.id ?? '', waiting_on: waiting };
}

/** 各站的产物里最新的一次写入（毫秒），判断编排工具的步骤标记是不是比产物新。 */
export function latestOutput(root: string, scenes: SceneSummary[]): number {
  const mode = fileExists(path.join(root, beat.ConfigFile)) ? 'beat' : 'speech';
  const ctx: Ctx = { root, scenes, gates: {} };
  return Math.max(0, ...(mode === 'beat' ? beatDefs : speechDefs).filter((d) => !d.gate).map((d) => d.output(ctx)));
}

const maxStationTurns = 12;

export function readProgress(root: string): ProgressResponse {
  const scenes = discoverScenes(root);
  const base = computeStations(root, scenes);
  const byID = new Map(base.stations.map((s) => [s.id, s]));
  const labels: Record<string, string[]> = {};
  for (const turn of turnSummaries(root)) {
    const groups = new Map<string, string[]>();
    for (const p of turn.paths) {
      const id = stationOfPath(p, base.mode);
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
  if (!gateFiles[match[1]]) return writeError(404, 'not_found', `没有这个审核关卡：${match[1]}`);
  try {
    return writeJSON(200, recordGate(root, match[1]));
  } catch (err) {
    return writeError(400, 'invalid_request', (err as Error).message);
  }
}
