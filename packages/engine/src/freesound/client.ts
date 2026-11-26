/**
 * 纯 TypeScript Freesound API v2 音效检索、下载、去重与音频清单（audio-manifest.json）管理。
 *
 * 安全边界：
 * - API Key 仅从环境变量 FREESOUND_API_KEY（或显式 opts.apiKey）读取，严禁写入项目 .env，
 *   亦不放宽 config.childEnvironment 默认白名单；
 * - 支持通过 opts.fetch 注入离线 mock，零 Python 或第三方网络库依赖；
 * - 下载落盘严格防路径穿越、限体积、按 SHA-256 去重，并完整记录来源 URL、作者与许可证归属。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { analyzeAudioFile } from './gain';
import {
  AllowedAudioExts,
  assertSafeSfxDir,
  audioManifestPath,
  detectExtFromContent,
  isSafeSfxFileInside,
  readAudioManifest,
  safeSlug,
  writeAudioManifest,
} from './manifest';
import {
  type AudioManifestEntry,
  DefaultMaxSfxBytes,
  DefaultSearchLimit,
  type FetchLike,
  FreesoundApiBaseUrl,
  FreesoundApiKeyEnv,
  FreesoundApiKeyError,
  type FreesoundClientOptions,
  type FreesoundDownloadOptions,
  type FreesoundDownloadQuality,
  type FreesoundDownloadResult,
  type FreesoundSearchOptions,
  type FreesoundSearchResult,
  type FreesoundSoundItem,
  MaxSearchLimit,
  SfxAssetsRelDir,
} from './types';

const SearchFields =
  'id,name,tags,description,duration,username,license,url,previews,download,type,filesize,samplerate,channels,avg_rating,num_downloads';

/** 解析 FREESOUND_API_KEY；缺失时抛出含清晰配置说明的 FreesoundApiKeyError。 */
export function resolveApiKey(opts: FreesoundClientOptions = {}): string {
  const fromOpt = opts.apiKey?.trim();
  if (fromOpt) return fromOpt;
  const fromEnv = (opts.env ? opts.env[FreesoundApiKeyEnv] : process.env[FreesoundApiKeyEnv])?.trim();
  if (fromEnv) return fromEnv;
  throw new FreesoundApiKeyError(
    `缺少环境变量 ${FreesoundApiKeyEnv}：无法调用 Freesound API v2。` +
      `请前往 https://freesound.org/apiv2/apply/ 申请 Token，并在当前运行环境中设置 ${FreesoundApiKeyEnv}` +
      `（安全模式下可通过 ONSET_PASSTHROUGH_ENV=${FreesoundApiKeyEnv} 显式透传；切勿将该密钥写入项目 .env 文件）。`,
  );
}

/** 将 Freesound 许可证 URL 或文本规整为简短标签（CC0 / CC-BY / CC-BY-NC 等）。 */
export function normalizeLicenseShort(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('zero/1.0') || lower.includes('creative commons 0') || lower === 'cc0') return 'CC0';
  if (lower.includes('by-nc') || lower.includes('attribution noncommercial') || lower === 'cc-by-nc') return 'CC-BY-NC';
  if (lower.includes('/by/') || lower.includes('attribution') || lower === 'cc-by') return 'CC-BY';
  if (lower.includes('sampling+')) return 'Sampling+';
  return raw.trim() || 'Unknown';
}

function mapSingleLicenseToken(token: string): string | null {
  const norm = token.trim().toLowerCase();
  if (!norm || norm === 'any' || norm === 'all') return null;
  if (norm === 'cc0' || norm === 'cc-0' || norm === 'creative commons 0') return 'license:"Creative Commons 0"';
  if (norm === 'cc-by' || norm === 'ccby' || norm === 'attribution') return 'license:"Attribution"';
  if (norm === 'cc-by-nc' || norm === 'ccbync' || norm === 'attribution noncommercial') {
    return 'license:"Attribution Noncommercial"';
  }
  if (norm === 'sampling+' || norm === 'sampling') return 'license:"Sampling+"';
  const safe = token.trim().replace(/"/g, '');
  return safe ? `license:"${safe}"` : null;
}

/** 根据关键词搜索选项构造 Freesound Solr filter 查询表达式。 */
export function buildSearchFilter(
  opts: Pick<FreesoundSearchOptions, 'minDuration' | 'maxDuration' | 'license'>,
): string {
  const clauses: string[] = [];

  const hasMin = opts.minDuration !== undefined && Number.isFinite(opts.minDuration) && opts.minDuration > 0;
  const hasMax = opts.maxDuration !== undefined && Number.isFinite(opts.maxDuration) && opts.maxDuration > 0;
  if (hasMin && hasMax && opts.minDuration! > opts.maxDuration!) {
    throw new Error(`无效时长范围：min_duration（${opts.minDuration}）大于 max_duration（${opts.maxDuration}）`);
  }
  if (hasMin || hasMax) {
    clauses.push(`duration:[${hasMin ? String(opts.minDuration) : '*'} TO ${hasMax ? String(opts.maxDuration) : '*'}]`);
  }

  if (opts.license !== undefined) {
    const rawList = Array.isArray(opts.license) ? opts.license : String(opts.license).split(',');
    const mapped = rawList.map(mapSingleLicenseToken).filter((v): v is string => v !== null);
    if (mapped.length === 1) clauses.push(mapped[0]);
    else if (mapped.length > 1) clauses.push(`(${mapped.join(' OR ')})`);
  }

  return clauses.join(' ');
}

interface RawFreesoundSound {
  id?: unknown;
  name?: unknown;
  duration?: unknown;
  username?: unknown;
  license?: unknown;
  url?: unknown;
  tags?: unknown;
  description?: unknown;
  type?: unknown;
  filesize?: unknown;
  samplerate?: unknown;
  channels?: unknown;
  avg_rating?: unknown;
  num_downloads?: unknown;
  download?: unknown;
  previews?: Record<string, unknown>;
}

function normalizeSound(raw: RawFreesoundSound): FreesoundSoundItem {
  const id = Number(raw.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Freesound 返回了无效的音效 ID：${String(raw.id)}`);
  const license = typeof raw.license === 'string' ? raw.license : '';
  const previews = raw.previews && typeof raw.previews === 'object' ? raw.previews : {};
  const strOrUndef = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const numOrZero = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : `sound-${id}`,
    duration: numOrZero(raw.duration),
    username: typeof raw.username === 'string' ? raw.username : 'unknown',
    license,
    license_short: normalizeLicenseShort(license),
    url: typeof raw.url === 'string' && raw.url ? raw.url : `https://freesound.org/s/${id}/`,
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)) : [],
    description: typeof raw.description === 'string' ? raw.description : '',
    type: typeof raw.type === 'string' ? raw.type : '',
    filesize: numOrZero(raw.filesize),
    samplerate: numOrZero(raw.samplerate),
    channels: numOrZero(raw.channels),
    avg_rating: numOrZero(raw.avg_rating),
    num_downloads: numOrZero(raw.num_downloads),
    preview_hq_mp3: strOrUndef(previews['preview-hq-mp3']),
    preview_hq_ogg: strOrUndef(previews['preview-hq-ogg']),
    preview_lq_mp3: strOrUndef(previews['preview-lq-mp3']),
    download_url: strOrUndef(raw.download),
  };
}

async function fetchJson(url: string, apiKey: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' },
    signal,
  });
  if (res.status === 401 || res.status === 403) {
    throw new FreesoundApiKeyError(
      `Freesound API 鉴权失败（HTTP ${res.status}）：请检查环境变量 ${FreesoundApiKeyEnv} 是否有效。`,
    );
  }
  if (res.status === 429) {
    throw new Error('Freesound API 触发速率限制（HTTP 429），请稍后重试。');
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Freesound API 请求失败（HTTP ${res.status}）：${snippet || res.statusText}`);
  }
  return res.json();
}

/** 按关键词、时长范围与许可证条件检索 Freesound API v2 音效。 */
export async function searchSounds(opts: FreesoundSearchOptions): Promise<FreesoundSearchResult> {
  const query = opts.query.trim();
  if (!query) throw new Error('检索关键词 query 不能为空');
  const apiKey = resolveApiKey(opts);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const baseUrl = (opts.baseUrl ?? FreesoundApiBaseUrl).replace(/\/+$/, '');
  const limit = Math.max(1, Math.min(MaxSearchLimit, Math.floor(opts.limit ?? DefaultSearchLimit)));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const filter = buildSearchFilter(opts);

  const params = new URLSearchParams({ query, fields: SearchFields, page_size: String(limit), page: String(page) });
  if (filter) params.set('filter', filter);
  if (opts.sort) params.set('sort', opts.sort);

  const raw = (await fetchJson(`${baseUrl}/search/text/?${params.toString()}`, apiKey, fetchImpl, opts.signal)) as {
    count?: unknown;
    results?: unknown;
  };
  const items = Array.isArray(raw?.results) ? raw.results.map((r) => normalizeSound(r as RawFreesoundSound)) : [];
  return {
    query,
    filter,
    count: typeof raw?.count === 'number' && Number.isFinite(raw.count) ? raw.count : items.length,
    page,
    limit,
    results: items,
  };
}

/** 查询单条 Freesound 音效的详细元数据。 */
export async function getSound(soundId: number, opts: FreesoundClientOptions = {}): Promise<FreesoundSoundItem> {
  if (!Number.isSafeInteger(soundId) || soundId <= 0) throw new Error(`无效的 Freesound 音效 ID：${soundId}`);
  const apiKey = resolveApiKey(opts);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const baseUrl = (opts.baseUrl ?? FreesoundApiBaseUrl).replace(/\/+$/, '');
  const params = new URLSearchParams({ fields: SearchFields });
  const raw = await fetchJson(`${baseUrl}/sounds/${soundId}/?${params.toString()}`, apiKey, fetchImpl, opts.signal);
  return normalizeSound(raw as RawFreesoundSound);
}

function pickDownloadUrl(
  sound: FreesoundSoundItem,
  requested: FreesoundDownloadQuality,
): { url: string; quality: FreesoundDownloadQuality; ext: string } {
  const byQuality: Record<FreesoundDownloadQuality, { url?: string; ext: string }> = {
    'preview-hq-mp3': { url: sound.preview_hq_mp3, ext: '.mp3' },
    'preview-hq-ogg': { url: sound.preview_hq_ogg, ext: '.ogg' },
    'preview-lq-mp3': { url: sound.preview_lq_mp3, ext: '.mp3' },
    original: { url: sound.download_url, ext: sound.type ? `.${sound.type.toLowerCase()}` : '.wav' },
  };
  const order: FreesoundDownloadQuality[] = [
    requested,
    'preview-hq-mp3',
    'preview-hq-ogg',
    'preview-lq-mp3',
    'original',
  ];
  for (const q of order) {
    const candidate = byQuality[q];
    if (!candidate.url) continue;
    const fromUrl = path.extname(new URL(candidate.url).pathname).toLowerCase();
    const ext = AllowedAudioExts.has(fromUrl) ? fromUrl : AllowedAudioExts.has(candidate.ext) ? candidate.ext : '.mp3';
    return { url: candidate.url, quality: q, ext };
  }
  throw new Error(`音效 #${sound.id}（${sound.name}）没有可用的下载或预览地址`);
}

async function readResponseWithLimit(res: Response, soundId: number, maxBytes: number): Promise<Buffer> {
  const contentLenRaw = res.headers?.get?.('content-length');
  if (contentLenRaw) {
    const contentLen = Number(contentLenRaw);
    if (Number.isFinite(contentLen) && contentLen > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`音效 #${soundId} 体积超过上限（${contentLen} > ${maxBytes} 字节）`);
    }
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`音效 #${soundId} 体积超过上限（>${maxBytes} 字节）`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    if (buf.length === 0) throw new Error(`下载到的音效 #${soundId} 内容为空`);
    return buf;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error(`下载到的音效 #${soundId} 内容为空`);
  if (bytes.length > maxBytes) throw new Error(`音效 #${soundId} 体积超过上限（${bytes.length} > ${maxBytes} 字节）`);
  return bytes;
}

/**
 * 下载指定 Freesound 音效到 <projectDir>/assets/sfx/，计算 RMS 与经真峰值夹取的 safe_gain_db，
 * 按 SHA-256 去重并登记来源 URL、作者与许可证归属到 <projectDir>/assets/sfx/audio-manifest.json。
 */
export async function downloadSound(
  soundId: number,
  projectDir: string,
  opts: FreesoundDownloadOptions = {},
): Promise<FreesoundDownloadResult> {
  if (!Number.isSafeInteger(soundId) || soundId <= 0) throw new Error(`无效的 Freesound 音效 ID：${soundId}`);
  const apiKey = resolveApiKey(opts);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const maxBytes = opts.maxBytes ?? DefaultMaxSfxBytes;
  const sound = opts.sound ?? (await getSound(soundId, opts));
  const picked = pickDownloadUrl(sound, opts.quality ?? 'preview-hq-mp3');

  const headers: Record<string, string> = {};
  if (picked.quality === 'original') headers.Authorization = `Token ${apiKey}`;

  const res = await fetchImpl(picked.url, { method: 'GET', headers, signal: opts.signal });
  if (res.status === 401 || res.status === 403) {
    throw new FreesoundApiKeyError(
      `下载音效 #${soundId} 鉴权失败（HTTP ${res.status}）：原音下载通常需要 OAuth2，请改用 preview-hq-mp3 预览流或检查凭据。`,
    );
  }
  if (!res.ok) throw new Error(`下载音效 #${soundId} 失败（HTTP ${res.status} ${res.statusText}）`);

  const bytes = await readResponseWithLimit(res, soundId, maxBytes);

  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const root = fs.realpathSync(path.resolve(projectDir));
  const sfxDir = assertSafeSfxDir(root);
  const manifest = readAudioManifest(root);
  const manifestAbs = audioManifestPath(root);

  const existing = manifest.entries.find((item) => item.sha256 === sha256);
  if (existing) {
    const existingAbs = path.resolve(root, existing.file);
    if (isSafeSfxFileInside(sfxDir, existingAbs)) {
      const diskSha = crypto.createHash('sha256').update(fs.readFileSync(existingAbs)).digest('hex');
      const restored = diskSha !== sha256;
      if (restored) atomicWrite(existingAbs, bytes, 0o644);
      const gain = analyzeAudioFile(existingAbs, {
        buffer: bytes,
        targetRmsDb: opts.targetRmsDb,
        ceilingDb: opts.ceilingDb,
        toolchain: opts.toolchain,
        env: opts.env as Record<string, string> | undefined,
      });
      const updatedEntry: AudioManifestEntry = { ...existing, gain };
      const nextEntries = manifest.entries.map((item) => (item.id === existing.id ? updatedEntry : item));
      writeAudioManifest(root, { version: 1, entries: nextEntries });
      return {
        entry: updatedEntry,
        file_path: existingAbs,
        manifest_path: manifestAbs,
        deduplicated: !restored,
      };
    }
  }

  const ext = detectExtFromContent(bytes, picked.ext);
  const stem = safeSlug(opts.name ? opts.name : sound.name);
  const shortHash = sha256.slice(0, 8);
  const fileName = `${stem}-fs${sound.id}-${shortHash}${ext}`;
  const absTarget = path.resolve(sfxDir, fileName);
  const relCheck = path.relative(sfxDir, absTarget);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`目标路径越出音效目录：${fileName}`);
  }

  atomicWrite(absTarget, bytes, 0o644);
  const gain = analyzeAudioFile(absTarget, {
    buffer: bytes,
    targetRmsDb: opts.targetRmsDb,
    ceilingDb: opts.ceilingDb,
    toolchain: opts.toolchain,
    env: opts.env as Record<string, string> | undefined,
  });

  const entry: AudioManifestEntry = {
    id: `fs-${sound.id}-${shortHash}`,
    freesound_id: sound.id,
    name: sound.name,
    file: `${SfxAssetsRelDir}/${fileName}`,
    bytes: bytes.length,
    sha256,
    source_url: sound.url,
    download_url: picked.url,
    author: sound.username,
    license: sound.license,
    license_short: sound.license_short,
    attribution: `"${sound.name}" by ${sound.username} (${sound.license_short}) - ${sound.url}`,
    duration_seconds: Math.round(sound.duration * 1000) / 1000,
    quality: picked.quality,
    gain,
  };

  const nextEntries = manifest.entries.filter((item) => item.sha256 !== sha256 && item.id !== entry.id);
  nextEntries.push(entry);
  writeAudioManifest(root, { version: 1, entries: nextEntries });

  return { entry, file_path: absTarget, manifest_path: manifestAbs, deduplicated: false };
}
