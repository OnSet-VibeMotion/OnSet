/**
 * 内置动效库（assets/motion-prompt/catalog.json）与已安装第三方插件动效的统一查询。
 * 客户端「动效」页与 onset 工具服务（motion_effect_list / motion_effect_show）共用这一份口径。
 */
import { files } from '../assets';
import { loadStations } from './load';
import { type MotionEffect, MotionPromptID } from './motion';

export interface BundledMotionEffect extends MotionEffect {
  pack: string;
  cell: number;
}

export interface BundledMotionCatalog {
  version: string;
  effects: BundledMotionEffect[];
}

export interface MotionEffectSource {
  id: string;
  name: string;
  version: string;
  effects: MotionEffect[];
}

export interface MotionEffectHit {
  ref: string;
  source: MotionEffectSource;
  effect: MotionEffect;
}

export function bundledMotionCatalog(): BundledMotionCatalog {
  return JSON.parse(files().sub('motion-prompt').readText('catalog.json')) as BundledMotionCatalog;
}

/** 列出内置 Motion Prompt 与全部已安装第三方插件提供的动效来源。 */
export function listMotionSources(env?: Record<string, string>): MotionEffectSource[] {
  const { version, effects } = bundledMotionCatalog();
  const bundled: MotionEffectSource = {
    id: MotionPromptID,
    name: 'Motion Prompt',
    version,
    effects: effects.map(({ pack: _pack, cell: _cell, ...effect }) => effect),
  };
  const installed = loadStations(env)
    .stations.filter(({ manifest }) => manifest.motion_effects.length > 0)
    .map(({ manifest, entry }) => ({
      id: manifest.id,
      name: manifest.name,
      version: entry.commit || manifest.version,
      effects: manifest.motion_effects,
    }));
  return [bundled, ...installed];
}

/** 按来源、分类、关键词筛选动效条目（关键词按空白分词，须全部命中）。 */
export function filterMotionEffects(
  sources: readonly MotionEffectSource[],
  options: { source?: string; category?: string; query?: string } = {},
): MotionEffectHit[] {
  const sourceFilter = (options.source ?? '').trim().toLowerCase();
  const categoryFilter = (options.category ?? '').trim().toLowerCase();
  const terms = (options.query ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^#/, ''))
    .filter(Boolean);
  const hits: MotionEffectHit[] = [];
  for (const source of sources) {
    if (sourceFilter && source.id.toLowerCase() !== sourceFilter) continue;
    for (const effect of source.effects) {
      if (categoryFilter && !effect.category.toLowerCase().includes(categoryFilter)) continue;
      const ref = `${source.id}:${effect.id}`;
      if (terms.length > 0) {
        const haystack = [
          ref,
          source.name,
          effect.id,
          effect.name,
          effect.category,
          effect.summary,
          ...(effect.aliases ?? []),
        ]
          .join(' ')
          .toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) continue;
      }
      hits.push({ ref, source, effect });
    }
  }
  return hits;
}

/**
 * 按标识或名称定位一条动效：支持完整「来源:编号」（如 motion-prompt:005）、
 * 唯一编号（如 005）、中文名或精确别名。多条重名时报错并列出候选完整标识。
 */
export function lookupMotionEffect(
  refInput: string,
  sources: readonly MotionEffectSource[] = listMotionSources(),
): MotionEffectHit {
  const raw = refInput.trim().replace(/^#/, '');
  if (!raw) throw new Error('动效标识不能为空，请传如 "motion-prompt:005" 或中文名');
  const lower = raw.toLowerCase();
  const all: MotionEffectHit[] = sources.flatMap((source) =>
    source.effects.map((effect) => ({ ref: `${source.id}:${effect.id}`, source, effect })),
  );

  // 1) 完整 ref（来源:编号）精确匹配
  const byRef = all.find((item) => item.ref.toLowerCase() === lower);
  if (byRef) return byRef;

  // 2) 编号、名称或精确别名匹配
  const candidates = all.filter(
    ({ effect }) =>
      effect.id.toLowerCase() === lower ||
      effect.name.toLowerCase() === lower ||
      (effect.aliases ?? []).some((a) => a.toLowerCase() === lower),
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const list = candidates.map((c) => `${c.ref}（${c.effect.name}）`).join('、');
    throw new Error(`动效 "${refInput}" 在多个来源中重名，请写完整标识：${list}`);
  }
  throw new Error(`找不到动效 "${refInput}"，请先用 motion_effect_list({"query": "..."}) 检索`);
}
