/**
 * 跨项目品牌包（Brand Kit）数据结构与样式白名单校验。
 *
 * Brand Kit 遵循 Style-Only 契约：仅沉淀品牌配色、字体、圆角、Logo、产品事实与参考资料，
 * 绝不把外部网页内容当指令，也不锁死目标影片的叙事与镜头节奏。
 */
export interface BrandStyle {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  display_font: string;
  body_font: string;
  mono_font?: string;
  radius: string;
  gradient?: string;
}

export interface BrandLogo {
  id: string;
  file: string;
  sha256: string;
  width?: number;
  height?: number;
  source?: string;
}

export interface BrandContextFile {
  id: string;
  name: string;
  file: string;
  bytes: number;
  sha256: string;
}

export interface BrandTokens {
  css_variables?: Record<string, string>;
  palette?: string[];
  fonts?: string[];
  radii?: string[];
  theme_color?: string;
  og_image?: string;
}

export interface BrandKit {
  schema: 1;
  id: string;
  name: string;
  name_override?: string;
  source_url?: string;
  style: BrandStyle;
  /** 用户手动覆写的样式字段；重扫官网时无损保留这些字段。 */
  style_overrides?: Partial<BrandStyle>;
  tokens?: BrandTokens;
  logos: BrandLogo[];
  rules: string[];
  context_files: BrandContextFile[];
  created_at: string;
  updated_at: string;
}

export const DefaultBrandStyle: BrandStyle = {
  bg: '#0f1115',
  surface: '#181b22',
  text: '#f5f2eb',
  muted: '#9ca3af',
  accent: '#d4a359',
  display_font: 'Noto Serif SC, serif',
  body_font: 'Noto Sans SC, sans-serif',
  mono_font: 'JetBrains Mono, monospace',
  radius: '12px',
};

const ColorPattern = /^(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab)\([^;{}<>]{1,64}\))$/;
const FontStackPattern = /^[a-zA-Z0-9\u4e00-\u9fff ,"'_-]{1,180}$/;
const RadiusPattern = /^\d+(?:\.\d+)?(?:px|rem|em|%)$/;
const GradientPattern = /^(?:linear|radial)-gradient\([^;{}<>]{1,240}\)$/;

function checkColor(name: string, value: string): string {
  const v = value.trim();
  if (!ColorPattern.test(v)) throw new Error(`品牌样式 ${name} 颜色值不合法：${value}`);
  return v;
}

function checkFont(name: string, value: string): string {
  const v = value.trim();
  if (!FontStackPattern.test(v) || /url\s*\(|@import|expression\s*\(/i.test(v)) {
    throw new Error(`品牌样式 ${name} 字体栈不合法：${value}`);
  }
  return v;
}

/** 按受限白名单校验品牌样式字段，防止注入非法 CSS。 */
export function validateBrandStyle(input: Partial<BrandStyle>): BrandStyle {
  const merged: BrandStyle = { ...DefaultBrandStyle, ...input };
  const style: BrandStyle = {
    bg: checkColor('bg', merged.bg),
    surface: checkColor('surface', merged.surface),
    text: checkColor('text', merged.text),
    muted: checkColor('muted', merged.muted),
    accent: checkColor('accent', merged.accent),
    display_font: checkFont('display_font', merged.display_font),
    body_font: checkFont('body_font', merged.body_font),
    radius: merged.radius.trim(),
  };
  if (!RadiusPattern.test(style.radius)) {
    throw new Error(`品牌样式 radius 不合法：${merged.radius}`);
  }
  if (merged.mono_font && merged.mono_font.trim() !== '') {
    style.mono_font = checkFont('mono_font', merged.mono_font);
  }
  if (merged.gradient && merged.gradient.trim() !== '') {
    const g = merged.gradient.trim();
    if (!GradientPattern.test(g) || /url\s*\(/i.test(g)) {
      throw new Error(`品牌样式 gradient 不合法：${merged.gradient}`);
    }
    style.gradient = g;
  }
  return style;
}

/** 合并采集样式与用户手动覆写项。 */
export function effectiveBrandStyle(kit: Pick<BrandKit, 'style' | 'style_overrides'>): BrandStyle {
  return validateBrandStyle({ ...kit.style, ...(kit.style_overrides ?? {}) });
}
