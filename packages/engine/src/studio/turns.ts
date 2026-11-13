/**
 * 每轮对话前后各扫一遍项目，记下每个文件的状态；两次之差就是这一轮的改动。移植自 internal/studio/turns.go。
 *
 * Studio 自己不改项目文件，所以「回退这一轮」只能靠快照：文本文件的内容按 sha256
 * 存进 production/studio/blobs/，相同内容只存一份；媒体与超大文件只记大小和修改
 * 时间，能列出变化，但不回退——一段渲染产物几十兆，每轮存一份不现实，重渲染即可。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent, sortedKeys } from '../gojson';
import * as ledger from '../ledger';

/** maxSnapshotBytes 以上的文件只记 stat，不存内容。 */
export const maxSnapshotBytes = 2 << 20;
export const statPrefix = 'stat:';
export const shaPrefix = 'sha256:';

/**
 * skippedDirs 是快照不进入的目录。production/studio 是 Studio 自己的状态，
 * production/usage 是编排用量的账本（在一轮结束前写下，不跳过的话会算成这一轮的改动，
 * 回退时把账一起抹掉），
 * attempts 与 .studio-frames 是渲染与抽帧的副产物，其余是依赖与工具缓存。
 */
export const skippedDirs: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'attempts',
  '.studio-frames',
  '.agents',
  '__pycache__',
  '.venv',
  '.cache',
]);

/** mediaExtensions 直接按 stat 处理，不读内容。 */
const mediaExtensions: ReadonlySet<string> = new Set([
  '.mp4', '.mov', '.webm', '.mkv', '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.png', '.jpg',
  '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.zip', '.psd',
]);

/**
 * fileTree 是相对项目根的斜杠路径到状态的映射。状态是 "sha256:<hex>"（内容已存）
 * 或 "stat:<大小>:<修改时间纳秒>"（只记 stat）。
 */
export type FileTree = Record<string, string>;

/** 一轮里一个文件的变化。change：added | modified | deleted。 */
export interface FileChange {
  path: string;
  change: string;
  revertable: boolean;
}

/** 一轮对话的记录。时间字段是 Go 写法的字符串（见 http.ts 的 nowTime），读进来的原样保留。 */
export interface Turn {
  turn_id: string;
  session_id: string;
  /** chat | production */
  kind: string;
  message: string;
  /** running | succeeded | failed | cancelled | interrupted | reverted */
  status: string;
  error?: string;
  started_at: string;
  ended_at?: string;
  /** Go 的 nil 切片写成 null。 */
  changes: FileChange[] | null;
  before: FileTree | null;
  after?: FileTree | null;
}

/** 按 Go struct 的字段顺序与 omitempty 排出可交给 gojson 的对象。 */
export function turnJSON(turn: Turn): Record<string, unknown> {
  return {
    turn_id: turn.turn_id,
    session_id: turn.session_id,
    kind: turn.kind,
    message: turn.message,
    status: turn.status,
    error: turn.error || undefined,
    started_at: turn.started_at,
    ended_at: turn.ended_at || undefined,
    changes: turn.changes,
    before: turn.before ? sortedKeys(turn.before) : null,
    after: turn.after && Object.keys(turn.after).length > 0 ? sortedKeys(turn.after) : undefined,
  };
}

/** studioRoot 是项目里 Studio 状态的目录。 */
export function studioRoot(project: string): string {
  return path.join(project, 'production', 'studio');
}

function blobPath(project: string, state: string): string {
  return path.join(studioRoot(project), 'blobs', state.startsWith(shaPrefix) ? state.slice(shaPrefix.length) : state);
}

/** 同步遍历（filepath.WalkDir 的词法顺序）。visit 返回 'skip' 跳过目录。 */
export function walkDir(root: string, visit: (file: string, entry: fs.Dirent | null, isRoot: boolean) => 'skip' | 'stop' | void): void {
  let stopped = false;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareBytes(a.name, b.name));
    for (const entry of entries) {
      if (stopped) return;
      const full = path.join(dir, entry.name);
      const result = visit(full, entry, false);
      if (result === 'stop') {
        stopped = true;
        return;
      }
      if (entry.isDirectory() && result !== 'skip') walk(full);
    }
  };
  walk(root);
}

/** 快照与文件树都不进入的目录：上面那张表、Studio 状态目录与用量账本。 */
export function skipDir(project: string, dir: string, name: string): boolean {
  return dir !== project && (skippedDirs.has(name) || dir === studioRoot(project) || dir === ledger.projectDir(project));
}

/** 文件的修改时间（纳秒），对应 info.ModTime().UnixNano()。 */
function mtimeNanos(info: fs.BigIntStats): bigint {
  return info.mtimeNs;
}

function statState(info: fs.BigIntStats): string {
  return `${statPrefix}${info.size}:${mtimeNanos(info)}`;
}

/**
 * renderRecord 报告文件是不是渲染的尝试记录。它记的是已经发生的事（花了多少
 * token、为什么失败），回退一轮不能把它删掉，所以和媒体一样只记 stat、不回退。
 */
export function renderRecord(file: string): boolean {
  const name = path.basename(file);
  return name.startsWith('render-') && name.endsWith('.attempt.json');
}

/** fileState 计算一个文件的状态；文本文件顺带存进 blob。 */
function fileState(project: string, file: string, info: fs.BigIntStats): string {
  if (info.size > BigInt(maxSnapshotBytes) || mediaExtensions.has(path.extname(file).toLowerCase()) || renderRecord(file)) {
    return statState(info);
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch {
    // 读不了（权限、竞态删除）就退回 stat，不让整轮失败。
    return statState(info);
  }
  if (body.subarray(0, 8192).includes(0)) return statState(info);
  const state = shaPrefix + crypto.createHash('sha256').update(body).digest('hex');
  const blob = blobPath(project, state);
  if (!fs.existsSync(blob)) {
    try {
      atomicWrite(blob, body, 0o644);
    } catch (err) {
      throw new Error(`写快照：${(err as Error).message}`, { cause: err });
    }
  }
  return state;
}

/** scanTree 扫描项目，必要时把文本内容写进 blob 存储。 */
export function scanTree(project: string): FileTree {
  // 根目录读不了时报错（Go 的 WalkDir 把根的错误交给回调，回调原样返回）。
  fs.readdirSync(project);
  const tree: FileTree = {};
  walkDir(project, (file, entry) => {
    if (!entry) return;
    if (entry.isDirectory()) return skipDir(project, file, entry.name) ? 'skip' : undefined;
    if (!entry.isFile()) return;
    let info: fs.BigIntStats;
    try {
      info = fs.lstatSync(file, { bigint: true });
    } catch {
      return;
    }
    tree[path.relative(project, file).split(path.sep).join('/')] = fileState(project, file, info);
  });
  return tree;
}

/** currentState 读取单个文件的当前状态；不存在时返回空串。 */
function currentState(project: string, rel: string): string {
  const file = path.join(project, rel);
  let info: fs.BigIntStats;
  try {
    info = fs.statSync(file, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
  return fileState(project, file, info);
}

export function isContentState(state: string | undefined): boolean {
  return (state ?? '').startsWith(shaPrefix);
}

/** diffTrees 比较前后两次扫描，按路径排序返回变化。 */
export function diffTrees(before: FileTree | null, after: FileTree): FileChange[] {
  const old = before ?? {};
  const changes: FileChange[] = [];
  for (const [file, state] of Object.entries(old)) {
    if (!Object.hasOwn(after, file)) changes.push({ path: file, change: 'deleted', revertable: isContentState(state) });
    else if (after[file] !== state) changes.push({ path: file, change: 'modified', revertable: isContentState(state) && isContentState(after[file]) });
  }
  for (const [file, state] of Object.entries(after)) {
    if (!Object.hasOwn(old, file)) changes.push({ path: file, change: 'added', revertable: isContentState(state) });
  }
  changes.sort((a, b) => compareBytes(a.path, b.path));
  return changes;
}

/** readBlob 读出某个状态对应的内容；stat 状态与空状态返回 null。 */
export function readBlob(project: string, state: string | undefined): Buffer | null {
  if (!isContentState(state)) return null;
  return fs.readFileSync(blobPath(project, state!));
}

/** ConflictError 表示回退时有文件在这一轮之后又被改过。 */
export class ConflictError extends Error {
  constructor(readonly paths: string[]) {
    super('这些文件在本轮之后又被改过，不能直接回退：' + paths.join('、'));
    this.name = 'ConflictError';
  }
}

/**
 * revertTurn 把一轮里可回退的改动恢复成本轮开始前的样子。
 *
 * 先全部检查、再统一写入：只要有一个文件的当前状态不是本轮结束时的状态，
 * 就整体拒绝，不做部分回退。返回跳过的（不可回退的）路径。
 */
export function revertTurn(project: string, turn: Turn): string[] {
  if (turn.status === 'running') throw new Error('本轮还在进行，不能回退');
  if (turn.status === 'reverted') throw new Error('本轮已经回退过');
  if (!turn.after) throw new Error('本轮没有结束快照，无法判断改动');
  const conflicts: string[] = [];
  const skipped: string[] = [];
  for (const change of turn.changes ?? []) {
    if (!change.revertable) {
      skipped.push(change.path);
      continue;
    }
    if (currentState(project, change.path) !== (turn.after[change.path] ?? '')) conflicts.push(change.path);
  }
  if (conflicts.length > 0) throw new ConflictError(conflicts);
  for (const change of turn.changes ?? []) {
    if (!change.revertable) continue;
    const file = path.join(project, change.path);
    if (change.change === 'added') {
      fs.rmSync(file, { force: true });
      continue;
    }
    let body: Buffer | null;
    try {
      body = readBlob(project, turn.before?.[change.path]);
    } catch (err) {
      throw new Error(`读取 ${change.path} 的快照：${(err as Error).message}`, { cause: err });
    }
    let mode = 0o644;
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      // 文件被删了：按默认权限写回。
    }
    atomicWrite(file, body ?? Buffer.alloc(0), mode);
  }
  return skipped;
}

function turnPath(project: string, id: string): string {
  return path.join(studioRoot(project), 'turns', id + '.json');
}

export function saveTurn(project: string, turn: Turn): void {
  atomicWrite(turnPath(project, turn.turn_id), marshalIndent(turnJSON(turn)) + '\n', 0o644);
}

/** 读不到（含非法 id）时抛错；ENOENT 的 code 保留，供调用方判断。 */
export function loadTurn(project: string, id: string): Turn {
  if (!validID(id)) {
    const err = new Error('file does not exist') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  return decodeTurn(fs.readFileSync(turnPath(project, id), 'utf8'));
}

function str(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`json: cannot unmarshal into Go struct field Turn.${key} of type string`);
  return value;
}

function tree(value: unknown): FileTree | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('json: cannot unmarshal into Go struct field of type studio.fileTree');
  return value as FileTree;
}

/** json.Unmarshal 进 Turn。 */
export function decodeTurn(body: string): Turn {
  const raw = JSON.parse(body) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('json: cannot unmarshal into Go value of type studio.Turn');
  let changes: FileChange[] | null = null;
  if (Array.isArray(raw.changes)) {
    changes = raw.changes.map((item) => {
      const c = (item ?? {}) as Record<string, unknown>;
      return { path: str(c, 'path'), change: str(c, 'change'), revertable: c.revertable === true };
    });
  }
  const turn: Turn = {
    turn_id: str(raw, 'turn_id'),
    session_id: str(raw, 'session_id'),
    kind: str(raw, 'kind'),
    message: str(raw, 'message'),
    status: str(raw, 'status'),
    started_at: str(raw, 'started_at') || '0001-01-01T00:00:00Z',
    changes,
    before: tree(raw.before),
  };
  const error = str(raw, 'error');
  if (error) turn.error = error;
  const ended = str(raw, 'ended_at');
  if (ended) turn.ended_at = ended;
  const after = tree(raw.after);
  if (after) turn.after = after;
  return turn;
}

/** statTree 只取 stat，不读内容，供对话进行中频繁检查「有没有文件变了」。 */
export function statTree(project: string): Record<string, string> {
  const out: Record<string, string> = {};
  walkDir(project, (file, entry) => {
    if (!entry) return;
    if (entry.isDirectory()) return skipDir(project, file, entry.name) ? 'skip' : undefined;
    if (!entry.isFile()) return;
    try {
      out[path.relative(project, file).split(path.sep).join('/')] = statState(fs.lstatSync(file, { bigint: true }));
    } catch {
      // 竞态删除：下一次检查再说。
    }
  });
  return out;
}

/** changedPaths 比较两次 stat，返回变化过的路径。 */
export function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  const paths: string[] = [];
  for (const [file, state] of Object.entries(after)) if (before[file] !== state) paths.push(file);
  for (const file of Object.keys(before)) if (!Object.hasOwn(after, file)) paths.push(file);
  return paths.sort(compareBytes);
}

/** validID 只允许 Studio 自己生成的 id 字符，防止路径穿越。 */
export function validID(id: string): boolean {
  if (id === '' || id.length > 80) return false;
  return /^[a-z0-9-]+$/.test(id);
}
