import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { advanceNextEpisode, getSeries } from './store';
import {
  type AssetKind,
  BindingFile,
  type ProjectSeriesBinding,
  type SeriesConfig,
  type SyncedAssetRecord,
  ValidAssetKinds,
  validateSeriesId,
} from './types';

function parseSyncedAssets(raw: unknown): Record<string, SyncedAssetRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, SyncedAssetRecord> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const r = val as Record<string, unknown>;
    if (
      typeof r.kind === 'string' &&
      ValidAssetKinds.has(r.kind as AssetKind) &&
      typeof r.name === 'string' &&
      typeof r.target_path === 'string' &&
      typeof r.series_digest === 'string'
    ) {
      out[key] = {
        kind: r.kind as AssetKind,
        name: r.name,
        target_path: r.target_path,
        series_digest: r.series_digest,
        synced_at: typeof r.synced_at === 'string' ? r.synced_at : '',
      };
    }
  }
  return out;
}

/** 读取单期项目里的 onset.series.json；独立项目返回 null。 */
export function readBinding(projectRoot: string): ProjectSeriesBinding | null {
  if (!projectRoot) return null;
  const file = path.join(projectRoot, BindingFile);
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const raw = JSON.parse(body) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${BindingFile} 格式无效`);
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.series_id !== 'string' || r.series_id === '') {
    throw new Error(`${BindingFile} 缺少有效的 version 或 series_id`);
  }
  const id = validateSeriesId(r.series_id);
  const episode =
    typeof r.episode === 'number' && Number.isInteger(r.episode) && r.episode >= 1 ? r.episode : undefined;
  return {
    version: 1,
    series_id: id,
    series_name: typeof r.series_name === 'string' && r.series_name !== '' ? r.series_name : id,
    episode,
    bound_at: typeof r.bound_at === 'string' ? r.bound_at : '',
    synced_assets: parseSyncedAssets(r.synced_assets),
  };
}

/** 原子写入项目侧的 onset.series.json。 */
export function writeBinding(projectRoot: string, binding: ProjectSeriesBinding): void {
  const file = path.join(projectRoot, BindingFile);
  atomicWrite(file, marshalIndent(binding) + '\n', 0o644);
}

/**
 * 将一个已有或新建的项目绑定到指定专栏（原地写 onset.series.json，不移动项目文件夹）。
 * 若已绑定同一专栏且仅改期号，会保留已有 synced_assets。
 */
export function bindProject(
  seriesRoot: string,
  seriesId: string,
  projectRoot: string,
  opts: { episode?: number; advanceEpisode?: boolean } = {},
): ProjectSeriesBinding {
  const cfg = getSeries(seriesRoot, seriesId);
  if (!cfg) throw new Error(`找不到专栏：${seriesId}`);
  if (!fs.statSync(projectRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`项目目录不存在：${projectRoot}`);
  }
  if (opts.episode !== undefined && (!Number.isInteger(opts.episode) || opts.episode < 1)) {
    throw new Error('期号必须是正整数');
  }
  const prev = readBinding(projectRoot);
  const binding: ProjectSeriesBinding = {
    version: 1,
    series_id: cfg.id,
    series_name: cfg.name,
    episode: opts.episode,
    bound_at: new Date().toISOString(),
    synced_assets: prev && prev.series_id === cfg.id ? prev.synced_assets : {},
  };
  writeBinding(projectRoot, binding);
  if (opts.episode !== undefined && opts.advanceEpisode !== false) {
    advanceNextEpisode(seriesRoot, cfg.id, opts.episode);
  }
  return binding;
}

/** 解除项目与专栏的绑定（只删 onset.series.json，不删项目内任何其他文件）。 */
export function unbindProject(projectRoot: string): void {
  if (!projectRoot) return;
  fs.rmSync(path.join(projectRoot, BindingFile), { force: true });
}

/**
 * 新建期数时应用专栏默认配置到项目文件：
 * - 若专栏指定了默认音色（defaults.tts_voice），预写 production/production-config.json 的 ttsVoice
 *   （已有 ttsVoice 时不覆盖）。
 */
export function applySeriesDefaultsToProject(projectRoot: string, cfg: SeriesConfig): void {
  const voice = cfg.defaults.tts_voice;
  if (!voice) return;
  const prodDir = path.join(projectRoot, 'production');
  const configFile = path.join(prodDir, 'production-config.json');
  let data: Record<string, unknown> = {};
  if (fs.existsSync(configFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      return;
    }
  }
  if (typeof data.ttsVoice === 'string' && data.ttsVoice !== '') return;
  fs.mkdirSync(prodDir, { recursive: true });
  data.ttsVoice = voice;
  atomicWrite(configFile, marshalIndent(data) + '\n', 0o644);
}
