/**
 * MG 动效风格库（MIT）的目录数据与查询函数。
 *
 * 源自 MIT 许可项目 Vincentwei1021/mg-styles-15，精炼收录全部 15 套非 Blender 的
 * 高完成度 MG 视觉风格（3 套 Three.js 真 3D + 3 套 WebGL2 着色器 + 9 套 Canvas2D 逐帧绘制）。
 * 全部规范内嵌随包下发，开箱即用不联网；离线参考帧通过 ONSET_FILM_STYLE_REFS_DIR 按需挂接。
 */
import type { EngineContract, Style } from '../../filmstyle';
import rawCatalog from './catalog.json';

export const SourceID = 'mg-styles';
export const SourceName = 'MG 动效风格库（MIT）';
export const UpstreamRepo = 'Vincentwei1021/mg-styles-15';
export const LicenseName = 'MIT';
export const PinnedVersion = 'mg-styles-15@mit-1.0';
export const PinnedStyleCount = 15;

export interface MgPalette {
  bg: string;
  surface: string;
  primary: string;
  secondary: string;
  accent: string;
  ink: string;
}

export interface MgEffectRecipes {
  transition: string;
  impact: string;
  camera: string;
  grain: string;
  secondary: string;
}

export interface MgStyleEntry {
  slug: string;
  order: string;
  cn: string;
  en: string;
  category_cn: string;
  category_en: string;
  uses: string[];
  summary: string;
  tags: string[];
  engine_contract: EngineContract;
  motion_effects: string[];
  palette: MgPalette;
  typography: string;
  composition: string;
  texture: string;
  motion_grammar: string;
  recipes: MgEffectRecipes;
  taboos: string[];
}

interface CatalogDocument {
  source: string;
  license: string;
  upstream: string;
  version: string;
  styles: MgStyleEntry[];
}

const doc = rawCatalog as CatalogDocument;

export function catalog(): MgStyleEntry[] {
  return doc.styles.map((s) => ({
    ...s,
    uses: [...s.uses],
    tags: [...s.tags],
    motion_effects: [...s.motion_effects],
    engine_contract: { ...s.engine_contract, required: [...s.engine_contract.required] },
    palette: { ...s.palette },
    recipes: { ...s.recipes },
    taboos: [...s.taboos],
  }));
}

export function find(slug: string): MgStyleEntry | undefined {
  return doc.styles.find((s) => s.slug === slug);
}

export function entryStyle(entry: MgStyleEntry): Style {
  return {
    source: SourceID,
    slug: entry.slug,
    order: entry.order,
    cn: entry.cn,
    en: entry.en,
    category_cn: entry.category_cn,
    category_en: entry.category_en,
    uses: [...entry.uses],
    summary: entry.summary,
    tags: entry.tags.length > 0 ? [...entry.tags] : undefined,
    motion_effects: [...entry.motion_effects],
    engine_contract: { ...entry.engine_contract, required: [...entry.engine_contract.required] },
  };
}
