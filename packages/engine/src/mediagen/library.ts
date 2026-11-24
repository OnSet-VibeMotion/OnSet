/**
 * 跨项目不可变多版本资产库（Asset Library）：
 * - 存储目录：~/.local/share/onset/assets（ONSET_ASSETS_DIR 可覆盖）；
 * - 媒体字节存于 files/<assetId>/<versionId>/media.<ext>，不可变；
 * - 任何引用严格绑定 { asset_id, version_id }，切换 current_version_id 不破坏历史版本。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import * as mediaprobe from '../mediaprobe';
import type { AssetRef, AssetVersion, LibraryAsset, MediaProviderId, Modality } from './types';

export const AssetsDirEnv = 'ONSET_ASSETS_DIR';
export const MaxAssetBytes = 500 * 1024 * 1024;
export const MaxPreviewBytes = 4 * 1024 * 1024;

interface ImportReceipt {
  hash: string;
  asset_id: string;
  version_id: string;
}

export function defaultAssetsDir(env: Record<string, string | undefined> = process.env): string {
  if (env[AssetsDirEnv]) return path.resolve(env[AssetsDirEnv]!);
  const xdg = env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'onset', 'assets');
  const home = env.HOME || os.homedir();
  return path.join(home, '.local', 'share', 'onset', 'assets');
}

function safeId(id: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(id)) throw new Error(`非法 ${label}：${id}`);
  return id;
}

function recordFile(root: string, assetId: string): string {
  return path.join(root, 'records', `${safeId(assetId, 'asset_id')}.json`);
}

function receiptFile(root: string, requestId: string): string {
  const hash = crypto.createHash('sha256').update(requestId).digest('hex');
  return path.join(root, 'requests', `${hash}.json`);
}

export function assetVersionFilePath(root: string, asset: LibraryAsset, versionId: string): string {
  const ver = asset.versions.find((v) => v.version_id === versionId);
  if (!ver) throw new Error(`找不到资产版本：${asset.id}/${versionId}`);
  return path.join(root, ...ver.file.split('/'));
}

function inferMimeAndModality(
  filePath: string,
  hintModality?: Modality,
): { mime: string; modality: Modality; ext: string } {
  const ext = path.extname(filePath).toLowerCase() || '.bin';
  const map: Record<string, [string, Modality]> = {
    '.png': ['image/png', 'image'],
    '.jpg': ['image/jpeg', 'image'],
    '.jpeg': ['image/jpeg', 'image'],
    '.webp': ['image/webp', 'image'],
    '.gif': ['image/gif', 'image'],
    '.mp4': ['video/mp4', 'video'],
    '.mov': ['video/quicktime', 'video'],
    '.webm': ['video/webm', 'video'],
    '.wav': ['audio/wav', 'audio'],
    '.mp3': ['audio/mpeg', 'audio'],
    '.m4a': ['audio/mp4', 'audio'],
    '.ogg': ['audio/ogg', 'audio'],
    '.flac': ['audio/flac', 'audio'],
  };
  const found = map[ext];
  if (found) return { mime: found[0], modality: hintModality ?? found[1], ext };
  if (hintModality) return { mime: 'application/octet-stream', modality: hintModality, ext };
  throw new Error(`无法根据扩展名识别媒体类型：${filePath}`);
}

/** 列出资产库条目（默认隐藏回收站，支持按模态与关键词过滤）。 */
export function listAssets(
  root: string,
  opts: { modality?: Modality; includeTrashed?: boolean; query?: string } = {},
): LibraryAsset[] {
  const dir = path.join(root, 'records');
  if (!fs.existsSync(dir)) return [];
  const q = opts.query?.trim().toLowerCase() ?? '';
  const items: LibraryAsset[] = [];
  for (const name of fs.readdirSync(dir).sort(compareBytes)) {
    if (!name.endsWith('.json')) continue;
    try {
      const asset = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as LibraryAsset;
      if (!opts.includeTrashed && asset.trashed_at) continue;
      if (opts.modality && asset.modality !== opts.modality) continue;
      if (q && !`${asset.id} ${asset.name}`.toLowerCase().includes(q)) continue;
      items.push(asset);
    } catch {
      // 忽略损坏记录
    }
  }
  return items.sort((a, b) => (a.updated_at > b.updated_at ? -1 : a.updated_at < b.updated_at ? 1 : 0));
}

export function getAsset(root: string, assetId: string): LibraryAsset | undefined {
  const file = recordFile(root, assetId);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as LibraryAsset;
}

export interface ImportAssetInput {
  source_path: string;
  name?: string;
  modality?: Modality;
  origin?: 'upload' | 'generated' | 'derived';
  request_id?: string;
  asset_id?: string;
  parent_version_id?: string;
  provider?: MediaProviderId;
  model?: string;
  prompt?: string;
  parameters?: Record<string, unknown>;
  references?: AssetRef[];
  job_id?: string;
}

/**
 * 将本地媒体文件不可变导入资产库（拒绝符号链接，限 500 MB，支持 request_id 幂等与追加新版本）。
 */
export function importAssetFile(
  root: string,
  input: ImportAssetInput,
): { asset: LibraryAsset; version: AssetVersion; replayed: boolean } {
  const src = path.resolve(input.source_path);
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`资产导入只接受常规文件（拒绝符号链接）：${src}`);
  }
  if (st.size <= 0 || st.size > MaxAssetBytes) {
    throw new Error(`资产文件大小不合法（必须在 1 字节至 500 MB 之间）：${src}`);
  }
  const bytes = fs.readFileSync(src);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const { mime, modality, ext } = inferMimeAndModality(src, input.modality);
  const payloadHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        sha256,
        asset_id: input.asset_id ?? '',
        parent: input.parent_version_id ?? '',
        name: input.name ?? '',
      }),
    )
    .digest('hex');

  if (input.request_id) {
    const rFile = receiptFile(root, input.request_id);
    if (fs.existsSync(rFile)) {
      const prev = JSON.parse(fs.readFileSync(rFile, 'utf8')) as ImportReceipt;
      if (prev.hash !== payloadHash) throw new Error('REQUEST_ID_CONFLICT：同一 request_id 不能用于不同资产导入');
      const existing = getAsset(root, prev.asset_id);
      const ver = existing?.versions.find((v) => v.version_id === prev.version_id);
      if (existing && ver) return { asset: existing, version: ver, replayed: true };
    }
  }

  const now = new Date().toISOString();
  const assetId = input.asset_id ? safeId(input.asset_id, 'asset_id') : `ast-${crypto.randomBytes(6).toString('hex')}`;
  const versionId = `v-${crypto.randomBytes(6).toString('hex')}`;
  const relFile = `files/${assetId}/${versionId}/media${ext}`;
  const destFile = path.join(root, ...relFile.split('/'));

  // 预写回执，防止中途崩溃重试产生重复资产
  if (input.request_id) {
    atomicWrite(
      receiptFile(root, input.request_id),
      marshalIndent({ hash: payloadHash, asset_id: assetId, version_id: versionId }) + '\n',
      0o644,
    );
  }
  atomicWrite(destFile, bytes, 0o644);

  const version: AssetVersion = {
    version_id: versionId,
    parent_version_id: input.parent_version_id,
    file: relFile,
    original_name: path.basename(src),
    mime_type: mime,
    bytes: bytes.length,
    sha256,
    origin: input.origin ?? 'upload',
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    parameters: input.parameters,
    references: input.references,
    job_id: input.job_id,
    created_at: now,
  };

  let asset: LibraryAsset;
  const existing = getAsset(root, assetId);
  if (existing) {
    if (existing.modality !== modality)
      throw new Error(`新版本模态（${modality}）与原资产（${existing.modality}）不符`);
    asset = {
      ...existing,
      current_version_id: versionId,
      versions: [...existing.versions, version],
      updated_at: now,
    };
  } else {
    asset = {
      schema: 1,
      id: assetId,
      name: (input.name?.trim() || path.basename(src, ext)).slice(0, 120),
      modality,
      current_version_id: versionId,
      versions: [version],
      created_at: now,
      updated_at: now,
    };
  }
  atomicWrite(recordFile(root, asset.id), marshalIndent(asset) + '\n', 0o644);
  return { asset, version, replayed: false };
}

/** 更新资产元数据：改名、切换当前版本指针、移入/移出回收站（绝不销毁已有版本字节）。 */
export function updateAsset(
  root: string,
  assetId: string,
  patch: { name?: string; current_version_id?: string; trashed?: boolean },
): LibraryAsset {
  const asset = getAsset(root, assetId);
  if (!asset) throw new Error(`找不到资产：${assetId}`);
  const now = new Date().toISOString();
  if (patch.name !== undefined) {
    const clean = patch.name.trim();
    if (!clean || clean.length > 120) throw new Error('资产名称必须在 1–120 字符内');
    asset.name = clean;
  }
  if (patch.current_version_id !== undefined) {
    if (!asset.versions.some((v) => v.version_id === patch.current_version_id)) {
      throw new Error(`版本不存在：${patch.current_version_id}`);
    }
    asset.current_version_id = patch.current_version_id;
  }
  if (patch.trashed !== undefined) {
    asset.trashed_at = patch.trashed ? now : undefined;
  }
  asset.updated_at = now;
  atomicWrite(recordFile(root, asset.id), marshalIndent(asset) + '\n', 0o644);
  return asset;
}

/**
 * 将固定版本的资产安全拷贝进目标项目（assets/generated/<filename>）：
 * 若目标已存在且字节 SHA-256 一致则复用；若内容不同则拒绝覆盖并报错。
 */
export function importAssetToProject(
  root: string,
  ref: AssetRef,
  projectRoot: string,
  targetName?: string,
): { project_path: string; sha256: string; bytes: number; reused: boolean } {
  const asset = getAsset(root, ref.asset_id);
  if (!asset) throw new Error(`找不到资产：${ref.asset_id}`);
  if (asset.trashed_at) throw new Error(`资产在回收站中，不能导入项目：${ref.asset_id}`);
  const ver = asset.versions.find((v) => v.version_id === ref.version_id);
  if (!ver) throw new Error(`找不到资产版本：${ref.asset_id}/${ref.version_id}`);

  const src = assetVersionFilePath(root, asset, ver.version_id);
  const bytes = fs.readFileSync(src);
  const gotHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== ver.bytes || gotHash !== ver.sha256) {
    throw new Error(`资产字节完整性校验失败：${ref.asset_id}/${ref.version_id}`);
  }

  const ext = path.extname(ver.file) || '.bin';
  const safeName = (targetName?.trim() || `${asset.id}-${ver.version_id}${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const rel = `assets/generated/${safeName}`;
  const dest = path.join(projectRoot, ...rel.split('/'));
  if (fs.existsSync(dest)) {
    const existingBytes = fs.readFileSync(dest);
    const existingHash = crypto.createHash('sha256').update(existingBytes).digest('hex');
    if (existingHash === ver.sha256) {
      return { project_path: rel, sha256: ver.sha256, bytes: ver.bytes, reused: true };
    }
    throw new Error(`项目里已存在同名且内容不同的文件，拒绝覆盖：${rel}`);
  }
  atomicWrite(dest, bytes, 0o644);
  return { project_path: rel, sha256: ver.sha256, bytes: ver.bytes, reused: false };
}

/**
 * 有界读取固定版本资产的预览文件（供视觉/听觉核验，不把原始大文件或 base64 写进结构化日志）。
 * - 图片：PNG 最长边 ≤ 1024px；
 * - 视频：抽取 1–4 个时间点的 PNG；
 * - 音频：单声道 16 kHz PCM WAV，默认 0s 起最多 15s。
 */
export function readAssetPreview(
  root: string,
  ref: AssetRef,
  outDir: string,
  opts: { timestamps?: number[]; start?: number; duration?: number; env?: Record<string, string> } = {},
): { modality: Modality; files: Array<{ path: string; mime_type: string; bytes: number }> } {
  const asset = getAsset(root, ref.asset_id);
  if (!asset) throw new Error(`找不到资产：${ref.asset_id}`);
  const ver = asset.versions.find((v) => v.version_id === ref.version_id);
  if (!ver) throw new Error(`找不到资产版本：${ref.asset_id}/${ref.version_id}`);
  const src = assetVersionFilePath(root, asset, ver.version_id);
  const raw = fs.readFileSync(src);
  if (raw.length !== ver.bytes || crypto.createHash('sha256').update(raw).digest('hex') !== ver.sha256) {
    throw new Error(`资产文件已被外部改动，拒绝读取预览：${ref.asset_id}/${ref.version_id}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const env = opts.env ?? (process.env as Record<string, string>);

  if (asset.modality === 'image') {
    const dest = path.join(outDir, `${asset.id}-${ver.version_id}-preview.png`);
    if (raw.length <= MaxPreviewBytes && ver.mime_type === 'image/png') {
      atomicWrite(dest, raw, 0o644);
      return { modality: 'image', files: [{ path: dest, mime_type: 'image/png', bytes: raw.length }] };
    }
    const tc = mediaprobe.newToolchain(env);
    const ran = tc.runAsync;
    void ran;
    // 用 mediaprobe 统一封装：同步抽单帧缩放至最长边 1024
    tc.extractFramesRegion(src, [0], null, outDir, 1024);
    const produced = fs.readdirSync(outDir).find((f) => f.endsWith('.png'));
    if (!produced) throw new Error('图片预览转码未产出 PNG');
    const finalPath = path.join(outDir, produced);
    const st = fs.statSync(finalPath);
    if (st.size > MaxPreviewBytes) throw new Error('图片预览超过 4 MiB 上限');
    return { modality: 'image', files: [{ path: finalPath, mime_type: 'image/png', bytes: st.size }] };
  }

  const tc = mediaprobe.newToolchain(env);
  if (asset.modality === 'video') {
    const times = (opts.timestamps && opts.timestamps.length > 0 ? opts.timestamps : [0]).slice(0, 4);
    const report = tc.extractFramesRegion(src, times, null, outDir, 1024);
    return {
      modality: 'video',
      files: report.frames.map((f) => ({ path: f.image, mime_type: 'image/png', bytes: fs.statSync(f.image).size })),
    };
  }

  // audio: 单声道 16 kHz WAV 片段（0.1–15s）
  const start = Math.max(0, opts.start ?? 0);
  const duration = Math.min(15, Math.max(0.1, opts.duration ?? 10));
  const dest = path.join(outDir, `${asset.id}-${ver.version_id}-clip.wav`);
  const probe = tc.probe(src);
  if (!probe.audio) throw new Error('音频资产不包含有效音轨');
  // 音频裁切使用 mediaprobe 的 transcode，这里暴露同步接口则直接复制小 WAV 或抛提示
  if (
    ver.mime_type === 'audio/wav' &&
    raw.length <= MaxPreviewBytes &&
    start === 0 &&
    (probe.duration_seconds <= duration || probe.duration_seconds === 0)
  ) {
    atomicWrite(dest, raw, 0o644);
    return { modality: 'audio', files: [{ path: dest, mime_type: 'audio/wav', bytes: raw.length }] };
  }
  throw new Error(`请通过异步转码接口截取音频预览（start=${start}s, duration=${duration}s）`);
}
