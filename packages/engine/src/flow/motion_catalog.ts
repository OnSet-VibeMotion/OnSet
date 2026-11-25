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

export const MotionMenuPlaceholder = '{{MOTION_MENU}}';

const compactMenuGroups: readonly { title: string; ids: readonly string[] }[] = [
  { title: '文字与数据', ids: ['005', '006', '007', '008', '129', '133'] },
  {
    title: '图形与组件入场/强调',
    ids: ['001', '002', '003', '004', '010', '012', '021', '022', '023', '024', '143', '144'],
  },
  { title: '空间与运镜', ids: ['016', '025', '027', '028', '030', '032', '033'] },
  { title: '画内转场', ids: ['017', '018', '019', '020', '043', '137', '138', '139', '140', '141'] },
];

/**
 * 按制作意图分组的紧凑动效菜单（仅注入分镜规划阶段，控制极低 token 占用）。
 * 所有条目的名称从内置 catalog.json 动态核对，不硬编码不存在的 ID。
 */
export function compactMotionMenu(): string {
  const byId = new Map(bundledMotionCatalog().effects.map((e) => [e.id, e]));
  const lines = compactMenuGroups.map(({ title, ids }) => {
    const items = ids.map((id) => {
      const effect = byId.get(id);
      if (!effect) throw new Error(`内置动效目录缺少精选条目：${id}`);
      return `${effect.id} ${effect.name}`;
    });
    return `- **${title}**：${items.join(' / ')}`;
  });
  lines.push('其余内置与插件动效可用 `motion_effect_list()` 检索。');
  return lines.join('\n');
}

const motionSegmentRe = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/**
 * 规范化动效引用：支持简写如 "005"（自动补全为 "motion-prompt:005"）或完整 "来源:id"，
 * 统一小写并去空白。格式不合法时报错。
 */
export function normalizeMotionEffectRef(raw: string, where = ''): string {
  const prefix = where ? `${where}：` : '';
  const trimmed = raw.trim().replace(/^#/, '');
  if (!trimmed) throw new Error(`${prefix}动效标识不能为空`);
  const parts = trimmed.split(':');
  if (parts.length === 1) {
    if (!motionSegmentRe.test(parts[0])) {
      throw new Error(`${prefix}动效标识格式不合法 "${raw}"，请写成如 "005" 或 "motion-prompt:005"`);
    }
    return `${MotionPromptID}:${parts[0].toLowerCase()}`;
  }
  if (parts.length === 2) {
    const src = parts[0].trim();
    const id = parts[1].trim().replace(/^#/, '');
    if (!motionSegmentRe.test(src) || !motionSegmentRe.test(id)) {
      throw new Error(`${prefix}动效标识格式不合法 "${raw}"，请写成 "来源:编号"（如 "motion-prompt:005"）`);
    }
    return `${src.toLowerCase()}:${id.toLowerCase()}`;
  }
  throw new Error(`${prefix}动效标识格式不合法 "${raw}"，请写成如 "005" 或 "motion-prompt:005"`);
}

/** 规范化动效引用列表并去重保序。 */
export function normalizeMotionEffects(list: readonly string[] | null | undefined, where = ''): string[] {
  if (!list || list.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const norm = normalizeMotionEffectRef(item, where);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
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
