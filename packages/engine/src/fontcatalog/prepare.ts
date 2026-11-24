import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { type FontEntry, type FontFile, fontFaceCss, getFont } from './catalog';

export const FontCacheDirEnv = 'ONSET_FONT_CACHE_DIR';

const MaxFontBytes = 64 * 1024 * 1024;

export interface PrepareFontOptions {
  weight?: number;
  cacheRoot?: string;
  projectRoot?: string;
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

export interface PreparedFontFile {
  name: string;
  weight: string;
  style: string;
  sha256: string;
  size: number;
  cache_path: string;
  project_path?: string;
  css?: string;
}

export interface PrepareFontResult {
  id: string;
  family: string;
  requested_weight: number;
  license_spdx: string;
  license_cache_path: string;
  license_project_path?: string;
  files: PreparedFontFile[];
}

/** 解析精选字体本地缓存根目录。 */
export function defaultFontCacheDir(env: Record<string, string | undefined> = process.env): string {
  if (env[FontCacheDirEnv]) return path.resolve(env[FontCacheDirEnv]!);
  const home = env.HOME || os.homedir();
  return path.join(home, '.cache', 'onset', 'fonts');
}

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function weightRange(spec: string): [number, number] {
  const parts = spec.trim().split(/\s+/).map(Number);
  const min = parts[0] ?? 400;
  const max = parts[1] ?? min;
  return [min, max];
}

function selectFontFiles(font: FontEntry, requestedWeight?: number): { weight: number; files: FontFile[] } {
  const upright = font.files.filter((f) => f.style === 'normal');
  if (upright.length === 0) throw new Error(`字体 ${font.id} 目录里没有可用的常规字重`);
  const has400 = upright.some((f) => {
    const [min, max] = weightRange(f.weight);
    return min <= 400 && 400 <= max;
  });
  const defaultWeight = has400 ? 400 : weightRange(upright[0].weight)[0];
  const weight = requestedWeight ?? defaultWeight;
  if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
    throw new Error(`非法字重 ${String(weight)}，必须是 1–1000 的整数`);
  }
  const matched = upright.filter((f) => {
    const [min, max] = weightRange(f.weight);
    return min <= weight && weight <= max;
  });
  if (matched.length === 0) {
    const available = upright.map((f) => f.weight).join('、');
    throw new Error(`字体 ${font.id}（${font.family}）不支持字重 ${weight}；可选范围：${available}`);
  }
  return { weight, files: matched };
}

function assertImmutableAsset(asset: { name: string; url: string; size: number; sha256: string }): void {
  const parsed = new URL(asset.url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'raw.githubusercontent.com' ||
    !/\/[a-f0-9]{40}\//.test(parsed.pathname)
  ) {
    throw new Error(`拒绝拉取非固定 commit 字体资源：${asset.url}`);
  }
  if (path.basename(asset.name) !== asset.name || asset.name.includes('..')) {
    throw new Error(`非法字体文件名：${asset.name}`);
  }
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || asset.size <= 0 || asset.size > MaxFontBytes) {
    throw new Error(`字体清单校验元数据无效：${asset.name}`);
  }
}

async function acquireVerifiedFile(
  dir: string,
  asset: { name: string; url: string; size: number; sha256: string },
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  assertImmutableAsset(asset);
  const dest = path.join(dir, asset.name);
  if (fs.existsSync(dest)) {
    const cached = fs.readFileSync(dest);
    if (cached.length === asset.size && sha256Buffer(cached) === asset.sha256) {
      return dest;
    }
  }
  const timeout = AbortSignal.timeout(90_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const resp = await fetcher(asset.url, { signal: combined, redirect: 'error' });
  if (!resp.ok) {
    throw new Error(`下载字体资源失败（HTTP ${resp.status}）：${asset.name}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length !== asset.size) {
    throw new Error(`字体文件大小不符（期望 ${asset.size}，实测 ${buf.length}）：${asset.name}`);
  }
  const got = sha256Buffer(buf);
  if (got !== asset.sha256) {
    throw new Error(`字体文件 SHA-256 校验失败：${asset.name}`);
  }
  atomicWrite(dest, buf, 0o644);
  return dest;
}

/**
 * 按目录固定 commit 与 SHA-256 校验拉取字体及许可证到本机缓存；
 * 传入 projectRoot 时同时拷入项目的 assets/fonts/ 并生成合法 @font-face CSS。
 */
export async function prepareFont(id: string, opts: PrepareFontOptions = {}): Promise<PrepareFontResult> {
  const font = getFont(id);
  if (!font) throw new Error(`未知字体 ID：${id}`);
  const { weight, files: selected } = selectFontFiles(font, opts.weight);
  const cacheRoot = opts.cacheRoot ? path.resolve(opts.cacheRoot) : defaultFontCacheDir(opts.env);
  const cacheDir = path.join(cacheRoot, font.source.commit, font.id);
  fs.mkdirSync(cacheDir, { recursive: true });
  const fetcher = opts.fetcher ?? fetch;

  const licenseCachePath = await acquireVerifiedFile(
    cacheDir,
    { name: 'OFL.txt', url: font.license.url, size: font.license.size, sha256: font.license.sha256 },
    fetcher,
    opts.signal,
  );

  let licenseProjectPath: string | undefined;
  if (opts.projectRoot) {
    const destLicense = path.join(opts.projectRoot, 'assets', 'fonts', `${font.id}-OFL.txt`);
    atomicWrite(destLicense, fs.readFileSync(licenseCachePath), 0o644);
    licenseProjectPath = `assets/fonts/${font.id}-OFL.txt`;
  }

  const outFiles: PreparedFontFile[] = [];
  for (const file of selected) {
    const cachePath = await acquireVerifiedFile(cacheDir, file, fetcher, opts.signal);
    const entry: PreparedFontFile = {
      name: file.name,
      weight: file.weight,
      style: file.style,
      sha256: file.sha256,
      size: file.size,
      cache_path: cachePath,
    };
    if (opts.projectRoot) {
      const destFont = path.join(opts.projectRoot, 'assets', 'fonts', file.name);
      atomicWrite(destFont, fs.readFileSync(cachePath), 0o644);
      entry.project_path = `assets/fonts/${file.name}`;
      entry.css = fontFaceCss(font.family, `assets/fonts/${file.name}`, file.weight, file.style);
    }
    outFiles.push(entry);
  }

  return {
    id: font.id,
    family: font.family,
    requested_weight: weight,
    license_spdx: font.license.spdx,
    license_cache_path: licenseCachePath,
    license_project_path: licenseProjectPath,
    files: outFiles,
  };
}
