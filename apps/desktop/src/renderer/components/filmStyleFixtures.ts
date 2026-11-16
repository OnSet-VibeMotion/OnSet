/*
 * 风格页、分镜页与镜头页的组件测试共用的风格目录（/api/film-styles，后端 studio/filmstyle.ts；只给 *.test.tsx 用）。
 * 一个来源、一个分类、两种风格：默认风格水彩笔刷与个别镜头用的中国水墨。
 */
import type { FilmStyle, FilmStyleManifest, FilmStylesResponse } from '../types';

const style = (slug: string, cn: string, en: string): FilmStyle => ({
  source: 'lemo-opuscar',
  slug,
  order: '01',
  cn,
  en,
  category_cn: '绘画',
  category_en: 'Painting',
  uses: ['叙事'],
  summary: `${cn}的笔触与材质`,
});

export const watercolorStyle = style('watercolor', '水彩笔刷', 'Watercolor Brush');
export const inkWashStyle = style('ink-wash', '中国水墨', 'Chinese Ink Wash');

export const filmStyles: FilmStylesResponse = {
  sources: [{ id: 'lemo-opuscar', name: 'LemoLab 风格库', categories: ['绘画'], ready: true }],
  styles: [watercolorStyle, inkWashStyle],
};

/** 装进项目时写的 onset-film-style.json。 */
export function manifest(s: FilmStyle): FilmStyleManifest {
  return { source: s.source, slug: s.slug, cn: s.cn, en: s.en, version: 'v1', digest: 'd', installed_at: '' };
}
