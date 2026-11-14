/**
 * 会话、事件流、轮次的生命周期与排队。
 *
 * Go 版靠 sessions.mu 串行化；Node 是单线程，同步代码段天然不会被打断，所以这里没有锁，
 * 但保留 Go 版「先改内存、再落盘、再唤醒」的顺序。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as agentrun from '../agentrun';
import * as config from '../config';
import { addToolsLocation, onsetCommand, envMap, lookPath, parsePassthrough } from '../envutil';
import { atomicWrite } from '../fsutil';
import { formatFixed, goClean, goTrimSpace } from '../gofmt';
import { marshal, marshalIndent } from '../gojson';
import * as ledger from '../ledger';
import * as project from '../project';
import { KindView, PermissionPollInterval, PermissionServerName, ViewInboxEnv, waitPermissionResponse, writePermissionRequest, ViewPollInterval, ViewProjectEnv, describeView, drainViewInbox, viewInbox, viewInteraction, type ViewRequest, type ViewState } from '../studioview';
import * as tools from '../tools';
import { compareTimes, nowTime } from './http';
import type { Project, Server } from './studio';
import { writeStepMark } from './view';
import { changedPaths, diffTrees, loadTurn, revertTurn, saveTurn, scanTree, statTree, studioRoot, validID, type FileChange, type Turn } from './turns';
import { emitStudioEvent } from './events';
import { preferenceBrief, recordUtterance } from './memory';
import { noVisionNote, orchestratorCannotSee } from './vision';
import { uploadDir, uploadKind } from './uploads';
import { allowedCommands, expirePermissions, permissionEventJSON, pollPermissions, type PendingPermission, type PermissionEventData } from './permissions';

// Studio 在 agentrun 事件之外自己发的几种事件。
export const kindUser = 'user';
export const kindTurnStart = 'turn-start';
export const kindTurnEnd = 'turn-end';
export const kindFilesChanged = 'files-changed';
export const kindNotice = 'notice';
export const kindTurnReverted = 'turn-reverted';
/** kindQueued 是这一轮进行中用户又发的消息：排队，这一轮结束后作为下一轮发出。 */
export const kindQueued = 'queued';
/** kindUnqueued 是用户移除了一条排队的消息。 */
export const kindUnqueued = 'unqueued';

/** transcriptLimit 是续接失败时补发的对话记录上限（字符）。 */
export const transcriptLimit = 24000;
/** changeCheckInterval 是对话进行中两次检查文件变化的最短间隔（毫秒）。 */
const changeCheckInterval = 500;

/** 会话的元数据，落在 production/studio/sessions/<id>.json。时间字段是 Go 写法的字符串。 */
export interface SessionMeta {
  session_id: string;
  title: string;
  /** chat | production */
  kind: string;
  tool: string;
  /** 编排工具的模型；空跟随设置（同一家工具时）或用那家工具自己的默认。 */
  model?: string;
  renderer?: string;
  renderer_model?: string;
  cli_session_id?: string;
  created_at: string;
  updated_at: string;
  turns: string[] | null;
  running_turn?: string;
  /**
   * 上一次交给编排工具的用户偏好段的摘要：偏好没变、CLI 会话也还在时不再重复发送，续接的会话里已经有了。
   */
  preference_digest?: string;
}

export function sessionMetaJSON(meta: SessionMeta): Record<string, unknown> {
  return {
    session_id: meta.session_id,
    title: meta.title,
    kind: meta.kind,
    tool: meta.tool,
    model: meta.model || undefined,
    renderer: meta.renderer || undefined,
    renderer_model: meta.renderer_model || undefined,
    cli_session_id: meta.cli_session_id || undefined,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    turns: meta.turns,
    running_turn: meta.running_turn || undefined,
    preference_digest: meta.preference_digest || undefined,
  };
}

/** 会话事件流里的一条，逐行追加到 <id>.events.jsonl。agentrun.Event 的字段内嵌在 time 之后。 */
export interface SessionEvent extends agentrun.Event {
  seq: number;
  turn_id?: string;
  time: string;
  status?: string;
  files?: string[];
  changes?: FileChange[];
  /** 标出 queued / unqueued 事件说的是哪一条排队的消息。 */
  queue_id?: string;
  /** 编排工具经 onset studio show 请网页切到的页面（view 事件）。 */
  view?: ViewRequest;
  /** 等用户批准的调用（permission 事件）与它的结果（permission-resolved 事件）。 */
  permission?: PermissionEventData;
}

export function sessionEventJSON(e: SessionEvent): Record<string, unknown> {
  return {
    seq: e.seq,
    turn_id: e.turn_id || undefined,
    time: e.time,
    ...agentrun.eventJSON(e),
    status: e.status || undefined,
    files: e.files && e.files.length > 0 ? e.files : undefined,
    changes: e.changes && e.changes.length > 0 ? e.changes.map((c) => ({ path: c.path, change: c.change, revertable: c.revertable })) : undefined,
    queue_id: e.queue_id || undefined,
    view: e.view ? { page: e.view.page, target: e.view.target || undefined, note: e.view.note || undefined, step: e.view.step || undefined } : undefined,
    permission: e.permission ? permissionEventJSON(e.permission) : undefined,
  };
}

/** 画面上的一个区域，单位是视频像素。 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 随消息附上的画面上下文。 */
export interface Attachment {
  scene_id?: string;
  path?: string;
  seconds?: number;
  region?: Box;
  selector?: string;
  source?: string;
  note?: string;
  /** 用户上传的文件（path 在 production/studio/uploads/ 下），name 是原文件名。 */
  upload?: boolean;
  name?: string;
  size?: number;
  /**
   * 用户右键「引用到对话」的一段文字，source 是它所在的项目文件（可以为空，
   * 例如引用的是编排工具的回复），label 是给人看的出处（「口播稿第 3 段」）。
   */
  quote?: string;
  label?: string;
  /** 只是指给编排工具看的一样东西（镜头 scene_id 或文件 source），不带截图。 */
  ref?: boolean;
}

export function attachmentJSON(a: Attachment): Record<string, unknown> {
  return {
    scene_id: a.scene_id || undefined,
    path: a.path || undefined,
    seconds: a.seconds || undefined,
    region: a.region ? { x: a.region.x, y: a.region.y, w: a.region.w, h: a.region.h } : undefined,
    selector: a.selector || undefined,
    source: a.source || undefined,
    note: a.note || undefined,
    upload: a.upload || undefined,
    name: a.name || undefined,
    size: a.size || undefined,
    quote: a.quote || undefined,
    label: a.label || undefined,
    ref: a.ref || undefined,
  };
}

/** maxQuoteRunes 是一条引用的上限：再长就该让编排工具自己去读文件。 */
export const maxQuoteRunes = 4000;

export interface Session {
  project: string;
  meta: SessionMeta;
  events: SessionEvent[];
  /** 等新事件的 SSE 连接（对应 Go 的 wake 通道）。 */
  waiters: Set<() => void>;
  /** 进行中这一轮的取消（对应 Go 的 cancel）。 */
  cancel: AbortController | null;
  /**
   * 这一轮进行中排队的消息，结束后合并成下一轮。只在内存里：
   * Studio 重启时进行中的轮次本来就会被标成 interrupted，排队的消息随之作废。
   */
  queue: TurnRequest[];
  /** 编排工具在等用户批准的调用，按请求编号。只在内存里，理由同 queue。 */
  permissions: Map<string, PendingPermission>;
}

/** BusyError 表示项目正被另一轮对话或一个写任务占用。 */
export class BusyError extends Error {
  constructor(readonly holder: string) {
    super('项目正忙：' + holder + '，请等它结束或先取消');
    this.name = 'BusyError';
  }
}

function sessionKey(projectPath: string, id: string): string {
  return projectPath + '\x00' + id;
}

/** newID 生成 <前缀>-<UTC 时间>-<8 位十六进制>，只含 validID 认的字符。 */
export function newID(prefix: string): string {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  return prefix + '-' + stamp + '-' + crypto.randomBytes(4).toString('hex');
}

export function sessionsDir(projectPath: string): string {
  return path.join(studioRoot(projectPath), 'sessions');
}

function decodeMeta(body: string): SessionMeta | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const s = (key: string): string | undefined => {
    const v = r[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : undefined;
  };
  const fields = ['session_id', 'title', 'kind', 'tool', 'model', 'renderer', 'renderer_model', 'cli_session_id', 'created_at', 'updated_at', 'running_turn', 'preference_digest'];
  const values: Record<string, string> = {};
  for (const key of fields) {
    const v = s(key);
    if (v === undefined) return undefined;
    values[key] = v;
  }
  let turns: string[] | null = null;
  if (Array.isArray(r.turns)) {
    if (!r.turns.every((t) => typeof t === 'string')) return undefined;
    turns = r.turns as string[];
  } else if (r.turns !== undefined && r.turns !== null) return undefined;
  const zero = '0001-01-01T00:00:00Z';
  return {
    session_id: values.session_id,
    title: values.title,
    kind: values.kind,
    tool: values.tool,
    model: values.model || undefined,
    renderer: values.renderer || undefined,
    renderer_model: values.renderer_model || undefined,
    cli_session_id: values.cli_session_id || undefined,
    created_at: values.created_at || zero,
    updated_at: values.updated_at || zero,
    turns,
    running_turn: values.running_turn || undefined,
    preference_digest: values.preference_digest || undefined,
  };
}

/** 读回一行事件；读不懂的行跳过。 */
function decodeEvent(line: string): SessionEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const e = raw as SessionEvent;
  if (typeof e.seq !== 'number') e.seq = 0;
  if (typeof e.kind !== 'string') e.kind = '';
  if (typeof e.time !== 'string') e.time = '0001-01-01T00:00:00Z';
  return e;
}

/**
 * loadSessions 首次访问某个项目时从磁盘读出它的全部会话。
 * 上次 Studio 退出时还在进行的轮次标成 interrupted：进程已经不在了。
 */
export function loadSessions(s: Server, projectPath: string): void {
  if (s.loadedProjects.has(projectPath)) return;
  s.loadedProjects.add(projectPath);
  let names: string[];
  try {
    names = fs
      .readdirSync(sessionsDir(projectPath), { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return;
  }
  for (const name of names) {
    let body: string;
    try {
      body = fs.readFileSync(path.join(sessionsDir(projectPath), name), 'utf8');
    } catch {
      continue;
    }
    const meta = decodeMeta(body);
    if (!meta || !validID(meta.session_id)) continue;
    const sess: Session = { project: projectPath, meta, events: [], waiters: new Set(), cancel: null, queue: [], permissions: new Map() };
    sess.events = readEvents(path.join(sessionsDir(projectPath), meta.session_id + '.events.jsonl'));
    if (meta.running_turn) {
      try {
        const turn = loadTurn(projectPath, meta.running_turn);
        if (turn.status === 'running') {
          turn.status = 'interrupted';
          turn.error = 'Studio 在本轮进行中退出';
          turn.ended_at = nowTime();
          saveTurn(projectPath, turn);
        }
      } catch {
        // 轮次记录读不到就只清掉会话上的标记。
      }
      sess.meta.running_turn = undefined;
      try {
        writeMeta(sess);
      } catch {
        // 写不了下次再标。
      }
    }
    s.sessions.set(sessionKey(projectPath, meta.session_id), sess);
  }
}

function readEvents(file: string): SessionEvent[] {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events: SessionEvent[] = [];
  for (const line of body.split('\n')) {
    if (line === '') continue;
    const event = decodeEvent(line);
    if (event) events.push(event);
  }
  return events;
}

function writeMeta(sess: Session): void {
  atomicWrite(path.join(sessionsDir(sess.project), sess.meta.session_id + '.json'), marshalIndent(sessionMetaJSON(sess.meta)) + '\n', 0o644);
}

export function listSessions(s: Server, projectPath: string): SessionMeta[] {
  loadSessions(s, projectPath);
  const out: SessionMeta[] = [];
  for (const sess of s.sessions.values()) if (sess.project === projectPath) out.push({ ...sess.meta });
  // Go 的 sort.Slice 不稳定；按更新时间倒序，相同时间的先后不作保证。
  out.sort((a, b) => compareTimes(b.updated_at, a.updated_at));
  return out;
}

export function getSession(s: Server, projectPath: string, id: string): Session | undefined {
  loadSessions(s, projectPath);
  return s.sessions.get(sessionKey(projectPath, id));
}

/** 会话选定的编排工具与渲染工具（agents.ts 的 agentChoice）。 */
export interface AgentChoice {
  tool: string;
  renderer: string;
  /**
   * 两家工具各自的模型。undefined 是「没说」（不改）；空串是「跟随设置」：工具与设置里的相同时用设置里的模型，
   * 不同时用那家工具自己的默认——设置里的模型是给设置里那家工具挑的。
   */
  model?: string;
  rendererModel?: string;
}

export function createSession(s: Server, projectPath: string, kind: string, title: string, agents: AgentChoice): Session {
  loadSessions(s, projectPath);
  const now = nowTime();
  const sess: Session = {
    project: projectPath,
    meta: {
      session_id: newID('s'),
      title,
      kind,
      tool: agents.tool,
      model: agents.model || undefined,
      renderer: agents.renderer || undefined,
      renderer_model: agents.rendererModel || undefined,
      created_at: now,
      updated_at: now,
      turns: [],
    },
    events: [],
    waiters: new Set(),
    cancel: null,
    queue: [],
    permissions: new Map(),
  };
  writeMeta(sess);
  s.sessions.set(sessionKey(projectPath, sess.meta.session_id), sess);
  return sess;
}

/** 要追加的事件：seq、turn_id、time 由 emit 填。 */
export type NewEvent = Omit<SessionEvent, 'seq' | 'time' | 'turn_id'>;

/**
 * emit 追加一条事件：编号、落盘、唤醒等待中的 SSE 连接。
 *
 * 编号与落盘在同一段同步代码里：一轮对话与一次回退可能同时发事件，行序必须与 seq 一致，
 * 重启后按行读回来的事件才对得上 SSE 的 Last-Event-ID。
 */
export function emit(sess: Session, turn: string, event: NewEvent): void {
  const full: SessionEvent = { ...event, seq: sess.events.length + 1, turn_id: turn || undefined, time: nowTime() };
  sess.events.push(full);
  try {
    const file = path.join(sessionsDir(sess.project), sess.meta.session_id + '.events.jsonl');
    fs.appendFileSync(file, marshal(sessionEventJSON(full)) + '\n', { mode: 0o644 });
  } catch {
    // 写不了事件文件不影响这一轮：内存里还有，SSE 照常推送。
  }
  const waiters = [...sess.waiters];
  sess.waiters.clear();
  for (const wake of waiters) wake();
}

/** updateMeta 修改会话元数据并落盘。 */
export function updateMeta(sess: Session, change: (meta: SessionMeta) => void): void {
  change(sess.meta);
  sess.meta.updated_at = nowTime();
  try {
    writeMeta(sess);
  } catch {
    // 与 Go 版一样忽略落盘错误。
  }
}

/** eventsAfter 返回 seq 大于 after 的事件，以及会话此刻是否有进行中的一轮。 */
export function eventsAfter(sess: Session, after: number): { events: SessionEvent[]; running: boolean } {
  const events = after < sess.events.length ? sess.events.slice(Math.max(after, 0)) : [];
  return { events, running: !!sess.meta.running_turn };
}

/** 等下一条事件（或被 signal 取消）。 */
export function waitEvent(sess: Session): Promise<void> {
  return new Promise((resolve) => sess.waiters.add(resolve));
}

/** attachmentText 把附件写成编排工具能读的说明。 */
export function attachmentText(attachments: Attachment[] | null | undefined): string {
  if (!attachments || attachments.length === 0) return '';
  const uploads: Attachment[] = [];
  const refs: Attachment[] = [];
  const frames: Attachment[] = [];
  for (const a of attachments) {
    if (a.upload) uploads.push(a);
    else if (a.quote || a.ref) refs.push(a);
    else frames.push(a);
  }
  let b = '';
  if (uploads.length > 0) {
    b += '\n\n用户上传的文件（存在 Studio 的上传目录里，不属于项目；要用时先复制或转换到项目里合适的位置，例如文章放项目根或 docs/，素材放 assets/）：';
    for (const a of uploads) b += `\n- ${uploadKind(a.name ?? '')}「${a.name ?? ''}」：${a.path ?? ''}`;
  }
  if (refs.length > 0) {
    b += '\n\n用户引用的内容（这条消息说的就是这些）：';
    for (const a of refs) {
      b += '\n- ';
      if (a.quote) {
        b += a.label || '一段文字';
        if (a.source) b += `（${a.source}）`;
        b += '：';
        for (const line of goTrimSpace(a.quote).split('\n')) b += '\n  > ' + line;
      } else if (a.scene_id) {
        b += `镜头 ${a.scene_id}`;
      } else if (a.source) {
        b += `文件 ${a.source}`;
      }
      if (a.note) b += '\n  备注：' + a.note;
    }
  }
  if (frames.length === 0) return b;
  b += '\n\n附带的画面上下文：';
  for (const a of frames) {
    b += '\n- ';
    if (a.scene_id) b += `镜头 ${a.scene_id} `;
    if (a.path) b += `${formatFixed(a.seconds ?? 0, 2)} 秒处的截图 ${a.path}（请打开查看）`;
    if (a.region) b += `，用户圈出的区域：x=${a.region.x} y=${a.region.y} 宽 ${a.region.w} 高 ${a.region.h}（视频像素）`;
    if (a.selector) {
      b += `，合成里选中的元素 \`${a.selector}\``;
      if (a.source) b += `（${a.source}）`;
    }
    if (a.note) b += '，备注：' + a.note;
  }
  return b;
}

/** validateAttachments 只接受 Studio 自己抽出的截图与项目内的合成文件。 */
export function validateAttachments(projectPath: string, attachments: Attachment[] | null | undefined): void {
  for (const a of attachments ?? []) {
    if (a.path) {
      const clean = goClean(a.path);
      const prefix = a.upload ? uploadDir + '/' : 'production/studio/attachments/';
      if (!clean.startsWith(prefix) || clean.includes('..')) throw new Error(`附件路径不在 ${prefix} 下：${a.path}`);
      if (!fs.existsSync(path.join(projectPath, clean))) throw new Error(`附件不存在：${a.path}`);
    }
    if (a.source) containedPath(projectPath, a.source);
    const n = [...(a.quote ?? '')].length;
    if (n > maxQuoteRunes) throw new Error(`引用太长（${n} 字，上限 ${maxQuoteRunes}）：长内容请直接说文件名，让 AI 自己读`);
    if (a.ref && !a.scene_id && !a.source) throw new Error('引用要指明镜头或文件');
  }
}

/** chatPreamble 是聊天会话第一轮的开场说明。整片制作会话第一轮直接发制作提示词，末尾附 studioInteraction。 */
export function chatPreamble(rulesName: string): string {
  return (
    '你正在协助用户修改当前目录下的片场视频项目。动手前先读项目规则 ' +
    rulesName +
    '。需要渲染、校验、复查时直接调用 onset 工具服务里的工具。改完用几句话说明改了哪些文件、为什么，以及接下来要不要重渲染哪些镜头。\n\n' +
    studioInteraction +
    '\n\n用户的请求：'
  );
}

/**
 * studioInteraction 告诉编排工具怎样在 Studio 里和用户来回：多步任务先列待办清单
 * （网页据此显示进度），要用户拍板时用 choices 代码块（网页渲染成按钮，见 Chat.tsx 的 parseChoices）。
 */
export const studioInteraction =
  `你在 Studio 网页里和用户对话，下面几条约定让网页能把你的进度和问题显示好：
- 工具都由你来调用。回复里用用户听得懂的话说做了什么、接下来做什么，不要写工具名、参数或命令让用户去运行；工具报错里「请重新运行 beat_cues()」这类话是给你的下一步，能做就直接做掉，要用户点头的先用一句话说明要做什么、为什么。
- 多步骤的工作先用你的待办清单工具列出步骤，做的过程中及时更新状态，用户会在对话顶部看到进度。
- 需要用户拍板时（选风格、确认分镜、确认一条推测的偏好、几种做法里选一种），先把问题和各选项的差别写清楚，再在回复的最后单独放一个语言标成 choices 的代码块，每行一个选项，例如：
` +
  '```choices\n用方案 A：深色科技风\n用方案 B：白板手绘风\n```' +
  `
  用户会看到可点的按钮，点了就把那一行原样发给你。问完就结束这一轮等用户回复，不要替用户选。用户也可能直接打字回答。
- 推荐风格时（用户没指定画风、要换风格，或某一段想换一种画法），先用 film_style_list({"json": true}) 挑出两三种贴合的，在回复里放一个语言标成 film-styles 的代码块，每行一种，写「来源/目录名」加一句为什么合适。推荐给全片当默认风格的直接写；只推荐给某一段的，在标识后面用方括号写清用在哪一段（段落名加镜头编号），例如：
` +
  '```film-styles\nlemo-opuscar/impasto 厚涂笔触适合讲历史人物的分量\nlemo-opuscar/ink-wash [回忆段，镜头 04–06] 水墨的留白像记忆一样模糊\n```' +
  `
  网页会显示每种风格的海报并标出是全片默认还是只用在哪一段。用户点了，全片默认的发来「整片风格用「中文名」（标识）」，你运行 film_style_use()；只给一段的发来「<那一段>用「中文名」风格（标识），其余镜头不变」，你按段落换风格的做法 film_style_add() 并改分镜里那几个镜头的 film_style，不要动默认风格。「不用整片风格，各镜头自主定视觉」写进同一条回复的 choices 代码块。
- 要用户试听音频、看图片或视频时（音色试听、配音片段、封面候选、预览帧），在回复里写出每个文件在项目里的相对路径，例如 production/audio/auditions/try-A.wav，网页会在回复下面直接放播放器和缩略图；只写文件名、目录另说的话网页未必找得到。
` +
  viewInteraction();

/** transcript 把会话里已有的对话整理成文字，供续接失败时补发。只保留末尾 transcriptLimit 字。 */
export function transcript(events: SessionEvent[]): string {
  let b = '';
  for (const event of events) {
    if (event.kind === kindUser) b += '\n用户：' + (event.text ?? '') + '\n';
    else if (event.kind === agentrun.KindText) b += '你：' + (event.text ?? '') + '\n';
  }
  let runes = [...b];
  if (runes.length > transcriptLimit) runes = runes.slice(runes.length - transcriptLimit);
  return goTrimSpace(runes.join(''));
}

/** 发起一轮对话所需的全部输入。 */
export interface TurnRequest {
  /** 只对排队的消息有值，网页用它移除、引导某一条。 */
  queueID?: string;
  message: string;
  /** 非空时直接作为发给编排工具的提示词（整片制作的第一轮）。 */
  prompt?: string;
  attachments?: Attachment[] | null;
  /** 用户发消息时在看的页面。 */
  view?: ViewState | null;
}

/** 读项目配置，再用会话选定的工具覆盖（agents.go 的 sessionConfig，放在这里免得循环导入）。 */
export function sessionConfig(projectPath: string, meta: SessionMeta): config.Config {
  const cfg = config.load(projectPath, null);
  return overrideAgents(cfg, { tool: meta.tool, renderer: meta.renderer ?? '', model: meta.model ?? '', rendererModel: meta.renderer_model ?? '' });
}

export function validateChoice(choice: AgentChoice): void {
  if (choice.tool !== '' && !tools.ValidTools.has(choice.tool)) throw new Error(`未知的编排工具：${choice.tool}`);
  if (choice.renderer !== '' && !tools.ValidRenderers.has(choice.renderer)) throw new Error(`未知的渲染工具：${choice.renderer}`);
  for (const value of [choice.model, choice.rendererModel]) {
    if (value && !config.validModel(value)) throw new Error(`不认识的模型名 ${value}：只能用字母、数字与 . _ - : / @ # [ ] +`);
  }
}

export function overrideAgents(cfg: config.Config, choice: AgentChoice): config.Config {
  validateChoice(choice);
  const out = { ...cfg };
  // 换了工具、又没选模型时，设置里的模型是给原来那家的，不能带过去。
  if (choice.tool !== '' && choice.tool !== cfg.orchestrator) out.orchestratorModel = '';
  if (choice.renderer !== '' && choice.renderer !== cfg.renderer) out.rendererModel = '';
  if (choice.tool !== '') out.orchestrator = choice.tool;
  if (choice.renderer !== '') out.renderer = choice.renderer;
  if (choice.model) out.orchestratorModel = choice.model;
  if (choice.rendererModel) out.rendererModel = choice.rendererModel;
  return out;
}

/** startTurn 占用项目写权、打开始快照，然后在后台跑这一轮。返回时编排工具已经在启动。 */
export function startTurn(s: Server, p: Project, sess: Session, req: TurnRequest): Turn {
  validateAttachments(p.path, req.attachments);
  const cfg = sessionConfig(p.path, sess.meta);
  s.acquire(p.path, '会话「' + sess.meta.title + '」正在对话');
  let prepared: { turn: Turn; prompt: string };
  try {
    prepared = prepareTurn(s, p, sess, cfg, req);
  } catch (err) {
    s.release(p.path);
    throw err;
  }
  const controller = new AbortController();
  sess.cancel = controller;
  void runTurn(s, controller.signal, p, sess, cfg, prepared.turn, prepared.prompt);
  return prepared.turn;
}

function prepareTurn(_s: Server, p: Project, sess: Session, cfg: config.Config, req: TurnRequest): { turn: Turn; prompt: string } {
  const rulesName = tools.projectRulesFilename(cfg.orchestrator);
  project.writeRules(p.path, rulesName);
  let before;
  try {
    before = scanTree(p.path);
  } catch (err) {
    throw new Error(`扫描项目：${(err as Error).message}`, { cause: err });
  }
  let message = req.message + attachmentText(req.attachments);
  const where = describeView(req.view);
  if (where !== '') message += '\n\n' + where;
  let prompt = req.prompt ?? '';
  if (prompt !== '') {
    prompt += '\n\n---\n\n' + studioInteraction;
    // 只上传了文章、没写话时也要把附件交过去。
    if (goTrimSpace(message) !== '') prompt += '\n\n用户补充：' + goTrimSpace(message);
  } else if ((sess.meta.turns ?? []).length === 0 && sess.meta.kind === 'chat') {
    prompt = chatPreamble(rulesName) + message;
  } else {
    prompt = message;
  }
  // 导演用的模型看不了图：每一轮都提醒，续接的会话里它也可能走到画面验收、复查。
  if (orchestratorCannotSee(cfg)) prompt += '\n\n---\n\n' + noVisionNote;
  const [brief, digest] = preferenceBrief(p, cfg);
  const resend = brief !== '' && (digest !== (sess.meta.preference_digest ?? '') || !sess.meta.cli_session_id || (sess.meta.turns ?? []).length === 0);
  if (resend) prompt = brief + '\n---\n\n' + prompt;
  const display = req.message || '开始整片制作';
  const turn: Turn = {
    turn_id: newID('t'),
    session_id: sess.meta.session_id,
    kind: sess.meta.kind,
    message: display,
    status: 'running',
    started_at: nowTime(),
    before,
    changes: [],
  };
  saveTurn(p.path, turn);
  updateMeta(sess, (meta) => {
    meta.turns = [...(meta.turns ?? []), turn.turn_id];
    meta.running_turn = turn.turn_id;
    if (resend) meta.preference_digest = digest || undefined;
    if (!meta.tool) meta.tool = cfg.orchestrator;
  });
  emit(sess, turn.turn_id, { kind: kindUser, text: display + attachmentText(req.attachments) });
  emit(sess, turn.turn_id, { kind: kindTurnStart, status: 'running' });
  return { turn, prompt };
}

/**
 * runTurn 在后台跑一轮。写权由 finishTurn 释放，这里不能再释放一次：
 * 释放之后下一轮可能已经拿到写权，重复释放会把它的锁也放掉。
 */
async function runTurn(s: Server, signal: AbortSignal, p: Project, sess: Session, cfg: config.Config, turn: Turn, prompt: string): Promise<void> {
  let runErr: Error | null = null;
  let stopViews: () => void = () => {};
  try {
    const env = config.childEnvironment(cfg, envMap(), s.config.unsafe, parsePassthrough(process.env.ONSET_PASSTHROUGH_ENV ?? ''));
    // onset 不进编排工具的 PATH：它只经 onset 的工具服务（MCP）调用 onset，下面的 spec.toolsServer。
    addToolsLocation(env);
    const inbox = viewInbox(studioRoot(p.path), turn.turn_id);
    env[ViewInboxEnv] = inbox;
    env[ViewProjectEnv] = p.path;
    stopViews = watchViews(sess, turn.turn_id, inbox, p.path);
    let lastStat = statTree(p.path);
    let lastCheck = Date.now();
    const checkFiles = (force: boolean): void => {
      if (!force && Date.now() - lastCheck < changeCheckInterval) return;
      lastCheck = Date.now();
      const current = statTree(p.path);
      const changed = changedPaths(lastStat, current);
      if (changed.length > 0) emit(sess, turn.turn_id, { kind: kindFilesChanged, files: changed });
      lastStat = current;
    };
    const onEvent = (event: agentrun.Event): void => {
      if (event.kind === agentrun.KindDone) return;
      if (event.kind === agentrun.KindSession) updateMeta(sess, (meta) => (meta.cli_session_id = event.session_id || undefined));
      emit(sess, turn.turn_id, { ...event });
      if (event.kind === agentrun.KindToolResult) checkFiles(false);
    };
    const previous = sess.meta.cli_session_id ?? '';
    const earlierTurns = (sess.meta.turns ?? []).length > 1;
    // 末尾两条是本轮刚发的 user 与 turn-start，不算进历史。
    const history = transcript(sess.events.slice(0, Math.max(sess.events.length - 2, 0)));
    // 「以后都允许」的前缀并进白名单；claude 遇到白名单外的调用时经 onset studio permission-mcp 问界面上的用户。
    const access = config.orchestratorAccess(cfg);
    access.commands = [...(access.commands ?? []), ...allowedCommands(p.path)];
    const spec: agentrun.Spec = {
      tool: cfg.orchestrator,
      model: cfg.orchestratorModel,
      workdir: p.path,
      prompt,
      unsafe: s.config.unsafe,
      access,
      permissionPrompt: permissionPrompt(s.executable()),
      toolsServer: tools.onsetToolsServer(s.executable(), 'orchestrator', p.path, env),
      // codebuddy、opencode、codex 走双向协议，审批请求由 agentrun 直接交到这里：写进同一个收件目录，
      // 与审批 MCP 走同一条路（轮询、卡片、以后都允许），等用户回答。
      ask: async (toolName, input) => {
        const req = writePermissionRequest(inbox, toolName, input);
        return (await waitPermissionResponse(inbox, req.id, PermissionPollInterval, signal)) ?? { decision: 'expired' };
      },
      env,
      lookPath: (name) => lookPath(name, env.PATH ?? ''),
    };
    const resumed = previous !== '' && earlierTurns;
    if (resumed) {
      spec.sessionID = previous;
      spec.resume = true;
    } else {
      spec.sessionID = agentrun.newSessionID(cfg.orchestrator);
      if (earlierTurns && history !== '') spec.prompt = reseedPrompt(history, prompt);
    }
    let outcome = await agentrun.run(spec, onEvent, signal);
    recordUsage(signal, p, sess, cfg.orchestrator, env, turn.turn_id, outcome);
    if (outcome.error && resumed && !outcome.result.produced && !signal.aborted) {
      emit(sess, turn.turn_id, { kind: kindNotice, text: '原会话无法续接（' + outcome.error.message + '），已带上之前的对话记录开新会话' });
      spec.sessionID = agentrun.newSessionID(cfg.orchestrator);
      spec.resume = false;
      spec.prompt = reseedPrompt(history, prompt);
      outcome = await agentrun.run(spec, onEvent, signal);
      recordUsage(signal, p, sess, cfg.orchestrator, env, turn.turn_id, outcome);
    }
    runErr = outcome.error;
    checkFiles(true);
  } catch (err) {
    // Go 版这里不会出错；TS 里任何意外都不能让写锁一直挂着。
    runErr = err instanceof Error ? err : new Error(String(err));
  }
  stopViews();
  finishTurn(s, signal, p, sess, turn, runErr);
}

/**
 * watchViews 在这一轮进行中轮询收件目录，把 onset studio show 的请求译成 view 事件。
 * 返回的函数停止轮询、把剩下的请求处理完并删掉收件目录；可以调用多次。
 */
function watchViews(sess: Session, turnID: string, inbox: string, projectPath: string): () => void {
  const seen = new Set<string>();
  const emitPermission = (turn: string, event: NewEvent): void => emit(sess, turn, event);
  const deliver = (): void => {
    for (const req of drainViewInbox(inbox)) {
      if (req.step) writeStepMark(projectPath, req.step);
      emit(sess, turnID, { kind: KindView, text: req.note || undefined, view: req });
    }
    pollPermissions(projectPath, inbox, turnID, sess.permissions, seen, emitPermission);
  };
  const timer = setInterval(deliver, ViewPollInterval);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    deliver();
    expirePermissions(sess.permissions, turnID, emitPermission);
    fs.rmSync(inbox, { recursive: true, force: true });
  };
}

export function reseedPrompt(history: string, prompt: string): string {
  return (
    '下面是这个项目里你和用户之前的对话记录（较早的部分可能被截掉），供你接上上下文：\n\n' +
    history +
    '\n\n---\n\n' +
    studioInteraction +
    '\n\n---\n\n' +
    prompt
  );
}

function finishTurn(s: Server, signal: AbortSignal, p: Project, sess: Session, turn: Turn, runErr: Error | null): void {
  let scanErr: Error | null = null;
  try {
    const after = scanTree(p.path);
    turn.after = after;
    turn.changes = diffTrees(turn.before, after);
  } catch (err) {
    scanErr = err as Error;
  }
  turn.ended_at = nowTime();
  if (signal.aborted) turn.status = 'cancelled';
  else if (runErr) {
    turn.status = 'failed';
    turn.error = runErr.message;
  } else if (scanErr) {
    turn.status = 'failed';
    turn.error = '结束快照失败：' + scanErr.message;
  } else turn.status = 'succeeded';
  try {
    saveTurn(p.path, turn);
  } catch {
    // 与 Go 版一样忽略。
  }
  if (turn.kind === 'chat' && turn.status !== 'cancelled') recordUtterance(p, turn, false);
  sess.cancel = null;
  updateMeta(sess, (meta) => (meta.running_turn = undefined));
  // 先放写权再发 turn-end：网页收到 turn-end 就可能立刻发下一轮。
  s.release(p.path);
  emit(sess, turn.turn_id, { kind: kindTurnEnd, text: turn.error || undefined, status: turn.status, changes: turn.changes ?? undefined });
  drainQueue(s, p, sess);
  // 排队的下一轮先开（它占了写权的话，钩子这次就不跑）：钩子不能挡住用户的下一句话。
  if (turn.status === 'succeeded') emitStudioEvent(s, p, 'turn.finished', { turn_id: turn.turn_id, session_id: turn.session_id, changed: (turn.changes ?? []).map((c) => c.path) });
}

/**
 * cancelSession 取消会话里正在进行的一轮。keepQueue 为 false 时一并清掉排队的消息：
 * 用户按停止，多半是不想让这些要求接着跑了；「打断并发送」要保留它们。
 */
export function cancelSession(sess: Session, keepQueue: boolean): void {
  const cancel = sess.cancel;
  let dropped = 0;
  if (cancel && !keepQueue) {
    dropped = sess.queue.length;
    sess.queue = [];
  }
  const turnID = sess.meta.running_turn ?? '';
  if (!cancel) throw new Error('这个会话没有正在进行的对话');
  if (dropped > 0) emit(sess, turnID, { kind: kindNotice, text: `已停止，排队的 ${dropped} 条消息不再发送` });
  cancel.abort();
}

/** enqueueTurn 在这一轮进行中收下一条消息：返回 false 表示会话此刻没有在跑，调用方直接开新一轮。 */
export function enqueueTurn(p: Project, sess: Session, req: TurnRequest): boolean {
  validateAttachments(p.path, req.attachments);
  if (!sess.cancel) return false;
  const queued = { ...req, queueID: newID('q') };
  sess.queue.push(queued);
  emit(sess, sess.meta.running_turn ?? '', { kind: kindQueued, text: req.message + attachmentText(req.attachments), queue_id: queued.queueID });
  return true;
}

/** unqueue 移除一条排队的消息；找不到（已经发出去了）时返回 false。 */
export function unqueue(sess: Session, queueID: string): boolean {
  const index = sess.queue.findIndex((req) => req.queueID === queueID);
  if (index >= 0) sess.queue.splice(index, 1);
  const found = index >= 0;
  if (found) emit(sess, sess.meta.running_turn ?? '', { kind: kindUnqueued, queue_id: queueID });
  return found;
}

/** steer 把一条排队的消息提到最前，并停掉进行中的一轮：这一轮结束后排队的消息立刻发出。 */
export function steer(sess: Session, queueID: string): boolean {
  const index = sess.queue.findIndex((req) => req.queueID === queueID);
  if (index > 0) {
    const [req] = sess.queue.splice(index, 1);
    sess.queue.unshift(req);
  }
  if (index < 0) return false;
  try {
    cancelSession(sess, true);
    return true;
  } catch {
    return false;
  }
}

/** drainQueue 在一轮结束后把排队的消息合并成下一轮发出。 */
function drainQueue(s: Server, p: Project, sess: Session): void {
  const queue = sess.queue;
  sess.queue = [];
  if (queue.length === 0) return;
  const merged: TurnRequest = { message: '', attachments: null };
  const messages: string[] = [];
  for (const req of queue) {
    messages.push(req.message);
    if (req.attachments && req.attachments.length > 0) merged.attachments = [...(merged.attachments ?? []), ...req.attachments];
    if (req.view) merged.view = req.view;
  }
  merged.message = messages.join('\n\n');
  if (queue.length > 1) merged.message = '（上一轮进行中你陆续补充了几条要求，一并处理）\n\n' + merged.message;
  try {
    startTurn(s, p, sess, merged);
  } catch (err) {
    emit(sess, '', { kind: kindNotice, text: '排队的消息没能发出（' + (err as Error).message + '），请重新发送：' + merged.message });
  }
}

/** revert 回退一轮，并在会话里记一条事件。 */
export function revert(s: Server, p: Project, turnID: string): { turn: Turn; skipped: string[] } {
  const turn = loadTurn(p.path, turnID);
  s.acquire(p.path, '正在回退一轮对话');
  try {
    const skipped = revertTurn(p.path, turn);
    turn.status = 'reverted';
    saveTurn(p.path, turn);
    if (turn.kind === 'chat') recordUtterance(p, turn, true);
    const sess = getSession(s, p.path, turn.session_id);
    if (sess) emit(sess, turn.turn_id, { kind: kindTurnReverted, status: 'reverted', files: skipped });
    return { turn, skipped };
  } finally {
    s.release(p.path);
  }
}

/** 解析路径失败、且原因是路径不存在（os.IsNotExist）时抛出。 */
export class NotExistError extends Error {
  readonly code = 'ENOENT';
  constructor(message: string) {
    super(message);
    this.name = 'NotExistError';
  }
}

/** filepath.EvalSymlinks：解析不了时按 Go 的 *PathError 文案抛错，不存在时抛 NotExistError。 */
export function evalSymlinks(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code === 'ENOENT' ? 'no such file or directory' : code === 'ENOTDIR' ? 'not a directory' : (err as Error).message;
    const message = `lstat ${file}: ${reason}`;
    if (code === 'ENOENT') throw new NotExistError(message);
    throw new Error(message, { cause: err });
  }
}

/** containedPath 把相对项目根的路径解析成绝对路径，拒绝逃出项目（含符号链接）。 */
export function containedPath(projectPath: string, rel: string): string {
  if (rel === '' || path.isAbsolute(rel)) throw new Error(`路径必须是项目内的相对路径：${rel}`);
  const clean = goClean(rel);
  if (clean === '..' || clean.startsWith('../')) throw new Error(`路径逃出了项目：${rel}`);
  const root = evalSymlinks(projectPath);
  const full = path.join(projectPath, clean);
  const resolved = evalSymlinks(full);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`路径逃出了项目：${rel}`);
  return full;
}

/**
 * recordUsage 把一次编排调用记进项目的用量账本。续接失败后重开的会话是两次调用，
 * 各记一行：第一次哪怕只打了一行错误，也可能已经读了一遍上下文。
 */
function recordUsage(signal: AbortSignal, p: Project, sess: Session, tool: string, env: Record<string, string>, turnID: string, outcome: agentrun.Outcome): void {
  const { result, error } = outcome;
  if (!result.started) return;
  const model = result.model || tools.configuredModel(tool, env);
  const cancelled = signal.aborted || (error !== null && (error.name === 'AbortError' || error.message === 'context canceled'));
  const entry = ledger.fromResult(ledger.SourceStudio, tool, model, result.sessionID, result.usage, error, cancelled);
  entry.turn = turnID;
  try {
    ledger.append(ledger.projectFile(p.path), entry);
  } catch (err) {
    emit(sess, turnID, { kind: kindNotice, text: '编排用量没能记进账本：' + (err as Error).message });
  }
}

/** 审批服务（onset studio permission-mcp）的启动方式；Windows 上用 Electron / Node 跑 onset.cjs（envutil.onsetCommand）。 */
function permissionPrompt(executable: string): tools.PermissionPrompt {
  const onset = onsetCommand(executable);
  return { command: onset.command, args: [...onset.args, 'studio', 'permission-mcp'], server: PermissionServerName, env: onset.env };
}
