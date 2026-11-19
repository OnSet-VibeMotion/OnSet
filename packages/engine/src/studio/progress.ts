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
import * as align from '../align';
import { hasRoster } from '../cast';
import { DialogueRelPath, SRTRelPath, VoiceRelPath } from '../dialogue';
import * as filmstyle from '../filmstyle';
import * as flow from '../flow';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import * as plugin from '../plugin';
import * as studioview from '../studioview';
import { writeError, writeJSON } from './http';
import { candidateFilm, latestReviewReport, projectVideoDigest, type ReviewReport } from './reviewreport';
import { discoverScenes, type SceneSummary } from './scenes';
import { readStoryboard } from './storyboard';
import { localRFC3339 } from './script';
import type { Server } from './studio';
import { emitStudioEvent } from './events';
import { decodeTurn, readBlob, storeBlob, studioRoot } from './turns';

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
  guide?: { ai?: string; user?: string; page?: string; page_label?: string; actions?: plugin.PluginGuideAction[]; confirm?: string };
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

/** 关卡确认记录。 */
export const gatesPath = 'production/studio/gates.json';

interface GateRecord {
  at: string;
  files: Record<string, string>;
  /** 在对话里确认的：用户的原话（studio_confirm）。界面按钮确认的没有。 */
  said?: string;
}

/** 关卡绑定的文件：确认后它们变了，确认就不算数。来自各站的声明，已装的第三方插件的关卡也算。 */
function gateFilesFor(): Record<string, string[]> {
  const out = flow.gateFiles();
  for (const x of flow.stationExtras()) {
    for (const node of x.station.nodes) if (node.gateFiles && !out[node.id]) out[node.id] = node.gateFiles;
  }
  return out;
}

/** 可以经界面按钮记确认的关卡。试听确认（approval.json）与节拍确认（grid.json）由编排与 onset 写，不在这里。 */
export function gateIDs(): string[] {
  return Object.keys(gateFilesFor());
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
      out[id] = { at: v.at, files: v.files as Record<string, string>, ...(typeof v.said === 'string' && v.said !== '' ? { said: v.said } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}

/** 记下用户确认了某个关卡：绑定的文件一个都没有时拒绝（没东西可确认）。 */
export function recordGate(root: string, id: string, now = new Date(), said = ''): GateRecord {
  const bound = gateFilesFor()[id];
  if (!bound) throw new Error(`没有这个审核关卡：${id}`);
  const files: Record<string, string> = {};
  for (const rel of bound) {
    const state = fileState(path.join(root, rel));
    if (!state) continue;
    files[rel] = state;
    // 只比显示文字的文件要留一份确认时的内容，之后才比得出改的是不是只有读法。
    if (displayOnlyGateFiles.has(rel) && state.startsWith('sha256:')) {
      try {
        storeBlob(root, fs.readFileSync(path.join(root, rel)));
      } catch {
        // 存不下就只能按字节比，最多多问一次。
      }
    }
  }
  if (Object.keys(files).length === 0) throw new Error('要确认的内容还没写出来');
  const gates = readGates(root);
  const record: GateRecord = { at: localRFC3339(now), files, ...(said !== '' ? { said } : {}) };
  gates[id] = record;
  const sorted: Record<string, GateRecord> = {};
  for (const key of Object.keys(gates).sort()) sorted[key] = gates[key];
  atomicWrite(path.join(root, gatesPath), marshalIndent({ version: 1, gates: sorted }) + '\n', 0o644);
  return record;
}

/** 比对用：去掉空白与常见标点，「确认，开始渲染」与「确认 开始渲染。」算同一句。 */
function bareWords(text: string): string {
  return text.replace(/[\s，。、！？；：,.!?;:「」“”"'《》()（）【】\[\]…—-]+/gu, '');
}

/**
 * 用户在对话里确认了关卡（编排工具调 studio_confirm）：记下它，与界面上点「确认」同一份记录，另存用户的原话。
 * 编排工具不能替用户确认：said 必须真的出现在这一轮用户发的话里（message），不然拒绝。
 * 没指定关卡时记路线上此刻在等用户确认的那一个。
 */
export function confirmGateFromChat(root: string, message: string, said: string, gate = '', now = new Date()): { gate: string; label: string; record: GateRecord } {
  const quote = said.trim();
  if (bareWords(quote).length < 2) throw new Error('said 要写用户确认时的原话');
  if (!bareWords(message).includes(bareWords(quote))) throw new Error('这一轮用户的话里没有「' + quote + '」：只有用户在对话里明确确认了，才能记下关卡');
  const progress = readProgress(root);
  let id = gate.trim();
  if (id !== '') {
    if (!gateFilesFor()[id]) throw new Error(`没有这个审核关卡：${id}（可选：${gateIDs().join('、')}）`);
  } else {
    const current = progress.stations.find((st) => st.id === progress.current);
    if (!current?.gate || !gateFilesFor()[current.id]) throw new Error('路线上现在没有在等用户确认的关卡');
    id = current.id;
  }
  const label = progress.stations.find((st) => st.id === id)?.label ?? id;
  return { gate: id, label, record: recordGate(root, id, now, quote) };
}

/**
 * 用户审的是显示出来的文字的文件。终稿只改读法（`<显示|朗读>` 的朗读侧、声音事件、受保护短语标记）时，
 * 用户看到的稿子一个字没变：按字节比的话，用户自己要求修一个多音字的读音，稿件审核就退回「确认后又改过」，
 * 成片都出来了路线还停在审稿（2026-11 实测）。
 */
const displayOnlyGateFiles = new Set(['production/script-final.md']);

/** 终稿显示出来的文字：标题与各段的显示侧。解析不了时返回 null（按改过算）。 */
function reviewedText(body: string, dialogue: boolean): string | null {
  try {
    const s = align.parseScript(body, dialogue);
    const lines = s.headings.map((h) => `${h.atPiece}#${h.level} ${h.text}`);
    let para = '';
    let last = -1;
    for (const p of s.pieces) {
      if (p.para !== last) {
        if (para !== '') lines.push(para);
        const speaker = s.speakers.get(p.para);
        para = speaker ? `${speaker}: ` : '';
      }
      last = p.para;
      para += p.display;
    }
    if (para !== '') lines.push(para);
    return lines.join('\n');
  } catch {
    return null;
  }
}

function gateFileChanged(root: string, rel: string, state: string): boolean {
  const file = path.join(root, rel);
  if (fileState(file) === state) return false;
  if (!displayOnlyGateFiles.has(rel)) return true;
  try {
    const before = readBlob(root, state);
    if (!before) return true;
    const dialogue = hasRoster(root);
    const was = reviewedText(before.toString('utf8'), dialogue);
    const now = reviewedText(fs.readFileSync(file, 'utf8'), dialogue);
    return was === null || now === null || was !== now;
  } catch {
    return true;
  }
}

function gateChanged(root: string, record: GateRecord): boolean {
  return Object.entries(record.files).some(([rel, state]) => gateFileChanged(root, rel, state));
}

/** approval.json 记的候选摘要与现在的 candidate.mp4 相同。 */
function candidateIsApproved(root: string, approvalFile: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(approvalFile, 'utf8')) as Record<string, unknown>;
    const candidate = raw.candidate as Record<string, unknown> | undefined;
    const want = typeof candidate?.sha256 === 'string' ? candidate.sha256.replace(/^sha256:/, '').toLowerCase() : '';
    return want !== '' && projectVideoDigest(root, candidateFilm) === want;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 站的定义

interface Ctx {
  root: string;
  scenes: SceneSummary[];
  gates: Record<string, GateRecord>;
  filmReview?: ReviewReport | null;
}

/**
 * 一站做没做的判断。站点的名字、归哪一步、是不是关卡来自流程声明（flow.route）。
 * 与内置插件在 apply 里登记的判断函数是同一种写法（plugin.NodeJudge）。
 */
type Judge = plugin.NodeJudge<Ctx>;

type Def = flow.RouteNode & Judge & { output: (c: Ctx) => number };

const f = (c: Ctx, rel: string) => mtime(path.join(c.root, rel));
const anyOf = (c: Ctx, ...rels: string[]) => Math.max(0, ...rels.map((rel) => f(c, rel)));

function voiceOutput(c: Ctx): number {
  const voice = f(c, VoiceRelPath);
  if (!voice || !hasRoster(c.root)) return voice;
  return f(c, DialogueRelPath) >= voice && f(c, SRTRelPath) >= voice ? voice : 0;
}

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

/** 默认风格比分镜计划与处理方案都新。 */
function planBehindStyle(c: Ctx, out: number): boolean {
  return filmstyle.changedAfter(c.root, Math.max(out, f(c, 'production/treatment.md')));
}

/**
 * 分镜计划只写锚点，帧号由 scene_cues 按配音算进各镜头的 scene.json。重新配音后（例如修一个读音）
 * 计划本身不用改，重跑过 cues 就跟上了：配音比计划新、而且比最早一个镜头的 scene.json 还新，才是没跟上。
 */
function voiceAhead(c: Ctx, out: number): boolean {
  const voice = f(c, 'production/audio/voice.srt');
  if (voice <= out) return false;
  if (c.scenes.length === 0) return true;
  return voice > Math.min(...c.scenes.map((sc) => mtime(path.join(sc.directory, 'scene.json'))));
}

function filmReviewForProgress(c: Ctx): ReviewReport | null {
  if (c.filmReview === undefined) {
    const candidate = f(c, candidateFilm) ? candidateFilm : undefined;
    c.filmReview = latestReviewReport(c.root, candidate, { exact: true });
  }
  return c.filmReview;
}

/** 宿主自带的站的判断，键是「站:站点」。内置插件的判断随它登记（pluginJudges，例如卡点的 beat-plan:plan）。 */
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
  'voice:voice': { output: voiceOutput },
  'timeline:timeline': {
    output: (c) => hasRoster(c.root) && !voiceOutput(c) ? 0 : f(c, 'production/audio/voice.srt'),
    stale: (c, out) => f(c, 'production/audio/voice.wav') > out,
    detail: (c) => {
      try {
        const subtitles = hasRoster(c.root) ? SRTRelPath : 'production/audio/voice.srt';
        const n = fs.readFileSync(path.join(c.root, subtitles), 'utf8').split('-->').length - 1;
        return n > 0 ? `${n} 条字幕` : undefined;
      } catch {
        return undefined;
      }
    },
  },
  'style:style': {
    output: (c) => f(c, '.agents/skills/onset-film-style/onset-film-style.json'),
    detail: (c) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(c.root, '.agents/skills/onset-film-style/onset-film-style.json'), 'utf8')) as Record<string, unknown>;
        return typeof raw.cn === 'string' && raw.cn ? raw.cn : undefined;
      } catch {
        return undefined;
      }
    },
  },
  'plan:plan': {
    output: (c) => f(c, 'production/scene-plan.json'),
    // 配音改过而 cues 没跟上要重做；分镜写好之后才定风格（或换了默认风格）也要重做：分镜与处理方案是照旧的视觉写的。处理方案改过就算跟上了。
    stale: (c, out) => planBehindStyle(c, out) || voiceAhead(c, out),
    staleNote: (c, out) => (planBehindStyle(c, out) ? filmstyle.PlanBehindStyleNote : undefined),
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
    output: (c) => filmReviewForProgress(c)?.mtime ?? 0,
    stale: (c, out) => {
      if (!f(c, candidateFilm)) return false;
      const report = filmReviewForProgress(c);
      const sha = report?.data?.video_sha256;
      return typeof sha === 'string' && sha !== ''
        ? projectVideoDigest(c.root, candidateFilm) !== sha
        : f(c, candidateFilm) > out;
    },
    detail: (c) => {
      const data = filmReviewForProgress(c)?.data;
      if (!data) return undefined;
      const problems = Array.isArray(data.problems) ? data.problems.length : 0;
      return problems === 0 ? '机器检查没有问题' : `${problems} 个问题`;
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
      // 候选比批准记录新，但内容就是批准的那一份（重跑混音得到同样的字节）时不算改过。
      const changed = f(c, 'production/audio/candidate.mp4') > approved && !candidateIsApproved(c.root, file);
      return { status: changed ? 'changed' : 'confirmed', at };
    },
  },
};

/** 内置插件在 apply 里登记的判断，键同 judges。 */
function pluginJudges(): Record<string, Judge> {
  const out: Record<string, Judge> = {};
  for (const { value: s } of plugin.pluginStations()) for (const [node, judge] of Object.entries(s.judges ?? {})) out[`${s.id}:${node}`] = judge;
  return out;
}

/**
 * 第三方站点的声明式判断：outputs 里最新的修改时间；stale_after 里的站点产物比它新就要重做。
 * 写了 state 时：outputs 有产物就算做完（产物是最硬的证据，不再看 state）；没有时按文件里的字段定状态
 * （flow.readDeclaredState），做完的产物时间取状态文件的修改时间，说明、在等谁与「接下来」也从落到的那一项来。
 */
function declaredJudge(node: flow.RouteNode, byID: Map<string, Def>): Judge {
  const declared = node.declared!;
  const outputsTime = (c: Ctx) => Math.max(0, ...declared.outputs.map((rel) => {
    const full = path.join(c.root, rel);
    try {
      return fs.statSync(full).isDirectory() ? dirMtime(full) : mtime(full);
    } catch {
      return 0;
    }
  }));
  if (node.gate) return {};
  const stale: Judge['stale'] = declared.stale_after.length === 0 ? undefined : (c, out) => declared.stale_after.some((id) => (byID.get(id)?.output(c) ?? 0) > out);
  const state = declared.state;
  const guide = declared.guide ? toPluginGuide(declared.guide) : undefined;
  if (!state) return { output: outputsTime, stale, guide };
  // 一次计算里各项判断读同一份结果。
  const memo = new WeakMap<Ctx, { time: number; outcome?: flow.DeclaredOutcome }>();
  const read = (c: Ctx): { time: number; outcome?: flow.DeclaredOutcome } => {
    let got = memo.get(c);
    if (!got) {
      const done = outputsTime(c);
      if (done > 0) got = { time: done };
      else {
        const r = flow.readDeclaredState(c.root, state);
        got = { time: r.outcome.status === 'done' ? r.mtime : 0, outcome: r.outcome };
      }
      memo.set(c, got);
    }
    return got;
  };
  return {
    output: (c) => read(c).time,
    stale,
    detail: (c) => read(c).outcome?.detail,
    waiting: (c) => read(c).outcome?.waiting,
    inProgress: (c) => read(c).outcome?.status === 'doing',
    guide,
    guideFor: (c) => {
      const own = read(c).outcome?.guide;
      return own ? toPluginGuide(own) : guide;
    },
  };
}

function toPluginGuide(g: flow.DeclaredGuide): plugin.PluginGuide {
  const out: plugin.PluginGuide = {};
  if (g.ai !== undefined) out.ai = g.ai;
  if (g.user !== undefined) out.user = g.user;
  if (g.actions) out.actions = g.actions.map((a) => ({ ...a }));
  return out;
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

/** 一页上的「确认」按钮记到哪个关卡：关卡 id 与内置插件登记的确认时发给 AI 的话（宿主关卡的话在界面里）。 */
export interface PageGate {
  id: string;
  confirm?: string;
}

/**
 * 这个项目当前流程的路线上，page 是这一页的第一个审核关卡（口播的分镜页是 gate-storyboard，卡点的是
 * gate-beat-storyboard）；没有为 null。界面的确认按钮按它记，不写死关卡 id。
 */
export function pageGate(root: string, page: string): PageGate | null {
  const extras = flow.stationExtras();
  let id: flow.FlowID;
  try {
    id = flow.detectFlow(root, extras);
  } catch {
    return null;
  }
  const def = stationDefs(id, extras).find((d) => d.gate && d.page === page);
  if (!def) return null;
  return def.guide?.confirm ? { id: def.id, confirm: def.guide.confirm } : { id: def.id };
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
  const extras = flow.stationExtras();
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
    const g = d.guideFor ? d.guideFor(ctx) : d.guide;
    if (g) station.guide = { ai: g.ai, user: g.user, page: g.page, page_label: g.pageLabel, actions: g.actions, confirm: g.confirm };
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
  return Math.max(0, ...stationDefs(flow.detectFlow(root, extras), extras).filter((d) => !d.gate).map((d) => d.output(ctx)));
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

export async function progressAPI(s: Server, request: Request, rest: string): Promise<Response> {
  let root: string;
  try {
    root = s.currentProject().path;
  } catch (err) {
    return writeError(404, 'no_project', (err as Error).message);
  }
  if (rest === '') {
    if (request.method !== 'GET') return writeError(405, 'method_not_allowed', '只支持 GET');
    try {
      return writeJSON(200, readProgress(root));
    } catch (err) {
      // 没有流程记录的目录（不是这一版新建的项目）：路线无从排起，照实说缺什么。
      if (err instanceof flow.MissingFlowRecordError) return writeError(409, 'no_flow_record', err.message);
      throw err;
    }
  }
  const match = /^gates\/([a-z-]+)$/.exec(rest);
  if (!match) return writeError(404, 'not_found', 'Studio API 路径不存在');
  if (request.method !== 'POST') return writeError(405, 'method_not_allowed', '只支持 POST');
  if (!gateFilesFor()[match[1]]) return writeError(404, 'not_found', `没有这个审核关卡：${match[1]}`);
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
  /** 顶栏的步骤（页面 id），第一步是 first_page，其余是宿主的骨架（studioview.stepIDs() 里不是「第一步页」的那几个）。 */
  steps: string[];
  /** 别的流程的第一步页（这个项目用不上）：不在顶栏与更多页面里列（编排工具仍能切过去）。 */
  hidden_pages: string[];
  /** 这几个步骤标记都算第一步（编排工具 studio_step 标的 script / beat 落在第一步上）。 */
  first_steps: string[];
  /** 还没有镜头时打开项目先落在这一页；用不上的页（hidden_pages）也改切到它。空是不落。 */
  land_page: string;
}

export function flowView(root: string): FlowView {
  const extras = flow.stationExtras();
  const id = flow.detectFlow(root, extras);
  const def = flow.flow(id, extras);
  const firstPages = flow.builtinFirstPages();
  // 第三方流程的第一页可以是自带的第一页（口播稿、节拍）或插件自己的页面：用不上的自带第一页、
  // 落在哪一页按第一页是自带的哪一页的那个片型；是插件页面时按口播。
  const base = id.startsWith('x:') ? (flow.allFlows().find((f) => f.prompt && (f.first_page ?? 'script') === def.first_page) ?? flow.flow('speech')) : def;
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
  };
}

/** 宿主骨架里第一步之后的步骤。 */
function stepsAfterFirst(firstPages: readonly string[]): string[] {
  return studioview.stepIDs().filter((s) => !firstPages.includes(s));
}
