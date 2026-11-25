import crypto from 'node:crypto';
import path from 'node:path';
import { goTrimSpace } from '../gofmt';

/** 专栏目录内的配置文件与辅助文件。 */
export const ConfigFile = 'series.json';
export const BriefFile = 'brief.md';
export const DirectionsFile = 'directions.md';
export const PublishTemplateFile = 'publish-template.json';

/** 单期项目根目录内的专栏绑定文件。 */
export const BindingFile = 'onset.series.json';

/** 专栏 ID 约束：小写字母开头，只用小写字母、数字和短横线，最长 40 字符。 */
export const SeriesIdPattern = /^[a-z][a-z0-9-]{0,39}$/;

/** 默认期号目录命名模板。 */
export const DefaultNamingPattern = 'EP{nn}-{title}';

export const ValidAssetKinds = new Set([
  'shared',
  'cast',
  'bumper',
  'audio',
  'cover',
  'directions',
  'publish_template',
] as const);

export type AssetKind = 'shared' | 'cast' | 'bumper' | 'audio' | 'cover' | 'directions' | 'publish_template';

/** 专栏开片默认预设：新建下一期时自动带入，单期仍可覆盖。 */
export interface SeriesDefaults {
  canvas?: string;
  delivery?: string;
  narration?: string;
  film_style?: string;
  extra_film_styles?: string[];
  tts_voice?: string;
  brand_kit_id?: string;
  orchestrator?: string;
  renderer?: string;
}

/** 专栏配置（series.json）。 */
export interface SeriesConfig {
  schema: 1;
  id: string;
  name: string;
  description?: string;
  accent?: string;
  parent_dir?: string;
  naming_pattern?: string;
  next_episode: number;
  defaults: SeriesDefaults;
  created_at: string;
  updated_at: string;
}

/** 专栏级发布模板的写入入参。 */
export interface PublishTemplateInput {
  title_pattern?: string;
  default_hashtags?: string[];
  description_footer?: string;
  cover_guidelines?: string;
  credits_lines?: string[];
}

/** 创建专栏的入参。 */
export interface CreateSeriesInput {
  id?: string;
  name: string;
  description?: string;
  accent?: string;
  parent_dir?: string;
  naming_pattern?: string;
  next_episode?: number;
  defaults?: SeriesDefaults;
  brief?: string;
  publish_template?: PublishTemplateInput;
}

/** 更新专栏的局部补丁。 */
export interface UpdateSeriesPatch {
  name?: string;
  description?: string;
  accent?: string;
  parent_dir?: string;
  naming_pattern?: string;
  next_episode?: number;
  defaults?: SeriesDefaults;
  brief?: string;
  publish_template?: PublishTemplateInput;
}

/** 项目已从专栏拉取的一条资产同步记录。 */
export interface SyncedAssetRecord {
  kind: AssetKind;
  name: string;
  target_path: string;
  series_digest: string;
  synced_at: string;
}

/** 项目侧的专栏绑定文件（<project>/onset.series.json）。 */
export interface ProjectSeriesBinding {
  version: 1;
  series_id: string;
  series_name: string;
  episode?: number;
  bound_at: string;
  synced_assets: Record<string, SyncedAssetRecord>;
}

/** 校验专栏 ID，防路径穿越。 */
export function validateSeriesId(id: string): string {
  const clean = goTrimSpace(id);
  if (!SeriesIdPattern.test(clean)) {
    throw new Error('专栏标识须以小写字母开头，只含小写字母、数字与短横线，最长 40 位');
  }
  return clean;
}

/** 某个专栏在库里的目录路径。 */
export function seriesDir(rootDir: string, id: string): string {
  return path.join(rootDir, validateSeriesId(id));
}

/** 根据显示名生成安全 slug；纯非 ASCII 名称回退为 series-<8位短摘要>。 */
export function slugifySeriesId(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  if (ascii && /^[a-z]/.test(ascii)) return ascii;
  if (ascii && /^[0-9]/.test(ascii)) return `s-${ascii}`.slice(0, 40);
  const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `series-${hash}`;
}

/**
 * 按命名模板拼出带期号的项目名。支持 {nn}（两位补零）、{n}（数字）、{title}（基础标题）。
 * 未指定期号时原样返回清洗后的标题。
 */
export function formatEpisodeName(pattern: string | undefined, episode: number | undefined, title: string): string {
  const cleanTitle = sanitizeSegment(title) || 'untitled';
  if (episode === undefined || !Number.isInteger(episode) || episode < 1) return cleanTitle;
  const tpl = goTrimSpace(pattern ?? '') || DefaultNamingPattern;
  const nn = String(episode).padStart(2, '0');
  const n = String(episode);
  let out = tpl.replaceAll('{nn}', nn).replaceAll('{n}', n);
  out = out.includes('{title}') ? out.replaceAll('{title}', cleanTitle) : `${out}-${cleanTitle}`;
  return sanitizeSegment(out) || cleanTitle;
}

function sanitizeSegment(raw: string): string {
  return goTrimSpace(raw)
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
}
