import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import {
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
import { readPublishTemplate } from './publish_template';
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

function localAssetDigest(projectRoot: string, entry: SeriesAssetEntry): string {
  const abs = path.join(projectRoot, entry.target_path);
  if (!fs.existsSync(abs)) return '';
  if (entry.kind === 'directions' || entry.kind === 'publish_template') return fileDigest(abs);
  try {
    return inspectTree(abs).digest;
  } catch {
    return '';
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
    const localDigest = localAssetDigest(projectRoot, entry);
    const syncedDigest = binding.synced_assets[entry.key]?.series_digest ?? '';
    let status: SyncState;
    if (localDigest === '') status = 'missing';
    else if (localDigest === entry.digest) status = 'synced';
    else if (syncedDigest === '') status = 'conflict';
    else if (localDigest === syncedDigest) status = 'update_available';
    else if (entry.digest === syncedDigest) status = 'local_modified';
    else status = 'conflict';
    return { ...entry, status, local_digest: localDigest, synced_digest: syncedDigest };
  });
}

/** 将专栏的一条指定资产拉取到当前项目；本地已改动且未传 replace 时抛冲突错误。 */
export function syncAssetToProject(
  rootDir: string,
  projectRoot: string,
  opts: { kind: AssetKind; name?: string; replace?: boolean },
): SyncAssetResult {
  const binding = readBinding(projectRoot);
  if (!binding) throw new Error('当前项目没有归属任何专栏');
  const name = opts.kind === 'directions' || opts.kind === 'publish_template' ? 'default' : (opts.name ?? '');
  const key = assetKey(opts.kind, name);
  const statuses = diffSeriesAssets(rootDir, projectRoot);
  const item = statuses.find((x) => x.key === key);
  if (!item) throw new Error(`专栏里找不到资产：${key}`);

  if (item.status === 'synced') {
    binding.synced_assets[key] = {
      kind: item.kind,
      name: item.name,
      target_path: item.target_path,
      series_digest: item.digest,
      synced_at: new Date().toISOString(),
    };
    writeBinding(projectRoot, binding);
    return { key, kind: item.kind, name: item.name, target_path: item.target_path, digest: item.digest, unchanged: true };
  }

  if ((item.status === 'local_modified' || item.status === 'conflict') && !opts.replace) {
    throw new Error(`项目里的 ${item.target_path} 本地有改动，确认用专栏版本覆盖请传 replace: true`);
  }

  const dest = path.join(projectRoot, item.target_path);
  if (isDirAssetKind(item.kind)) {
    const src = seriesAssetDir(rootDir, binding.series_id, item.kind, item.name);
    copyTreeAtomic(src, dest, false);
  } else if (item.kind === 'directions') {
    const text = readDirections(rootDir, binding.series_id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    atomicWrite(dest, text, 0o644);
  } else if (item.kind === 'publish_template') {
    const tpl = readPublishTemplate(rootDir, binding.series_id);
    if (!tpl) throw new Error('专栏里没有发布模板');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    atomicWrite(dest, marshalIndent(tpl) + '\n', 0o644);
  }

  binding.synced_assets[key] = {
    kind: item.kind,
    name: item.name,
    target_path: item.target_path,
    series_digest: item.digest,
    synced_at: new Date().toISOString(),
  };
  writeBinding(projectRoot, binding);
  return { key, kind: item.kind, name: item.name, target_path: item.target_path, digest: item.digest, unchanged: false };
}

/**
 * 新建专栏期数时，把专栏的全部复用资产一次性快照拷入新项目（不覆盖已有文件），并记进 onset.series.json。
 */
export function materializeSeriesIntoProject(rootDir: string, projectRoot: string): SyncAssetResult[] {
  const statuses = diffSeriesAssets(rootDir, projectRoot);
  const applied: SyncAssetResult[] = [];
  for (const item of statuses) {
    if (item.status !== 'missing') continue;
    applied.push(syncAssetToProject(rootDir, projectRoot, { kind: item.kind, name: item.name }));
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
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
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
