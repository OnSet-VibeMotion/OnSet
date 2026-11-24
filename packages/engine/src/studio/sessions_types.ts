/**
 * 会话的数据结构、JSON 序列化、错误类型与路径/编号工具。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as agentrun from '../agentrun';
import { goClean } from '../gofmt';
import type { ViewRequest, ViewState } from '../studioview';
import { type PendingPermission, type PermissionEventData, permissionEventJSON } from './permissions';
import { type FileChange, studioRoot } from './turns';

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

/** maxQuoteRunes 是一条引用的上限：再长就该让编排工具自己去读文件。 */
export const maxQuoteRunes = 4000;

/** 会话的元数据，落在 production/studio/sessions/<id>.json。时间字段是 Go 写法的字符串。 */
export interface SessionMeta {
  session_id: string;
  title: string;
  /** chat | production */
  kind: string;
  tool: string;
  /** 编排工具的模型；空跟随设置（同一家工具时）或用那家工具自己的默认。 */
  model?: string;
  /** 编排工具的调用选项（effort=high,fast=on，见 tools/options.ts）；空跟随设置（同一家工具时）。 */
  options?: string;
  renderer?: string;
  renderer_model?: string;
  renderer_options?: string;
  cli_session_id?: string;
  created_at: string;
  updated_at: string;
  turns: string[] | null;
  running_turn?: string;
  /**
   * 上一次交给编排工具的用户偏好段的摘要：偏好没变、CLI 会话也还在时不再重复发送，续接的会话里已经有了。
   */
  preference_digest?: string;
  /** 上一次交给编排工具的专栏规范（seriesPromptBrief）摘要：同会话未修订时不重复追加。 */
  series_brief_digest?: string;
  /** 上一次交给编排工具的镜头归属规则（scene-ownership.md）摘要：同会话未修订时不每轮重复追加 5KB。 */
  ownership_digest?: string;
  /** 当前 CLI 会话是否已经发送过无视觉提醒（noVisionNote）。 */
  vision_note_sent?: boolean;
  /** 当前 CLI 会话最近一次发送过的本地风格操作回执，避免后续每轮重复前置。 */
  local_style_receipt?: string;
  /** 手动或关卡确认触发阶段分段接力时记下原因，下一轮消费并开启新 CLI 会话。 */
  handoff_reason?: string;
}

export function sessionMetaJSON(meta: SessionMeta): Record<string, unknown> {
  return {
    session_id: meta.session_id,
    title: meta.title,
    kind: meta.kind,
    tool: meta.tool,
    model: meta.model || undefined,
    options: meta.options || undefined,
    renderer: meta.renderer || undefined,
    renderer_model: meta.renderer_model || undefined,
    renderer_options: meta.renderer_options || undefined,
    cli_session_id: meta.cli_session_id || undefined,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    turns: meta.turns,
    running_turn: meta.running_turn || undefined,
    preference_digest: meta.preference_digest || undefined,
    series_brief_digest: meta.series_brief_digest || undefined,
    ownership_digest: meta.ownership_digest || undefined,
    vision_note_sent: meta.vision_note_sent || undefined,
    local_style_receipt: meta.local_style_receipt || undefined,
    handoff_reason: meta.handoff_reason || undefined,
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
    changes:
      e.changes && e.changes.length > 0
        ? e.changes.map((c) => ({ path: c.path, change: c.change, revertable: c.revertable }))
        : undefined,
    queue_id: e.queue_id || undefined,
    view: e.view
      ? {
          page: e.view.page,
          target: e.view.target || undefined,
          note: e.view.note || undefined,
          step: e.view.step || undefined,
        }
      : undefined,
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
  /** 两家工具各自的调用选项（effort=high,fast=on），规则同模型：undefined 不改，空串跟随设置。 */
  options?: string;
  rendererOptions?: string;
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

/** 要追加的事件：seq、turn_id、time 由 emit 填。 */
export type NewEvent = Omit<SessionEvent, 'seq' | 'time' | 'turn_id'>;

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

export function sessionKey(projectPath: string, id: string): string {
  return projectPath + '\x00' + id;
}

/** newID 生成 <前缀>-<UTC 时间>-<8 位十六进制>，只含 validID 认的字符。 */
export function newID(prefix: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
  return prefix + '-' + stamp + '-' + crypto.randomBytes(4).toString('hex');
}

export function sessionsDir(projectPath: string): string {
  return path.join(studioRoot(projectPath), 'sessions');
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
    const reason =
      code === 'ENOENT' ? 'no such file or directory' : code === 'ENOTDIR' ? 'not a directory' : (err as Error).message;
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
