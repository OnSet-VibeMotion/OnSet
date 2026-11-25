/**
 * 整站 / 品牌多页采集与跨页聚合：
 * - 抓取首页并挑选导航内页（默认 4 页、硬上限 6 页）；
 * - 跨页按频次聚合实测品牌配色与字体栈；
 * - 合并页面内联 SVG、Simple Icons 官方矢量与高清 favicon 作为品牌 Logo 集合。
 */
import { extractBrandFromHtml } from '../brandkit/extract';
import { collectFetchedPage, collectPage, fetchPageWithStyles } from './collect';
import { assertSafeCollectUrl } from './http';
import { extractNavLinks, fetchSimpleIconSvg, normalizeBrandSlug } from './icons';
import { collectedManifestRelPath, saveCollectedAsset } from './store';
import {
  type BrandGatherSummary,
  type CollectedAssetEntry,
  type CollectedPageSummary,
  type CollectPageOptions,
  DefaultCollectMaxAssets,
  DefaultGatherMaxPages,
  type GatherSiteOptions,
  HardGatherMaxPages,
} from './types';

function looksLikeUrlOrHost(input: string): boolean {
  const s = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/.*)?$/i.test(s)) return true;
  return false;
}

function rankByFrequency(lists: readonly (readonly string[])[], limit: number): string[] {
  const counts = new Map<string, { count: number; firstIndex: number }>();
  let order = 0;
  for (const list of lists) {
    const pageSeen = new Set<string>();
    for (const item of list) {
      const key = item.trim();
      if (!key) continue;
      // 跨页出现的配色/字体权重高于单页内重复出现
      const weight = pageSeen.has(key) ? 1 : 2;
      pageSeen.add(key);
      const prev = counts.get(key);
      if (prev) prev.count += weight;
      else counts.set(key, { count: weight, firstIndex: order++ });
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].firstIndex - b[1].firstIndex)
    .slice(0, limit)
    .map(([val]) => val);
}

/**
 * 整站/品牌一键采集：
 * - 传入网址：抓取首页并自动挑选导航内页（默认 4 页，硬上限 6 页），跨页聚合配色与字体，
 *   并合并页面内联 SVG、Simple Icons 官方矢量与高清 favicon 作为品牌 Logo 集合；
 * - 传入品牌名/slug：直接通过 Simple Icons 获取官方矢量 Logo 并落盘登记清单。
 */
export async function gatherSite(urlOrBrand: string, opts: GatherSiteOptions): Promise<BrandGatherSummary> {
  const trimmed = urlOrBrand.trim();
  if (!trimmed) throw new Error('请提供要采集的官网 URL 或品牌名称');
  const dryRun = Boolean(opts.dryRun);
  const warnings: string[] = [];

  if (!looksLikeUrlOrHost(trimmed)) {
    const slug = opts.brandSlug || normalizeBrandSlug(trimmed);
    const icon = await fetchSimpleIconSvg(slug, {
      fetcher: opts.fetcher,
      deps: opts.deps,
      signal: opts.signal,
      transport: opts.transport,
      timeoutMs: opts.timeoutMs,
    });
    const logos: CollectedAssetEntry[] = [];
    if (icon) {
      const saved = saveCollectedAsset({
        projectRoot: opts.projectRoot,
        buffer: Buffer.from(icon.svg, 'utf8'),
        ext: '.svg',
        kind: 'vector',
        source: `simple-icons:${icon.slug}`,
        caption: `${trimmed} 官方矢量图标（Simple Icons）`,
        name: `logo-${icon.slug}`,
        mimeType: 'image/svg+xml',
        dryRun,
      });
      logos.push(saved.entry);
    } else {
      warnings.push(`未在 Simple Icons 找到品牌图标：${slug}`);
    }
    return {
      brand: trimmed,
      palette: [],
      fonts: [],
      logos,
      pages: [],
      assets: logos,
      dry_run: dryRun,
      manifest_path: collectedManifestRelPath(),
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  const normalizedRootUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  assertSafeCollectUrl(normalizedRootUrl);
  const maxPages = Math.max(1, Math.min(HardGatherMaxPages, Math.round(opts.maxPages ?? DefaultGatherMaxPages)));

  const rootFetched = await fetchPageWithStyles(normalizedRootUrl, opts);
  const rootBrand = extractBrandFromHtml(rootFetched.finalUrl, rootFetched.html, rootFetched.externalCss);
  const innerUrls = extractNavLinks(rootFetched.html, rootFetched.finalUrl, maxPages - 1);
  const pageUrls = [rootFetched.finalUrl, ...innerUrls];

  const pages: CollectedPageSummary[] = [];
  const allAssets: CollectedAssetEntry[] = [];
  const seenAssetSha = new Set<string>();
  const logos: CollectedAssetEntry[] = [];
  const seenLogoSha = new Set<string>();

  const recordAsset = (entry: CollectedAssetEntry, isLogo = false) => {
    if (!seenAssetSha.has(entry.sha256)) {
      seenAssetSha.add(entry.sha256);
      allAssets.push(entry);
    }
    if (isLogo && !seenLogoSha.has(entry.sha256)) {
      seenLogoSha.add(entry.sha256);
      logos.push(entry);
    }
  };

  for (let i = 0; i < pageUrls.length; i++) {
    const pageUrl = pageUrls[i];
    try {
      const pageOpts: CollectPageOptions = {
        ...opts,
        maxAssets: i === 0 ? (opts.maxAssets ?? DefaultCollectMaxAssets) : Math.min(opts.maxAssets ?? 4, 4),
        includeScreenshot: i === 0 ? opts.includeScreenshot : false,
      };
      const res =
        i === 0
          ? await collectFetchedPage(rootFetched.finalUrl, rootFetched.html, rootFetched.externalCss, pageOpts)
          : await collectPage(pageUrl, pageOpts);
      if (res.warnings) warnings.push(...res.warnings);
      for (const asset of res.assets) {
        const isLogo =
          asset.kind === 'vector' ||
          asset.source.startsWith('inline-svg:') ||
          /logo|favicon|apple-touch-icon/i.test(asset.id);
        recordAsset(asset, isLogo);
      }
      pages.push({
        url: res.url,
        title: res.title,
        theme_color: i === 0 ? rootBrand.tokens.theme_color : undefined,
        palette: res.palette,
        fonts: res.fonts,
        asset_ids: res.assets.map((a) => a.id),
        screenshot: res.screenshot,
      });
    } catch (err) {
      warnings.push(`采集内页失败 ${pageUrl}：${(err as Error).message}`);
    }
  }

  const slug = opts.brandSlug || normalizeBrandSlug(rootBrand.name) || normalizeBrandSlug(rootFetched.finalUrl);
  if (slug) {
    const icon = await fetchSimpleIconSvg(slug, {
      fetcher: opts.fetcher,
      deps: opts.deps,
      signal: opts.signal,
      transport: opts.transport,
      timeoutMs: opts.timeoutMs,
    });
    if (icon) {
      const saved = saveCollectedAsset({
        projectRoot: opts.projectRoot,
        buffer: Buffer.from(icon.svg, 'utf8'),
        ext: '.svg',
        kind: 'vector',
        source: `simple-icons:${icon.slug}`,
        caption: `${rootBrand.name} 官方矢量图标（Simple Icons）`,
        name: `logo-${icon.slug}`,
        mimeType: 'image/svg+xml',
        dryRun,
      });
      recordAsset(saved.entry, true);
    }
  }

  return {
    brand: rootBrand.name,
    root_url: rootFetched.finalUrl,
    palette: rankByFrequency(
      pages.map((p) => p.palette),
      12,
    ),
    fonts: rankByFrequency(
      pages.map((p) => p.fonts),
      8,
    ),
    logos,
    pages,
    assets: allAssets,
    dry_run: dryRun,
    manifest_path: collectedManifestRelPath(),
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
