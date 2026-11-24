/**
 * 官网品牌样式提取器：
 * - 从公开网页 HTML + CSS 中确定性提取 CSS 变量、主色/背景/文字色、字体栈、圆角、渐变、OG 图与站点标题；
 * - 使用与 OpenMotion 同源的色度 + 语义角色打分公式挑选主品牌色（accent），排除纯黑白灰误判；
 * - 严格遵守数据边界：抓取结果仅作为视觉参考数据，绝不把网页文本或 SVG 脚本带入执行上下文。
 */
import { assertSafePublicUrl, type DnsResolverDeps, fetchPublicText } from './network';
import { type BrandStyle, type BrandTokens, DefaultBrandStyle, validateBrandStyle } from './types';

export interface ExtractedBrandResult {
  name: string;
  source_url: string;
  style: BrandStyle;
  tokens: BrandTokens;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    return [parseInt(clean[0] + clean[0], 16), parseInt(clean[1] + clean[1], 16), parseInt(clean[2] + clean[2], 16)];
  }
  if (clean.length === 6 || clean.length === 8) {
    return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
  }
  return null;
}

function normalizeHex(raw: string): string | null {
  const m = raw.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  const h = m[1].toLowerCase();
  if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  return `#${h}`;
}

function colorChroma(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const max = Math.max(...rgb) / 255;
  const min = Math.min(...rgb) / 255;
  return max - min;
}

function relativeLuma(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/** 按色度、交互频次与语义线索给候选主品牌色打分。 */
export function scorePrimaryAccent(candidates: Array<{ hex: string; count: number; primaryHint?: boolean }>): string {
  let best = DefaultBrandStyle.accent;
  let bestScore = -1;
  for (const item of candidates) {
    const chroma = colorChroma(item.hex);
    if (chroma < 0.14) continue; // 排除中性黑白灰
    const score = chroma * 4 + Math.min(5, item.count) * 0.5 + (item.primaryHint ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = item.hex;
    }
  }
  return best;
}

function cleanTitle(html: string, url: string): string {
  const ogSite = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,80})["']/i)?.[1];
  const title = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1];
  const raw = (ogSite || title || new URL(url).hostname.replace(/^www\./, '')).replace(/\s+/g, ' ').trim();
  // 去掉「Brand — Slogan」后面的副标题
  return (
    raw
      .split(/\s+[|—–-]\s+/)[0]
      .trim()
      .slice(0, 60) || new URL(url).hostname
  );
}

function sanitizeFontList(raw: string): string | null {
  const cleaned = raw
    .replace(/!important/gi, '')
    .replace(/var\([^)]*\)/g, '')
    .replace(/[^\w\u4e00-\u9fff ,"'_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > 160) return null;
  if (/^(?:inherit|initial|unset|revert)$/i.test(cleaned)) return null;
  return cleaned;
}

/** 纯函数确定性解析网页 HTML 与 CSS 文本，产出归一化 BrandStyle 与 BrandTokens。 */
export function extractBrandFromHtml(
  sourceUrl: string,
  html: string,
  externalCss: readonly string[] = [],
): ExtractedBrandResult {
  const name = cleanTitle(html, sourceUrl);
  const inlineStyles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const allCss = [...inlineStyles, ...externalCss].join('\n');

  // 1. 提取 CSS 自定义属性（最多 300 条）
  const cssVars: Record<string, string> = {};
  for (const m of allCss.matchAll(/(--[a-zA-Z0-9_-]{1,64})\s*:\s*([^;{}]{1,120});/g)) {
    if (Object.keys(cssVars).length >= 300) break;
    cssVars[m[1]] = m[2].trim();
  }

  // 2. 提取颜色与语义提示
  const colorCounts = new Map<string, { count: number; primaryHint: boolean }>();
  const addColor = (raw: string, primaryHint = false, weight = 1) => {
    const hex = normalizeHex(raw);
    if (!hex) return;
    const prev = colorCounts.get(hex) ?? { count: 0, primaryHint: false };
    colorCounts.set(hex, { count: prev.count + weight, primaryHint: prev.primaryHint || primaryHint });
  };

  const themeColor = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (themeColor) addColor(themeColor, true, 3);

  for (const [varName, value] of Object.entries(cssVars)) {
    const isPrimary = /primary|accent|brand|cta/i.test(varName);
    for (const hexMatch of value.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
      addColor(hexMatch[0], isPrimary, isPrimary ? 3 : 1);
    }
  }
  for (const hexMatch of allCss.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    addColor(hexMatch[0], false, 1);
  }

  // 背景与文字变量优先
  const varHex = (re: RegExp): string | undefined => {
    for (const [k, v] of Object.entries(cssVars)) {
      if (re.test(k)) {
        const h = normalizeHex(v);
        if (h) return h;
      }
    }
    return undefined;
  };

  const allSorted = [...colorCounts.entries()].sort((a, b) => b[1].count - a[1].count);
  const bg =
    varHex(/--(?:bg|background|canvas|page-bg)$/i) ??
    allSorted.find(([hex]) => colorChroma(hex) < 0.12 && (relativeLuma(hex) > 0.85 || relativeLuma(hex) < 0.16))?.[0] ??
    DefaultBrandStyle.bg;
  const darkBg = relativeLuma(bg) < 0.45;
  const surface = varHex(/--(?:surface|card|panel|elevated)$/i) ?? (darkBg ? '#181b22' : '#f4f5f7');
  const text = varHex(/--(?:text|fg|foreground|ink)$/i) ?? (darkBg ? '#f5f2eb' : '#111827');
  const muted = varHex(/--(?:muted|text-secondary|subtle)$/i) ?? (darkBg ? '#9ca3af' : '#6b7280');
  const accent = scorePrimaryAccent(
    allSorted.map(([hex, meta]) => ({ hex, count: meta.count, primaryHint: meta.primaryHint })),
  );

  // 3. 提取字体栈
  const fonts: string[] = [];
  for (const m of allCss.matchAll(/font-family\s*:\s*([^;{}]+);/gi)) {
    const f = sanitizeFontList(m[1]);
    if (f && !fonts.includes(f)) fonts.push(f);
    if (fonts.length >= 12) break;
  }
  const displayFont = fonts[0] ?? DefaultBrandStyle.display_font;
  const bodyFont = fonts[1] ?? fonts[0] ?? DefaultBrandStyle.body_font;
  const monoFont = fonts.find((f) => /mono|code|consolas|courier/i.test(f));

  // 4. 提取圆角与渐变
  const radii: string[] = [];
  for (const m of allCss.matchAll(/border-radius\s*:\s*(\d+(?:\.\d+)?(?:px|rem))/gi)) {
    if (!radii.includes(m[1])) radii.push(m[1]);
    if (radii.length >= 8) break;
  }
  const radius = radii[0] ?? DefaultBrandStyle.radius;
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];

  const style = validateBrandStyle({
    bg,
    surface,
    text,
    muted,
    accent,
    display_font: displayFont,
    body_font: bodyFont,
    mono_font: monoFont,
    radius,
  });

  return {
    name,
    source_url: sourceUrl,
    style,
    tokens: {
      css_variables: Object.keys(cssVars).length > 0 ? cssVars : undefined,
      palette: allSorted.slice(0, 12).map(([hex]) => hex),
      fonts: fonts.length > 0 ? fonts : undefined,
      radii: radii.length > 0 ? radii : undefined,
      theme_color: themeColor ? (normalizeHex(themeColor) ?? undefined) : undefined,
      og_image: ogImage,
    },
  };
}

/** 安全抓取公开 HTTPS 网站及其最多 4 份样式表并提取品牌视觉。 */
export async function extractBrandFromUrl(
  rawUrl: string,
  opts: { deps?: DnsResolverDeps; signal?: AbortSignal; fetcher?: typeof fetchPublicText } = {},
): Promise<ExtractedBrandResult> {
  const url = assertSafePublicUrl(rawUrl);
  const doFetch = opts.fetcher ?? fetchPublicText;
  const page = await doFetch(url.href, { deps: opts.deps, signal: opts.signal });

  // 提取最多 4 个外链样式表（全部走同一套公网安全校验）
  const cssLinks = [...page.body.matchAll(/<link[^>]+rel=["'][^"']*stylesheet[^"']*["'][^>]+href=["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .slice(0, 4);
  const externalCss: string[] = [];
  for (const href of cssLinks) {
    try {
      const target = assertSafePublicUrl(new URL(href, page.url).href);
      const cssResp = await doFetch(target.href, {
        maxBytes: 1024 * 1024,
        timeoutMs: 10_000,
        deps: opts.deps,
        signal: opts.signal,
      });
      externalCss.push(cssResp.body);
    } catch {
      // 单个外链样式表失败不阻塞整体提取
    }
  }
  return extractBrandFromHtml(page.url, page.body, externalCss);
}
