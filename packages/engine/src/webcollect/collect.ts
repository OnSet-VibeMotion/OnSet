/**
 * 单页采集与单素材安全下载：
 * - fetchAsset：安全下载单张原图或官方矢量 SVG（强制走 brandkit/network.ts 的公网边界）；
 * - collectPage：抓单页 HTML + 外链样式，提取并保存图标、OG 图、主视觉、内联 SVG、色板与字体。
 */
import { extractBrandFromHtml } from '../brandkit/extract';
import { assertSafeCollectUrl, safeFetchBuffer } from './http';
import { extractInlineSvgLogos, extractPageImageCandidates } from './icons';
import { captureViewport } from './screenshot';
import { collectedManifestRelPath, saveCollectedAsset } from './store';
import {
  type CollectedAssetEntry,
  type CollectedAssetKind,
  type CollectPageOptions,
  type CollectPageResult,
  DefaultCollectMaxAssets,
  type FetchAssetOptions,
  MaxCollectedFileBytes,
  MaxCssFetchBytes,
  MaxHtmlFetchBytes,
} from './types';

function detectAssetFormat(
  buf: Buffer,
  contentType: string,
  url: string,
): { ext: string; mimeType: string; kind: CollectedAssetKind } {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  const headText = buf.subarray(0, Math.min(buf.length, 512)).toString('utf8').trimStart();

  if (
    ct === 'image/svg+xml' ||
    /<svg\b/i.test(headText) ||
    (headText.startsWith('<?xml') && /<svg\b/i.test(headText))
  ) {
    return { ext: '.svg', mimeType: 'image/svg+xml', kind: 'vector' };
  }
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: '.png', mimeType: 'image/png', kind: 'image' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: '.jpg', mimeType: 'image/jpeg', kind: 'image' };
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'GIF8') {
    return { ext: '.gif', mimeType: 'image/gif', kind: 'image' };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: '.webp', mimeType: 'image/webp', kind: 'image' };
  }
  if (buf.length >= 4 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) {
    return { ext: '.ico', mimeType: 'image/x-icon', kind: 'image' };
  }

  const mimeMap: Record<string, { ext: string; kind: CollectedAssetKind }> = {
    'image/png': { ext: '.png', kind: 'image' },
    'image/jpeg': { ext: '.jpg', kind: 'image' },
    'image/webp': { ext: '.webp', kind: 'image' },
    'image/gif': { ext: '.gif', kind: 'image' },
    'image/x-icon': { ext: '.ico', kind: 'image' },
    'image/vnd.microsoft.icon': { ext: '.ico', kind: 'image' },
    'image/avif': { ext: '.avif', kind: 'image' },
  };
  if (mimeMap[ct]) return { ext: mimeMap[ct].ext, mimeType: ct, kind: mimeMap[ct].kind };

  const pathname = new URL(url).pathname.toLowerCase();
  const extMatch = pathname.match(/\.(png|jpe?g|webp|gif|svg|ico|avif)$/);
  if (extMatch) {
    const ext = extMatch[1] === 'jpeg' ? '.jpg' : `.${extMatch[1]}`;
    return {
      ext,
      mimeType: ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1)}`,
      kind: ext === '.svg' ? 'vector' : 'image',
    };
  }
  throw new Error(`无法识别为支持的图片或矢量 SVG 资源（content-type=${ct || '未知'}）：${url}`);
}

/** 安全下载单个公开图片或官方矢量 SVG 并按 SHA-256 去重落盘。 */
export async function fetchAsset(rawUrl: string, opts: FetchAssetOptions): Promise<CollectedAssetEntry> {
  const safeUrl = assertSafeCollectUrl(rawUrl);
  const doFetch = opts.fetcher ?? safeFetchBuffer;
  const resp = await doFetch(safeUrl.href, {
    maxBytes: opts.maxBytes ?? MaxCollectedFileBytes,
    timeoutMs: opts.timeoutMs ?? 20_000,
    accept: 'image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/*,*/*;q=0.5',
    deps: opts.deps,
    signal: opts.signal,
    transport: opts.transport,
  });
  const finalUrl = resp.url || safeUrl.href;
  const format = detectAssetFormat(resp.body, resp.contentType, finalUrl);
  const baseName =
    opts.name ||
    new URL(finalUrl).pathname
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ||
    'asset';
  const saved = saveCollectedAsset({
    projectRoot: opts.projectRoot,
    buffer: resp.body,
    ext: format.ext,
    kind: opts.kind ?? format.kind,
    source: finalUrl,
    caption: opts.caption || `外部采集素材（${new URL(finalUrl).hostname}）`,
    name: baseName,
    mimeType: format.mimeType,
    dryRun: opts.dryRun,
    maxBytes: opts.maxBytes ?? MaxCollectedFileBytes,
  });
  return saved.entry;
}

/** 抓取单页 HTML 及最多 4 份外链样式表（全部经公网防 SSRF 校验）。 */
export async function fetchPageWithStyles(
  rawUrl: string,
  opts: CollectPageOptions,
): Promise<{ finalUrl: string; html: string; externalCss: string[] }> {
  const safeUrl = assertSafeCollectUrl(rawUrl);
  const doFetch = opts.fetcher ?? safeFetchBuffer;
  const page = await doFetch(safeUrl.href, {
    maxBytes: MaxHtmlFetchBytes,
    timeoutMs: opts.timeoutMs ?? 20_000,
    accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    deps: opts.deps,
    signal: opts.signal,
    transport: opts.transport,
  });
  const finalUrl = page.url || safeUrl.href;
  const html = page.body.toString('utf8');

  const cssLinks = [...html.matchAll(/<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi)]
    .map((m) => m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1])
    .filter((href): href is string => Boolean(href))
    .slice(0, 4);

  const externalCss: string[] = [];
  for (const href of cssLinks) {
    try {
      const cssUrl = assertSafeCollectUrl(new URL(href, finalUrl).href);
      const cssResp = await doFetch(cssUrl.href, {
        maxBytes: MaxCssFetchBytes,
        timeoutMs: Math.min(opts.timeoutMs ?? 10_000, 10_000),
        accept: 'text/css,*/*;q=0.5',
        deps: opts.deps,
        signal: opts.signal,
        transport: opts.transport,
      });
      externalCss.push(cssResp.body.toString('utf8'));
    } catch {
      // 单个外链样式表失败不阻塞采集
    }
  }
  return { finalUrl, html, externalCss };
}

/** 对已抓取好的单页 HTML/CSS 执行素材提取与保存（供 collectPage 与 gatherSite 复用）。 */
export async function collectFetchedPage(
  finalUrl: string,
  html: string,
  externalCss: string[],
  opts: CollectPageOptions,
): Promise<CollectPageResult> {
  const dryRun = Boolean(opts.dryRun);
  const maxAssets = Math.max(1, Math.min(24, opts.maxAssets ?? DefaultCollectMaxAssets));
  const brand = extractBrandFromHtml(finalUrl, html, externalCss);
  const warnings: string[] = [];
  const collected: CollectedAssetEntry[] = [];
  const seenSha = new Set<string>();

  const pushUnique = (entry: CollectedAssetEntry) => {
    if (seenSha.has(entry.sha256)) return;
    seenSha.add(entry.sha256);
    collected.push(entry);
  };

  for (const inlineLogo of extractInlineSvgLogos(html, 3)) {
    if (collected.length >= maxAssets) break;
    try {
      const saved = saveCollectedAsset({
        projectRoot: opts.projectRoot,
        buffer: Buffer.from(inlineLogo.svg, 'utf8'),
        ext: '.svg',
        kind: 'vector',
        source: `inline-svg:${finalUrl}`,
        caption: inlineLogo.caption,
        name: inlineLogo.name,
        mimeType: 'image/svg+xml',
        dryRun,
      });
      pushUnique(saved.entry);
    } catch (err) {
      warnings.push(`内联 SVG 保存失败：${(err as Error).message}`);
    }
  }

  const maxAttempts = Math.min(32, maxAssets * 3);
  let attempts = 0;
  for (const candidate of extractPageImageCandidates(html, finalUrl)) {
    if (collected.length >= maxAssets || attempts >= maxAttempts) break;
    attempts++;
    try {
      const entry = await fetchAsset(candidate.url, {
        projectRoot: opts.projectRoot,
        name: candidate.name,
        caption: candidate.caption,
        kind: candidate.kind,
        dryRun,
        timeoutMs: opts.timeoutMs,
        deps: opts.deps,
        signal: opts.signal,
        fetcher: opts.fetcher,
        transport: opts.transport,
      });
      pushUnique(entry);
    } catch (err) {
      warnings.push(`跳过素材 ${candidate.url}：${(err as Error).message}`);
    }
  }

  let screenshot: CollectedAssetEntry | undefined;
  if (opts.includeScreenshot && !dryRun) {
    try {
      screenshot = await captureViewport(finalUrl, {
        projectRoot: opts.projectRoot,
        width: opts.screenshotWidth,
        height: opts.screenshotHeight,
        timeoutMs: opts.timeoutMs,
        chromePath: opts.chromePath,
        deps: opts.deps,
        signal: opts.signal,
        transport: opts.transport,
        runner: opts.screenshotRunner,
      });
      pushUnique(screenshot);
    } catch (err) {
      warnings.push(`页面截图失败：${(err as Error).message}`);
    }
  }

  return {
    url: finalUrl,
    title: brand.name,
    palette: brand.tokens.palette ?? [],
    fonts: brand.tokens.fonts ?? [],
    assets: collected,
    screenshot,
    dry_run: dryRun,
    manifest_path: collectedManifestRelPath(),
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** 采集单页 HTML、样式、内联 SVG Logo、favicon / og:image / 主视觉图以及色板与字体。 */
export async function collectPage(rawUrl: string, opts: CollectPageOptions): Promise<CollectPageResult> {
  const { finalUrl, html, externalCss } = await fetchPageWithStyles(rawUrl, opts);
  return collectFetchedPage(finalUrl, html, externalCss, opts);
}

export { gatherSite } from './gather';
