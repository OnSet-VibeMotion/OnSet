import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import {
  assertSafeTargetPath,
  assetKey,
  copyTreeAtomic,
  fileDigest,
  inspectTree,
  isDirAssetKind,
  listSeriesAssets,
  type SeriesAssetEntry,
  seriesAssetDir,
} from './assets';
import { readBinding, writeBinding } from './binding';
import { readDirections } from './brief';
import { publishTemplateDigest, readPublishTemplate, type SeriesPublishTemplate } from './publish_template';
import type { AssetKind } from './types';

export type SyncState = 'missing' | 'synced' | 'update_available' | 'local_modified' | 'conflict';

export interface AssetSyncStatus extends SeriesAssetEntry {
  status: SyncState;
  local_digest: string;
  synced_digest: string;
}

export interface SyncAssetResult {
  key: string;
  kind: AssetKind;
  name: string;
  target_path: string;
  digest: string;
  unchanged: boolean;
}

function inspectLocalAsset(
  projectRoot: string,
  entry: SeriesAssetEntry,
): { state: 'missing' } | { state: 'ok'; digest: string } | { state: 'unreadable' } {
  let abs: string;
  try {
    abs = assertSafeTargetPath(projectRoot, entry.target_path);
  } catch {
    return { state: 'unreadable' };
  }
  const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!stat) return { state: 'missing' };
  if (stat.isSymbolicLink()) return { state: 'unreadable' };

  if (entry.kind === 'directions') {
    if (!stat.isFile()) return { state: 'unreadable' };
    try {
      return { state: 'ok', digest: fileDigest(abs) };
    } catch {
      return { state: 'unreadable' };
    }
  }
  if (entry.kind === 'publish_template') {
    if (!stat.isFile()) return { state: 'unreadable' };
    try {
      const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as SeriesPublishTemplate;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema !== 1) {
        return { state: 'unreadable' };
      }
      return { state: 'ok', digest: publishTemplateDigest(parsed) };
    } catch {
      return { state: 'unreadable' };
    }
  }
  if (!stat.isDirectory()) return { state: 'unreadable' };
  try {
    return { state: 'ok', digest: inspectTree(abs).digest };
  } catch {
    return { state: 'unreadable' };
  }
}

/** 三方摘要比对（上次同步摘要 vs 专栏当前摘要 vs 本地当前摘要），不改任何文件。 */
export function diffSeriesAssets(rootDir: string, projectRoot: string): AssetSyncStatus[] {
  const binding = readBinding(projectRoot);
  if (!binding) return [];
  let assets: SeriesAssetEntry[];
  try {
    assets = listSeriesAssets(rootDir, binding.series_id);
  } catch {
    return [];
  }
  return assets.map((entry) => {
    const local = inspectLocalAsset(projectRoot, entry);
    const syncedDigest = binding.synced_assets[entry.key]?.series_digest ?? '';
    let status: SyncState;
    let localDigest = '';
    if (local.state === 'missing') {
      status = 'missing';
    } else if (local.state === 'unreadable') {
      // 目标含符号链接、类型不符或无法读取时绝不当作 missing 静默覆盖，标为 conflict 要求人工介入。
      status = 'conflict';
    } else {
      localDigest = local.digest;
      if (localDigest === entry.digest) status = 'synced';
      else if (syncedDigest === '') status = 'conflict';
      else if (localDigest === syncedDigest) status = 'update_available';
      else if (entry.digest === syncedDigest) status = 'local_modified';
      else status = 'conflict';
    }
    return { ...entry, status, local_digest: localDigest, synced_digest: syncedDigest };
  });
}

function applySingleSyncItem(
  rootDir: string,
  seriesId: string,
  projectRoot: string,
  item: AssetSyncStatus,
  replace: boolean,
): SyncAssetResult {
  const dest = assertSafeTargetPath(projectRoot, item.target_path);

  if (item.status === 'synced') {
    const syncedDigest = item.local_digest || item.digest;
    mergeSyncedRecord(projectRoot, seriesId, item, syncedDigest);
    return {
      key: item.key,
      kind: item.kind,
      name: item.name,
      target_path: item.target_path,
      digest: syncedDigest,
      unchanged: true,
    };
  }

  if ((item.status === 'local_modified' || item.status === 'conflict') && !replace) {
    throw new Error(`项目里的 ${item.target_path} 本地有改动或存在异常，确认用专栏版本覆盖请传 replace: true`);
  }

  if (isDirAssetKind(item.kind)) {
    const src = seriesAssetDir(rootDir, seriesId, item.kind, item.name);
    copyTreeAtomic(src, dest, false);
  } else if (item.kind === 'directions') {
    const text = readDirections(rootDir, seriesId);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    atomicWrite(dest, text, 0o644);
  } else if (item.kind === 'publish_template') {
    const tpl = readPublishTemplate(rootDir, seriesId);
    if (!tpl) throw new Error('专栏里没有发布模板');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    atomicWrite(dest, marshalIndent(tpl) + '\n', 0o644);
  }

  // 记录实际写入目标文件的摘要，避免并发更新专栏资产时 series_digest 与实际落盘字节失配。
  const written = inspectLocalAsset(projectRoot, item);
  const writtenDigest = written.state === 'ok' ? written.digest : item.digest;
  mergeSyncedRecord(projectRoot, seriesId, item, writtenDigest);
  return {
    key: item.key,
    kind: item.kind,
    name: item.name,
    target_path: item.target_path,
    digest: writtenDigest,
    unchanged: false,
  };
}

/** 写入前重新读取最新 onset.series.json 再合并单条记录，降低并发同步丢写的风险。 */
function mergeSyncedRecord(projectRoot: string, seriesId: string, item: AssetSyncStatus, digest: string): void {
  const latest = readBinding(projectRoot);
  if (!latest || latest.series_id !== seriesId) return;
  latest.synced_assets[item.key] = {
    kind: item.kind,
    name: item.name,
    target_path: item.target_path,
    series_digest: digest,
    synced_at: new Date().toISOString(),
  };
  writeBinding(projectRoot, latest);
}

/** 将专栏的一条指定资产拉取到当前项目；本地已改动或异常且未传 replace 时抛冲突错误。 */
export function syncAssetToProject(
  rootDir: string,
  projectRoot: string,
  opts: { kind: AssetKind; name?: string; replace?: boolean },
): SyncAssetResult {
  const binding = readBinding(projectRoot);
  if (!binding) throw new Error('当前项目没有归属任何专栏');
  const name = opts.kind === 'directions' || opts.kind === 'publish_template' ? 'default' : (opts.name ?? '');
  const key = assetKey(opts.kind, name);
  const item = diffSeriesAssets(rootDir, projectRoot).find((x) => x.key === key);
  if (!item) throw new Error(`专栏里找不到资产：${key}`);
  return applySingleSyncItem(rootDir, binding.series_id, projectRoot, item, !!opts.replace);
}

/**
 * 新建专栏期数时，把专栏的全部复用资产一次性快照拷入新项目（仅枚举一次，不覆盖已有文件），并记进 onset.series.json。
 */
export function materializeSeriesIntoProject(rootDir: string, projectRoot: string): SyncAssetResult[] {
  const binding = readBinding(projectRoot);
  if (!binding) return [];
  const statuses = diffSeriesAssets(rootDir, projectRoot);
  const applied: SyncAssetResult[] = [];
  for (const item of statuses) {
    if (item.status !== 'missing') continue;
    applied.push(applySingleSyncItem(rootDir, binding.series_id, projectRoot, item, false));
  }
  return applied;
}

/** 扫描当前项目里适合沉淀回专栏的候选资产（共用组件、角色目录、片头片尾、音频、封面）。 */
export interface ProjectAssetCandidate {
  kind: 'shared' | 'cast' | 'bumper' | 'audio' | 'cover';
  name: string;
  from: string;
}

export function listProjectAssetCandidates(projectRoot: string): ProjectAssetCandidate[] {
  const out: ProjectAssetCandidate[] = [];
  const scanDir = (kind: ProjectAssetCandidate['kind'], relRoot: string) => {
    const abs = path.join(projectRoot, relRoot);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => compareBytes(a.name, b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(entry.name)) continue;
      out.push({ kind, name: entry.name, from: `${relRoot}/${entry.name}` });
    }
  };
  scanDir('shared', 'production/shared');
  scanDir('cast', 'cast');
  scanDir('bumper', 'assets/series/bumpers');
  scanDir('audio', 'assets/series/audio');
  scanDir('cover', 'assets/series/covers');
  return out;
}
