/**
 * 装与升级第三方插件分两步：先取到用户级目录的暂存处（<stationsDir>/.staging/<编号>/），解析并校验清单、给用户看这个插件的
 * 实情（StationPreview）；用户点「装上」才写进 installed.json（installStaged），点取消就清掉暂存（discardStaged）。
 * 暂存的插件不在已装插件清单里，不参与任何项目。插件对所有项目生效，所以不能在用户看见它要什么之前就装上。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, removeTree } from '../fsutil';
import { marshalIndent } from '../gojson';
import { checkFiles, cloneSource, parseSource, placeCheckout, readManifest, stationsDir } from './fetch';
import { treeDigest } from './digest';
import { readInstalled, recordInstalled, roleOf, type InstalledEntry } from './installed';
import { experimentalFields, type HookEvent, type Manifest } from './manifest';
import { repoKey } from './market';
import { toolName } from './pages';
import { OpsTrustNotice, pagePermissionLines } from './trust';
import { updateDiff, type StationUpdate } from './update';

type Env = Record<string, string | undefined>;

/** 暂存处（点开头：插件 id 以小写字母开头，不会撞上）。 */
export const StagingDir = '.staging';
const stagedFile = 'staged.json';
const tokenPattern = /^[0-9a-f]{16}$/;

/** 钩子事件的说法（预览与设置页共用）。 */
export const HookEventLabels: Record<HookEvent, string> = {
  'turn.finished': '每轮对话结束后',
  'task.finished': '每个任务跑完后',
  'gate.confirmed': '你确认一个审核关卡后',
  'film.approved': '你确认成片可用后',
};

/** 装上之前给用户看的实情。 */
export interface StationPreview {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  commit: string;
  linked: boolean;
  /** 操作：AI 能调的工具（tool 是工具名）与只能由用户点的按钮。 */
  ops: { name: string; summary: string; trigger: 'agent' | 'user'; tool: string }[];
  /** 有操作时是 OpsTrustNotice：操作是电脑上的普通程序。 */
  ops_trust: string;
  /** 页面申请的权限（看项目、读文件、联网、请你确认后执行），一项一句（命令行用）。 */
  page_permissions: string[];
  /** 同一份权限的原样（界面按自己的说法列）：清单的 permissions 与页面能读的文件。 */
  permissions: Manifest['permissions'];
  browser?: Manifest['browser'];
  reads: string[];
  pages: string[];
  experimental: string[];
  hooks: { on: string; label: string; op: string; summary: string }[];
  schedules: { every_minutes: number; op: string; summary: string }[];
  renderer_skills: { name: string; summary: string; scenes: 'all' | 'opt-in' }[];
  /** 带了 scenes: all 的渲染技能：装上后所有项目里已渲染的镜头都要重渲染。 */
  rerender_all: boolean;
  /** 带来的片型（流程名），没有为空。 */
  flow: string;
  /** 带来的整片风格库名，没有为空。 */
  film_styles: string;
  /** 带来的界面皮肤（清单里列的皮肤文件；名字要读文件，设置页装好后在「详情」里列）。 */
  skins: string[];
  provides: { tts: string; align: string };
  replaces: string;
  after: string;
  /** 它在制作路线上的站点。 */
  nodes: string[];
  inserts: string[];
  /** 是升级时：与已装那一版的差异。 */
  update?: Omit<StationUpdate, 'before' | 'after' | 'linked'> & { commit_before: string; commit_after: string };
}

export interface Staged {
  token: string;
  entry: InstalledEntry;
  preview: StationPreview;
}

interface StagedRecord {
  entry: InstalledEntry;
  update?: StationPreview['update'];
}

function stagingRoot(env: Env): string {
  return path.join(stationsDir(env), StagingDir);
}

function stagingDir(token: string, env: Env): string {
  if (!tokenPattern.test(token)) throw new Error(`没有这个待装的插件：${token}`);
  return path.join(stagingRoot(env), token);
}

/** 暂存的插件目录：git 来源是暂存处的 src，link 是本机目录本身。 */
function stagedSourceDir(token: string, entry: InstalledEntry, env: Env): string {
  const src = parseSource(entry.source);
  return src.kind === 'link' ? src.dir : path.join(stagingDir(token, env), 'src');
}

/** 由清单算出给用户看的实情。 */
export function previewOf(m: Manifest, entry: InstalledEntry): StationPreview {
  const opSummary = (name: string) => m.ops.find((o) => o.name === name)?.summary ?? name;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    source: entry.source,
    commit: entry.commit,
    linked: entry.commit === '',
    ops: m.ops.map((o) => ({ name: o.name, summary: o.summary, trigger: o.trigger, tool: o.trigger === 'agent' ? toolName(m.id, o.name) : '' })),
    ops_trust: m.ops.length > 0 ? OpsTrustNotice : '',
    page_permissions: pagePermissionLines(m),
    permissions: m.permissions,
    browser: m.browser,
    reads: [...new Set(m.pages.flatMap((p) => p.reads))],
    pages: m.pages.map((p) => p.label),
    experimental: experimentalFields(m),
    hooks: m.hooks.map((h) => ({ on: h.on, label: HookEventLabels[h.on] ?? h.on, op: h.op, summary: opSummary(h.op) })),
    schedules: m.schedules.map((sc) => ({ every_minutes: sc.every_minutes, op: sc.op, summary: opSummary(sc.op) })),
    renderer_skills: m.renderer_skills.map((r) => ({ name: r.name, summary: r.summary, scenes: r.scenes })),
    rerender_all: m.renderer_skills.some((r) => r.scenes === 'all'),
    flow: m.flow?.name ?? '',
    film_styles: m.film_styles?.name ?? '',
    skins: m.skins,
    provides: { tts: m.provides.tts?.name ?? '', align: m.provides.align?.name ?? '' },
    replaces: m.replaces,
    after: m.after,
    nodes: m.nodes.map((n) => n.label),
    inserts: m.inserts.map((i) => i.stage),
  };
}

function writeStaged(token: string, rec: StagedRecord, env: Env): void {
  atomicWrite(path.join(stagingDir(token, env), stagedFile), marshalIndent(rec) + '\n', 0o644);
}

/** 取回后既没装也没取消的暂存目录留这么久（毫秒）；超过了下次取插件时清掉。 */
export const StagingMaxAgeMs = 24 * 60 * 60 * 1000;

/** 清掉放了太久的暂存目录：用户关掉确认框、客户端中途退出都会留下它们。清不掉的不算错。 */
function sweepStaging(env: Env): void {
  const root = stagingRoot(env);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - StagingMaxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || !tokenPattern.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) removeTree(dir);
    } catch {
      // 别的进程正在用或已经删了。
    }
  }
}

function newStaging(env: Env): { token: string; dir: string } {
  sweepStaging(env);
  const token = crypto.randomBytes(8).toString('hex');
  const dir = path.join(stagingRoot(env), token);
  fs.mkdirSync(dir, { recursive: true });
  return { token, dir };
}

/** 按来源取到暂存处，校验清单。不写已装插件清单。 */
/**
 * prepared：已经取好、核对过内容摘要的目录（archive.ts 的 fetchArchive，不用 git 的那条路）。给了就挪进暂存处，
 * 不再克隆；commit 是来源里写的完整 commit。
 */
function fetchToStaging(spec: string, env: Env, log: (line: string) => void, prepared?: string): { token: string; entry: InstalledEntry; manifest: Manifest } {
  const src = parseSource(spec);
  const { token, dir } = newStaging(env);
  try {
    if (src.kind === 'link') {
      const manifest = readManifest(src.dir);
      checkFiles(src.dir, manifest);
      const entry: InstalledEntry = { id: manifest.id, version: manifest.version, source: `link:${src.dir}`, commit: '', digest: '', role: roleOf(manifest) };
      return { token, entry, manifest };
    }
    if (prepared) {
      if (!/^[0-9a-f]{40}$/.test(src.ref)) throw new Error(`用压缩包取插件时来源要钉在完整 commit 上：${spec}`);
      const checkout = path.join(dir, 'src');
      fs.renameSync(prepared, checkout);
      const manifest = readManifest(checkout);
      checkFiles(checkout, manifest);
      const entry: InstalledEntry = { id: manifest.id, version: manifest.version, source: spec.trim(), commit: src.ref, digest: treeDigest(checkout), role: roleOf(manifest) };
      return { token, entry, manifest };
    }
    const got = cloneSource(src.url, src.ref, path.join(dir, 'src'), env, log);
    const entry: InstalledEntry = { id: got.manifest.id, version: got.manifest.version, source: spec.trim(), commit: got.commit, digest: got.digest, role: roleOf(got.manifest) };
    return { token, entry, manifest: got.manifest };
  } catch (err) {
    try {
      removeTree(dir);
    } catch (cleanupError) {
      // 清理失败不能掩盖取回或校验插件时的原错误；过期暂存下次再清。
      if (process.platform !== 'win32') throw cleanupError;
    }
    throw err;
  }
}

/**
 * 取回之后要核对的：从插件中心装时，清单 id 与 commit 必须是目录里列的那一版。对不上就清掉暂存、报错，
 * 不给用户看一个和插件中心说的不一样的东西。
 */
export interface StageExpect {
  id?: string;
  commit?: string;
}

function checkExpect(token: string, entry: InstalledEntry, expect: StageExpect | undefined, env: Env): void {
  if (!expect) return;
  let problem = '';
  if (expect.id && entry.id !== expect.id) problem = `取回的插件 id 是 ${entry.id}，不是插件中心列的 ${expect.id}`;
  else if (expect.commit && entry.commit !== expect.commit) problem = `取回的 commit 是 ${entry.commit.slice(0, 12) || '（本机目录）'}，不是插件中心列的 ${expect.commit.slice(0, 12)}`;
  if (problem === '') return;
  removeTree(stagingDir(token, env));
  throw new Error(`${problem}；为安全起见不装`);
}

/** 第一步：把一个插件取到暂存处，给出它的实情。expect 给了就核对 id 与 commit（插件中心）。 */
export function stageStation(spec: string, env: Env = process.env, log: (line: string) => void = () => {}, expect?: StageExpect, prepared?: string): Staged {
  const { token, entry, manifest } = fetchToStaging(spec, env, log, prepared);
  checkExpect(token, entry, expect, env);
  writeStaged(token, { entry }, env);
  return { token, entry, preview: previewOf(manifest, entry) };
}

/**
 * 升级的第一步：重新取到暂存处，给出新一版的实情与差异。link 来源不用更新。
 * 缺省按已装那一项记的来源取；从插件中心升级时 source 是目录里新一版的来源（`<仓库>#<commit>`），
 * 必须和已装的是同一个仓库（换仓库等于换作者，要先去掉再添加），expect 核对 commit。
 */
export function stageUpdate(id: string, env: Env = process.env, log: (line: string) => void = () => {}, opts: { source?: string; expect?: StageExpect; prepared?: string } = {}): Staged {
  const before = readInstalled(stationsDir(env)).plugins.find((e) => e.id === id);
  if (!before) throw new Error(`没有装插件 ${id}`);
  if (parseSource(before.source).kind === 'link') throw new Error(`插件 ${id} 来自本机目录，改动立即生效，不需要更新`);
  const source = opts.source?.trim() || before.source;
  if (source !== before.source) {
    const next = parseSource(source);
    if (next.kind !== 'git' || repoKey(source) !== repoKey(before.source)) throw new Error(`插件 ${id} 装的来源是 ${before.source}，不能换成 ${source}；要换来源请先去掉再添加`);
  }
  const { token, entry, manifest } = fetchToStaging(source, env, log, opts.prepared);
  if (manifest.id !== id) {
    removeTree(stagingDir(token, env));
    throw new Error(`来源 ${source} 现在的清单 id 是 ${manifest.id}，与这个插件（${id}）不符；要换插件请先去掉再添加`);
  }
  checkExpect(token, entry, opts.expect, env);
  const d = updateDiff(before, entry, manifest, env);
  const update = {
    id,
    old_version: d.old_version,
    new_version: d.new_version,
    new_permissions: d.new_permissions,
    new_experimental: d.new_experimental,
    experimental: d.experimental,
    changed: d.changed,
    commit_before: before.commit,
    commit_after: entry.commit,
  };
  writeStaged(token, { entry, update }, env);
  return { token, entry, preview: { ...previewOf(manifest, entry), update } };
}

/** 读一个暂存的插件（重新解析清单）。 */
export function readStaged(token: string, env: Env = process.env): Staged {
  let rec: StagedRecord;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(stagingDir(token, env), stagedFile), 'utf8')) as StagedRecord;
  } catch {
    throw new Error(`没有这个待装的插件：${token}（可能已经装上或取消了）`);
  }
  const dir = stagedSourceDir(token, rec.entry, env);
  const manifest = readManifest(dir);
  const preview = previewOf(manifest, rec.entry);
  return { token, entry: rec.entry, preview: rec.update ? { ...preview, update: rec.update } : preview };
}

/**
 * 第二步：用户看过、点了「装上」。git 来源再核对一遍暂存内容的摘要（看过之后被改的不装），放进按 commit 存的目录，
 * 写进已装插件清单（同 id 的换成新的），清掉暂存。
 */
export function installStaged(token: string, env: Env = process.env): InstalledEntry {
  const { entry } = readStaged(token, env);
  const dir = stagedSourceDir(token, entry, env);
  const manifest = readManifest(dir);
  if (manifest.id !== entry.id) throw new Error(`待装插件的清单 id 变成了 ${manifest.id}，与看过的 ${entry.id} 不符；请重新添加`);
  checkFiles(dir, manifest);
  if (entry.digest !== '') {
    if (treeDigest(dir) !== entry.digest) throw new Error(`插件 ${entry.id} 在你看过之后被改过，为安全起见不装；请重新添加`);
    placeCheckout(dir, entry, env);
  } else if (manifest.version !== entry.version) {
    throw new Error(`插件 ${entry.id} 的版本在你看过之后变了，请重新添加`);
  }
  recordInstalled(stationsDir(env), entry);
  removeTree(stagingDir(token, env));
  return entry;
}

/** 取消：清掉暂存（不碰已装插件清单）。 */
export function discardStaged(token: string, env: Env = process.env): void {
  removeTree(stagingDir(token, env));
}
