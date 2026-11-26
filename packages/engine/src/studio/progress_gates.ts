/**
 * 审核关卡的记录读写、变更比对与文件时间统计（供制作路线使用）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as align from '../align';
import { hasRoster } from '../cast';
import * as flow from '../flow';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { candidateFilm, projectVideoDigest } from './reviewreport';
import { discoverScenes, type SceneSummary } from './scenes';
import { localRFC3339 } from './script';
import { readBlob, storeBlob } from './turns';

/** 关卡确认记录。 */
export const gatesPath = 'production/studio/gates.json';

export interface GateRecord {
  at: string;
  files: Record<string, string>;
  /** 在对话里确认的：用户的原话（studio_confirm）。界面按钮确认的没有。 */
  said?: string;
}

/** 解析项目的打样代表镜（未指定 pilot_scene 时取第 1 镜）。 */
export function resolvePilotScene(
  root: string,
  scenes?: readonly SceneSummary[],
): { id: string; scene?: SceneSummary } {
  const list = scenes ?? discoverScenes(root);
  const configured = flow.readPilotConfig(root).scene;
  if (configured) {
    const match = list.find((sc) => sc.id === configured);
    return match ? { id: match.id, scene: match } : { id: configured };
  }
  const first = list[0];
  return first ? { id: first.id, scene: first } : { id: '' };
}

/** 打样镜头 MP4 相对项目根的路径；镜头尚未建好或未声明 output 时返回 null。 */
export function pilotGateFile(root: string, scenes?: readonly SceneSummary[]): string | null {
  const { scene } = resolvePilotScene(root, scenes);
  if (!scene?.output) return null;
  const rel = path.relative(root, path.join(scene.directory, scene.output)).replaceAll('\\', '/');
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/** 关卡绑定的文件：确认后它们变了，确认就不算数。来自各站的声明，已装的第三方插件的关卡也算；开启 pilot_gate 的项目额外带上 gate-pilot。 */
export function gateFilesFor(root?: string): Record<string, string[]> {
  const out = flow.gateFiles();
  for (const x of flow.stationExtras()) {
    for (const node of x.station.nodes) if (node.gateFiles && !out[node.id]) out[node.id] = node.gateFiles;
  }
  if (root && flow.isPilotGateEnabled(root)) {
    const pilotFile = pilotGateFile(root);
    out[flow.PilotGateID] = pilotFile ? [pilotFile] : [];
  }
  return out;
}

/** 可以经界面按钮记确认的关卡。试听确认（approval.json）与节拍确认（grid.json）由编排与 onset 写，不在这里。 */
export function gateIDs(root?: string): string[] {
  return Object.keys(gateFilesFor(root));
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

export function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 目录里最新的文件修改时间（不进子目录以外的深处：只看两层），没有文件为 0。 */
export function dirMtime(dir: string, depth = 2): number {
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
export function countFiles(dir: string, depth = 2): number {
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
      out[id] = {
        at: v.at,
        files: v.files as Record<string, string>,
        ...(typeof v.said === 'string' && v.said !== '' ? { said: v.said } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** 记下用户确认了某个关卡：绑定的文件一个都没有时拒绝（没东西可确认）。 */
export function recordGate(root: string, id: string, now = new Date(), said = ''): GateRecord {
  const bound = gateFilesFor(root)[id];
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
  if (Object.keys(files).length === 0) {
    throw new Error(
      id === flow.PilotGateID ? '打样镜头尚未渲染出片，要确认的内容还没写出来' : '要确认的内容还没写出来',
    );
  }
  const gates = readGates(root);
  const record: GateRecord = { at: localRFC3339(now), files, ...(said !== '' ? { said } : {}) };
  gates[id] = record;
  const sorted: Record<string, GateRecord> = {};
  for (const key of Object.keys(gates).sort()) sorted[key] = gates[key];
  atomicWrite(path.join(root, gatesPath), marshalIndent({ version: 1, gates: sorted }) + '\n', 0o644);
  return record;
}

/** 比对用：去掉空白与常见标点，「确认，开始渲染」与「确认 开始渲染。」算同一句。 */
export function bareWords(text: string): string {
  return text.replace(/[\s，。、！？；：,.!?;:「」“”"'《》()（）【】\[\]…—-]+/gu, '');
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

export function gateChanged(root: string, record: GateRecord, gateId?: string): boolean {
  if (gateId === flow.PilotGateID) {
    const currentFile = pilotGateFile(root);
    if (!currentFile) return true;
    const keys = Object.keys(record.files);
    if (keys.length !== 1 || keys[0] !== currentFile) return true;
    return gateFileChanged(root, currentFile, record.files[currentFile]);
  }
  return Object.entries(record.files).some(([rel, state]) => gateFileChanged(root, rel, state));
}

/** approval.json 记的候选摘要与现在的 candidate.mp4 相同。 */
export function candidateIsApproved(root: string, approvalFile: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(approvalFile, 'utf8')) as Record<string, unknown>;
    const candidate = raw.candidate as Record<string, unknown> | undefined;
    const want = typeof candidate?.sha256 === 'string' ? candidate.sha256.replace(/^sha256:/, '').toLowerCase() : '';
    return want !== '' && projectVideoDigest(root, candidateFilm) === want;
  } catch {
    return false;
  }
}

/**
 * 批量渲染（scene_run_all）的打样闸门校验：
 * - 未开启 pilot_gate 时直接放行（100% 向后兼容）；
 * - 开启 pilot_gate 且本次仅派发代表镜本身时放行；
 * - 否则必须先完成 gate-pilot 确认且当前代表镜及其输出文件未改动，才解锁全量渲染。
 */
export function assertPilotGateUnlocked(root: string, batchSceneIds: readonly string[]): void {
  if (!root || !flow.isPilotGateEnabled(root)) return;
  const pilotId = resolvePilotScene(root).id || 'scene-001';
  if (batchSceneIds.length === 1 && batchSceneIds[0] === pilotId) return;
  const record = readGates(root)[flow.PilotGateID];
  if (!record) {
    throw new Error(
      `项目已开启单镜打样闸门（${flow.PilotGateID}）：请先仅渲染代表镜头 ${pilotId} 供用户审看，待用户通过 studio_confirm({"gate":"${flow.PilotGateID}","said":"<用户原话>"}) 确认方向后再解锁全量 scene_run_all 渲染`,
    );
  }
  if (gateChanged(root, record, flow.PilotGateID)) {
    throw new Error(
      `打样镜头 ${pilotId} 在确认后发生变化，请重新请用户审看并通过 studio_confirm({"gate":"${flow.PilotGateID}","said":"<用户原话>"}) 确认后再全量渲染`,
    );
  }
}
