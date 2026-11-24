/**
 * 整片风格的格式化与展示辅助函数（由 filmstyle.ts 调用与再导出）。
 */
import * as filmstyle from '@onset/engine/filmstyle';
import { padRight } from './canvas';
import type { Out } from './cobra';

type FilmStyleSource = ReturnType<typeof filmstyle.sources>[number];
type SceneStyleEntry = ReturnType<typeof filmstyle.sceneStyles>[number];

export interface SourceStatus {
  id: string;
  name: string;
  location: string;
  ready: boolean;
  problem: string | undefined;
}

/** 帮助里列出的已登记来源。 */
export function sourceSummary(): string {
  return filmstyle
    .sources()
    .map((source) => {
      let line = '  ' + source.id() + '  ' + source.name();
      if (source.gallery() !== '') line += '，图鉴 ' + source.gallery();
      return line;
    })
    .join('\n');
}

/** Manifest 按字段顺序写成 JSON。 */
export function manifestJSON(m: filmstyle.Manifest): Record<string, unknown> {
  return {
    source: m.source,
    slug: m.slug,
    cn: m.cn,
    en: m.en,
    version: m.version,
    digest: m.digest,
    installed_at: m.installed_at,
  };
}

export function shortCommit(commit: string): string {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}

export function reportFilmStyle(stdout: Out, style: filmstyle.Style, result: filmstyle.InstallResult): void {
  if (result.unchanged) stdout.write(`整片风格已是 ${filmstyle.styleLabel(style)}，未改动\n`);
  else if (result.replaced) {
    stdout.write(`整片风格已从 ${result.replaced} 换成 ${filmstyle.styleLabel(style)}；已渲染的镜头会被判为 Stale\n`);
  } else {
    stdout.write(`整片风格已设为 ${filmstyle.styleLabel(style)}（版本 ${shortCommit(result.manifest.version)}）\n`);
  }
}

export function styleMatcher(categoryFilter: string, queryFilter: string): (style: filmstyle.Style) => boolean {
  return (style: filmstyle.Style): boolean => {
    if (categoryFilter !== '' && !`${style.category_cn} ${style.category_en}`.toLowerCase().includes(categoryFilter)) {
      return false;
    }
    if (queryFilter !== '') {
      const hay = [
        filmstyle.styleKey(style),
        style.cn,
        style.en,
        style.category_cn,
        ...(style.uses ?? []),
        ...(style.tags ?? []),
        style.summary,
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(queryFilter)) return false;
    }
    return true;
  };
}

export function writeCompactStyleList(out: Out, styles: readonly filmstyle.Style[], current: string): void {
  for (const style of styles) {
    const key = filmstyle.styleKey(style);
    const mark = key === current ? '*' : '';
    const uses = (style.uses ?? []).slice(0, 3).join('/');
    const brief = style.summary.length > 48 ? style.summary.slice(0, 48) + '…' : style.summary;
    out.write(`${mark}${key} | ${style.cn} | ${uses ? uses + ' | ' : ''}${brief}\n`);
  }
  if (styles.length === 0) out.write('（没有匹配的风格）\n');
}

export function writeFullStyleList(
  out: Out,
  sources: readonly FilmStyleSource[],
  matches: (style: filmstyle.Style) => boolean,
  current: string,
  extras: ReadonlySet<string>,
): void {
  for (const source of sources) {
    const catalog = source.catalog().filter(matches);
    if (catalog.length === 0) continue;
    out.write(`== ${source.id()}  ${source.name()}\n`);
    if (source.gallery() !== '') out.write(`   图鉴：${source.gallery()}\n`);
    for (const category of filmstyle.categories(source.id())) {
      const group = catalog.filter((style) => style.category_cn === category);
      if (group.length === 0) continue;
      out.write(`${category}\n`);
      for (const style of group) {
        const key = filmstyle.styleKey(style);
        const mark = key === current ? '*' : extras.has(key) ? '+' : ' ';
        const extra = style.tags && style.tags.length > 0 ? '  [' + style.tags.join(', ') + ']' : '';
        out.write(` ${mark} ${padRight(filmstyle.styleKey(style), 34)} ${style.cn} ${style.en}${extra}\n`);
        out.write(`      适合：${(style.uses ?? []).join(', ')}；${style.summary}\n`);
      }
    }
    out.write('\n');
  }
  if (current !== '') out.write('* 为本项目的默认风格\n');
  if (extras.size > 0) out.write('+ 为本项目装的额外风格（镜头点名用）\n');
}

export function collectSourceStatuses(env: Record<string, string>): SourceStatus[] {
  return filmstyle.sources().map((source) => {
    let ready = true;
    let problem = '';
    try {
      source.check(env);
    } catch (err) {
      ready = false;
      problem = (err as Error).message;
    }
    return {
      id: source.id(),
      name: source.name(),
      location: source.location(env),
      ready,
      problem: problem || undefined,
    };
  });
}

export function writeFilmStyleShow(
  out: Out,
  params: {
    isInstalled: boolean;
    manifest: filmstyle.Manifest;
    defaultKey: string;
    skillDirPath: string;
    extras: readonly filmstyle.Manifest[];
    scenes: readonly SceneStyleEntry[];
    sources: readonly SourceStatus[];
  },
): void {
  const { isInstalled, manifest, defaultKey, skillDirPath, extras, scenes, sources } = params;
  const usedBy = (value: string) => scenes.filter((s) => s.film_style === value).map((s) => s.id);
  const users = (ids: string[]) => (ids.length === 0 ? '没有镜头' : ids.join('、'));
  if (isInstalled) {
    out.write(
      `默认风格：${manifest.cn} ${manifest.en}（${defaultKey}），版本 ${shortCommit(manifest.version)}\n技能目录：${skillDirPath}\n`,
    );
    if (scenes.length > 0) out.write(`  使用：${users([...usedBy(''), ...usedBy(defaultKey)])}\n`);
  } else {
    out.write('默认风格：无（不写 film_style 的镜头自主定视觉）。用 film_style_list() 查看可选风格\n');
  }
  for (const m of extras) {
    const key = filmstyle.manifestKey(m);
    out.write(`额外风格：${m.cn} ${m.en}（${key}），版本 ${shortCommit(m.version)}\n  使用：${users(usedBy(key))}\n`);
  }
  const none = usedBy(filmstyle.NoFilmStyle);
  if (none.length > 0) out.write(`不用整片风格的镜头：${none.join('、')}\n`);
  const installedKeys = new Set([defaultKey, ...extras.map(filmstyle.manifestKey)]);
  for (const s of scenes) {
    if (s.film_style !== '' && s.film_style !== filmstyle.NoFilmStyle && !installedKeys.has(s.film_style)) {
      out.write(
        `注意：镜头 ${s.id} 点名的 ${s.film_style} 没装进项目，渲染会失败；运行 film_style_add({"style": "${s.film_style}"})\n`,
      );
    }
  }
  for (const item of sources) {
    const state = item.ready ? '已就绪' : '未准备（在客户端的工具准备页安装）';
    out.write(`风格来源 ${item.id}：${state}，${item.location}\n`);
  }
}
