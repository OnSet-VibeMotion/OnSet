import { writeJsonlIndex } from '../fsutil';
import rawCatalog from './catalog.json';

export interface FontFile {
  name: string;
  url: string;
  sha256: string;
  size: number;
  family: string;
  weight: string;
  style: string;
  postscriptName?: string;
}

export interface FontPairing {
  id: string;
  reason: string;
  when?: string;
  avoidWhen?: string;
}

export interface FontEntry {
  id: string;
  family: string;
  source: {
    repository: string;
    commit: string;
    directory: string;
  };
  license: {
    spdx: string;
    url: string;
    sha256: string;
    size: number;
  };
  files: FontFile[];
  category: string;
  languages: string[];
  roles: string[];
  moods: string[];
  bestFor: string[];
  limitations?: string[];
  pairings?: FontPairing[];
  usage?: {
    hierarchy?: string;
    spacing?: string;
    locale?: string;
  };
  brandFit?: {
    traits?: string[];
    useWhen?: string[];
    mismatchRisks?: string[];
  };
  readability?: {
    readingUse?: string;
    risks?: string[];
    adjustment?: string;
  };
}

export interface FontSearchOptions {
  language?: string;
  role?: string;
  category?: string;
  query?: string;
}

export interface FontIndexRecord {
  id: string;
  family: string;
  category: string;
  languages: string[];
  roles: string[];
  moods: string[];
  best_for: string[];
  reading_use?: string;
  weights: string[];
}

const catalog = rawCatalog as { schemaVersion: number; fonts: FontEntry[] };

/** 返回全部精选字体条目。 */
export function allFonts(): readonly FontEntry[] {
  return catalog.fonts;
}

/** 按精确 id 查找字体（大小写不敏感）。 */
export function getFont(id: string): FontEntry | undefined {
  const key = id.trim().toLowerCase();
  return catalog.fonts.find((f) => f.id.toLowerCase() === key);
}

/** 按语言、角色、类别或关键词检索精选字体。 */
export function searchFonts(opts: FontSearchOptions = {}): FontEntry[] {
  const lang = opts.language?.trim().toLowerCase() ?? '';
  const role = opts.role?.trim().toLowerCase() ?? '';
  const category = opts.category?.trim().toLowerCase() ?? '';
  const query = opts.query?.trim().toLowerCase() ?? '';
  return catalog.fonts.filter((font) => {
    if (lang && !font.languages.some((l) => l.toLowerCase() === lang || l.toLowerCase().startsWith(lang + '-')))
      return false;
    if (role && !font.roles.some((r) => r.toLowerCase() === role)) return false;
    if (category && font.category.toLowerCase() !== category) return false;
    if (query) {
      const hay = [
        font.id,
        font.family,
        font.category,
        ...font.languages,
        ...font.roles,
        ...font.moods,
        ...font.bestFor,
        ...(font.brandFit?.traits ?? []),
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

/** 将字体条目压成紧凑索引记录（供列表与 JSONL 索引使用）。 */
export function toFontIndexRecord(font: FontEntry): FontIndexRecord {
  return {
    id: font.id,
    family: font.family,
    category: font.category,
    languages: font.languages,
    roles: font.roles,
    moods: font.moods,
    best_for: font.bestFor,
    reading_use: font.readability?.readingUse,
    weights: font.files.filter((f) => f.style === 'normal').map((f) => f.weight),
  };
}

/** 写出版本化 JSONL 字体索引文件，避免把整份大目录塞进上下文。 */
export function writeFontIndex(
  dir: string,
  fonts: readonly FontEntry[] = catalog.fonts,
): { path: string; version: string; count: number } {
  return writeJsonlIndex(dir, 'fonts', fonts.map(toFontIndexRecord));
}

/** 生成符合片场确定性渲染规范的 @font-face CSS（不写 font-display: swap/fallback/optional）。 */
export function fontFaceCss(family: string, relativePath: string, weight: string, style = 'normal'): string {
  const cleanRel = relativePath.replace(/\\/g, '/');
  const lower = cleanRel.toLowerCase();
  const format = lower.endsWith('.woff2')
    ? 'woff2'
    : lower.endsWith('.woff')
      ? 'woff'
      : lower.endsWith('.otf')
        ? 'opentype'
        : 'truetype';
  return [
    '@font-face {',
    `  font-family: '${family.replace(/'/g, "\\'")}';`,
    `  src: url('${cleanRel}') format('${format}');`,
    `  font-weight: ${weight};`,
    `  font-style: ${style};`,
    '  font-display: block;',
    '}',
  ].join('\n');
}
