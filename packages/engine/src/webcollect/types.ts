/**
 * 网站 / 品牌真实素材采集（webcollect）的类型与常量定义。
 * 落盘清单（manifest.json）字段采用 snake_case，与引擎其它持久化文件约定一致。
 */
import type { DnsResolverDeps } from '../brandkit/network';

export const CollectedAssetsRelDir = 'assets/collected';
export const CollectedManifestFile = 'manifest.json';
export const MaxCollectedFileBytes = 24 * 1024 * 1024;
export const MaxHtmlFetchBytes = 5 * 1024 * 1024;
export const MaxCssFetchBytes = 1024 * 1024;
export const DefaultGatherMaxPages = 4;
export const HardGatherMaxPages = 6;
export const DefaultCollectMaxAssets = 8;
export const DefaultScreenshotWidth = 1280;
export const DefaultScreenshotHeight = 720;
export const DefaultScreenshotScale = 2;

export type CollectedAssetKind = 'image' | 'vector' | 'screenshot';

export interface CollectedAssetEntry {
  id: string;
  file: string;
  kind: CollectedAssetKind;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  source: string;
  caption: string;
  mime_type?: string;
  collected_at?: string;
}

export interface CollectedManifest {
  version: 1;
  updated_at: string;
  assets: CollectedAssetEntry[];
}

export interface CollectedPageSummary {
  url: string;
  title: string;
  theme_color?: string;
  palette: string[];
  fonts: string[];
  asset_ids: string[];
  screenshot?: CollectedAssetEntry;
}

export interface CollectPageResult {
  url: string;
  title: string;
  palette: string[];
  fonts: string[];
  assets: CollectedAssetEntry[];
  screenshot?: CollectedAssetEntry;
  dry_run: boolean;
  manifest_path: string;
  warnings?: string[];
}

export interface BrandGatherSummary {
  brand: string;
  root_url?: string;
  palette: string[];
  fonts: string[];
  logos: CollectedAssetEntry[];
  pages: CollectedPageSummary[];
  assets: CollectedAssetEntry[];
  dry_run: boolean;
  manifest_path: string;
  warnings?: string[];
}

export interface SafeHttpRequest {
  url: URL;
  method: 'GET' | 'HEAD';
  address: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
  accept: string;
  signal?: AbortSignal;
}

export interface SafeHttpRawResponse {
  status: number;
  location?: string;
  contentType: string;
  body: Buffer;
}

export type SafeHttpTransport = (req: SafeHttpRequest) => Promise<SafeHttpRawResponse>;

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  accept?: string;
  deps?: DnsResolverDeps;
  signal?: AbortSignal;
  transport?: SafeHttpTransport;
}

export interface SafeFetchResponse {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
}

export type WebFetcher = (rawUrl: string, opts?: SafeFetchOptions) => Promise<SafeFetchResponse>;

export interface ScreenshotRunRequest {
  chromePath: string;
  targetUrl: string;
  outputPath: string;
  width: number;
  height: number;
  scale: number;
  isolated: boolean;
  hostResolverRules?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type ScreenshotRunner = (req: ScreenshotRunRequest) => Promise<void>;

export interface FetchAssetOptions {
  projectRoot: string;
  name?: string;
  caption?: string;
  kind?: CollectedAssetKind;
  dryRun?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  deps?: DnsResolverDeps;
  signal?: AbortSignal;
  fetcher?: WebFetcher;
  transport?: SafeHttpTransport;
}

export interface ScreenshotOptions {
  projectRoot: string;
  width?: number;
  height?: number;
  scale?: number;
  name?: string;
  caption?: string;
  timeoutMs?: number;
  chromePath?: string;
  deps?: DnsResolverDeps;
  signal?: AbortSignal;
  transport?: SafeHttpTransport;
  runner?: ScreenshotRunner;
  env?: Record<string, string>;
}

export interface CollectPageOptions {
  projectRoot: string;
  dryRun?: boolean;
  maxAssets?: number;
  includeScreenshot?: boolean;
  screenshotWidth?: number;
  screenshotHeight?: number;
  timeoutMs?: number;
  deps?: DnsResolverDeps;
  signal?: AbortSignal;
  fetcher?: WebFetcher;
  transport?: SafeHttpTransport;
  chromePath?: string;
  screenshotRunner?: ScreenshotRunner;
}

export interface GatherSiteOptions extends CollectPageOptions {
  maxPages?: number;
  brandSlug?: string;
}
