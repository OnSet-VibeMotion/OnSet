/**
 * 网页视觉资产与官方图标提取器：
 * - 提取页面内联 <svg> Logo（自动经 sanitizeSvg 净化）；
 * - 提取 favicon / apple-touch-icon / og:image / twitter:image / 主视觉图候选；
 * - 提取同源导航内页链接（供多页整站采集）；
 * - 查询 Simple Icons 官方矢量 SVG（经安全 HTTPS fetcher，可离线 mock）。
 */
import type { DnsResolverDeps } from '../brandkit/network';
import { assertSafeCollectUrl, safeFetchBuffer } from './http';
import { sanitizeSvg } from './store';
import type { CollectedAssetKind, SafeHttpTransport, WebFetcher } from './types';

export interface InlineSvgCandidate {
  svg: string;
  name: string;
  caption: string;
  priority: number;
}

export interface PageImageCandidate {
  url: string;
  role: 'logo' | 'og_image' | 'apple_touch_icon' | 'favicon' | 'hero';
  kind: CollectedAssetKind;
  name: string;
  caption: string;
  priority: number;
}

const MaxInlineSvgChars = 256 * 1024;

const NamedHtmlEntities = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
]);

/** 单遍解码 HTML 属性中的常见命名实体与十进制/十六进制数字字符引用（不重复解码 &amp;amp;，仅匹配自身实体键）。 */
export function decodeHtmlEntities(raw: string): string {
  return raw.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (full, hex, dec, name) => {
    if (hex !== undefined) {
      const cp = parseInt(hex, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    if (dec !== undefined) {
      const cp = parseInt(dec, 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    if (name !== undefined) {
      const mapped = NamedHtmlEntities.get(name.toLowerCase());
      if (mapped !== undefined) return mapped;
    }
    return full;
  });
}

function readAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return m ? decodeHtmlEntities((m[1] ?? m[2] ?? m[3] ?? '').trim()) : undefined;
}

function resolveHttpUrl(rawHref: string | undefined, baseUrl: string): string | null {
  if (!rawHref) return null;
  const trimmed = rawHref.trim();
  if (!trimmed || /^(?:data:|javascript:|mailto:|tel:|blob:|#)/i.test(trimmed)) return null;
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    resolved.hash = '';
    return resolved.href;
  } catch {
    return null;
  }
}

/** 从页面 HTML 中提取并净化候选内联 <svg> Logo。 */
export function extractInlineSvgLogos(html: string, maxCount = 3): InlineSvgCandidate[] {
  const found: InlineSvgCandidate[] = [];
  const seen = new Set<string>();
  const svgRe = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;
  for (const match of html.matchAll(svgRe)) {
    const raw = match[0];
    if (raw.length > MaxInlineSvgChars || raw.length < 24) continue;
    const idx = match.index ?? 0;
    const prefix = html.slice(Math.max(0, idx - 260), idx);
    const openTag = raw.match(/<svg\b[^>]*>/i)?.[0] ?? '';
    const attrs = `${openTag} ${prefix.slice(-120)}`.toLowerCase();
    const isLogoHint = /(?:logo|brand|wordmark|emblem|mark)/i.test(attrs);
    const inHeaderNav = /<(?:header|nav)\b/i.test(prefix) && !/<\/(?:header|nav)>/i.test(prefix.slice(-120));
    const hasShapes = /<(?:path|circle|rect|polygon|polyline|ellipse|text|g)\b/i.test(raw);
    if (!hasShapes) continue;
    if (!isLogoHint && !inHeaderNav) continue;
    let clean: string;
    try {
      clean = sanitizeSvg(raw);
    } catch {
      continue;
    }
    if (seen.has(clean)) continue;
    seen.add(clean);
    const aria = readAttr(openTag, 'aria-label') || readAttr(openTag, 'id') || '';
    found.push({
      svg: clean,
      name: aria ? `logo-${aria}` : `inline-logo-${found.length + 1}`,
      caption: aria ? `页面内联矢量 Logo（${aria}）` : '页面内联矢量 Logo',
      priority: (isLogoHint ? 100 : 60) + (inHeaderNav ? 20 : 0),
    });
  }
  return found.sort((a, b) => b.priority - a.priority).slice(0, maxCount);
}

/** 从页面 HTML 提取 favicon、apple-touch-icon、og:image、twitter:image 与主视觉图片候选。 */
export function extractPageImageCandidates(html: string, pageUrl: string): PageImageCandidate[] {
  const byUrl = new Map<string, PageImageCandidate>();
  const add = (candidate: PageImageCandidate) => {
    const prev = byUrl.get(candidate.url);
    if (!prev || candidate.priority > prev.priority) {
      byUrl.set(candidate.url, candidate);
    }
  };

  // 1. <link> 图标
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (readAttr(tag, 'rel') ?? '').toLowerCase();
    const href = resolveHttpUrl(readAttr(tag, 'href'), pageUrl);
    if (!href) continue;
    const isSvg = /\.svg(?:$|\?)/i.test(href) || (readAttr(tag, 'type') ?? '').includes('svg');
    if (rel.includes('apple-touch-icon')) {
      add({
        url: href,
        role: 'apple_touch_icon',
        kind: isSvg ? 'vector' : 'image',
        name: 'apple-touch-icon',
        caption: '站点高清应用图标（apple-touch-icon）',
        priority: 85,
      });
    } else if (/\b(?:shortcut\s+)?icon\b|\bmask-icon\b/.test(rel)) {
      add({
        url: href,
        role: 'favicon',
        kind: isSvg ? 'vector' : 'image',
        name: 'favicon',
        caption: '站点图标（favicon）',
        priority: isSvg ? 88 : 75,
      });
    }
  }

  // 2. <meta> OG / Twitter 主视觉图
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const prop = (readAttr(tag, 'property') ?? readAttr(tag, 'name') ?? '').toLowerCase();
    if (prop !== 'og:image' && prop !== 'twitter:image' && prop !== 'twitter:image:src') continue;
    const content = resolveHttpUrl(readAttr(tag, 'content'), pageUrl);
    if (!content) continue;
    const isSvg = /\.svg(?:$|\?)/i.test(content);
    add({
      url: content,
      role: 'og_image',
      kind: isSvg ? 'vector' : 'image',
      name: prop.startsWith('og:') ? 'og-image' : 'twitter-image',
      caption: prop.startsWith('og:') ? '页面社交主视觉图（og:image）' : '页面社交主视觉图（twitter:image）',
      priority: prop.startsWith('og:') ? 92 : 82,
    });
  }

  // 3. <img> Logo 与主视觉图
  let heroIndex = 0;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = resolveHttpUrl(readAttr(tag, 'src') ?? readAttr(tag, 'data-src'), pageUrl);
    if (!src) continue;
    const widthNum = Number(readAttr(tag, 'width') ?? 0);
    const heightNum = Number(readAttr(tag, 'height') ?? 0);
    if ((widthNum > 0 && widthNum <= 4) || (heightNum > 0 && heightNum <= 4)) continue;
    if (/(?:pixel|spacer|tracking|analytics|beacon)/i.test(src)) continue;
    const alt = readAttr(tag, 'alt') ?? '';
    const cls = `${readAttr(tag, 'class') ?? ''} ${readAttr(tag, 'id') ?? ''} ${alt} ${src}`.toLowerCase();
    const isSvg = /\.svg(?:$|\?)/i.test(src);
    const isLogo = /(?:logo|brand|wordmark)/i.test(cls);
    if (isLogo) {
      add({
        url: src,
        role: 'logo',
        kind: isSvg ? 'vector' : 'image',
        name: 'brand-logo',
        caption: alt ? `品牌 Logo（${alt.slice(0, 40)}）` : '品牌 Logo',
        priority: isSvg ? 98 : 94,
      });
    } else if (heroIndex < 4) {
      heroIndex++;
      const isHero = /(?:hero|banner|cover|showcase|product|feature)/i.test(cls) || widthNum >= 400;
      add({
        url: src,
        role: 'hero',
        kind: isSvg ? 'vector' : 'image',
        name: isHero ? `hero-${heroIndex}` : `visual-${heroIndex}`,
        caption: alt ? `页面主视觉图（${alt.slice(0, 48)}）` : '页面主视觉图',
        priority: isHero ? 70 - heroIndex : 50 - heroIndex,
      });
    }
  }

  return [...byUrl.values()].sort((a, b) => b.priority - a.priority);
}

/** 从首页导航与头部挑选最有代表性的同源内页链接（产品/功能/定价/关于/品牌等优先）。 */
export function extractNavLinks(html: string, rootUrl: string, maxLinks: number): string[] {
  if (maxLinks <= 0) return [];
  const root = new URL(rootUrl);
  const scored = new Map<string, number>();

  const headerNavBlocks = [
    ...[...html.matchAll(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi)].map((m) => ({ chunk: m[0], bonus: 30 })),
    ...[...html.matchAll(/<header\b[^>]*>[\s\S]*?<\/header>/gi)].map((m) => ({ chunk: m[0], bonus: 20 })),
  ];
  const sources = headerNavBlocks.length > 0 ? headerNavBlocks : [{ chunk: html, bonus: 0 }];

  const preferredRe =
    /\/(?:product|products|features|pricing|about|brand|design|showcase|solutions|docs|studio|press)/i;
  const skippedRe =
    /(?:\/(?:login|signin|sign-in|signup|sign-up|logout|register|cart|checkout|privacy|terms|legal|cookie|search|feed|rss)|\.(?:pdf|zip|png|jpe?g|gif|webp|svg|ico|mp4|webm|xml|json|css|js)(?:$|\?))/i;

  for (const { chunk, bonus } of sources) {
    for (const m of chunk.matchAll(/<a\b[^>]*>/gi)) {
      const href = resolveHttpUrl(readAttr(m[0], 'href'), root.href);
      if (!href) continue;
      let parsed: URL;
      try {
        parsed = new URL(href);
      } catch {
        continue;
      }
      if (parsed.origin !== root.origin) continue;
      const normPath = parsed.pathname.replace(/\/+$/, '') || '/';
      const rootPath = root.pathname.replace(/\/+$/, '') || '/';
      if (normPath === rootPath && !parsed.search) continue;
      if (skippedRe.test(parsed.pathname)) continue;
      const depth = normPath.split('/').filter(Boolean).length;
      if (depth > 3) continue;
      const score = bonus + (preferredRe.test(normPath) ? 40 : 10) - depth * 3 - (parsed.search ? 15 : 0);
      const cleanUrl = `${parsed.origin}${parsed.pathname}${parsed.search}`;
      const prev = scored.get(cleanUrl);
      if (prev === undefined || score > prev) scored.set(cleanUrl, score);
    }
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxLinks)
    .map(([url]) => url);
}

/** 将品牌名或域名归一化为 Simple Icons slug。 */
export function normalizeBrandSlug(brandOrUrl: string): string {
  let raw = brandOrUrl.trim().toLowerCase();
  if (/^https?:\/\//i.test(raw)) {
    try {
      const host = new URL(raw).hostname.replace(/^www\./, '');
      raw = host.split('.')[0] ?? host;
    } catch {
      // 保留原始文本继续归一化
    }
  }
  return raw
    .replace(/\+/g, 'plus')
    .replace(/\./g, 'dot')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

/** 查询 Simple Icons 官方矢量 SVG（经安全 HTTPS fetcher，失败返回 null）。 */
export async function fetchSimpleIconSvg(
  brandOrSlug: string,
  opts: {
    fetcher?: WebFetcher;
    deps?: DnsResolverDeps;
    signal?: AbortSignal;
    transport?: SafeHttpTransport;
    timeoutMs?: number;
  } = {},
): Promise<{ slug: string; url: string; svg: string } | null> {
  const slug = normalizeBrandSlug(brandOrSlug);
  if (!slug) return null;
  const doFetch = opts.fetcher ?? safeFetchBuffer;
  const candidates = [
    `https://cdn.simpleicons.org/${encodeURIComponent(slug)}`,
    `https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/${encodeURIComponent(slug)}.svg`,
  ];
  for (const url of candidates) {
    try {
      assertSafeCollectUrl(url);
      const resp = await doFetch(url, {
        maxBytes: 256 * 1024,
        timeoutMs: opts.timeoutMs ?? 8_000,
        accept: 'image/svg+xml,text/plain,*/*;q=0.5',
        deps: opts.deps,
        signal: opts.signal,
        transport: opts.transport,
      });
      const text = resp.body.toString('utf8');
      if (!/<svg\b/i.test(text)) continue;
      return { slug, url: resp.url || url, svg: sanitizeSvg(text) };
    } catch {
      // 尝试下一个镜像源或静默降级
    }
  }
  return null;
}
