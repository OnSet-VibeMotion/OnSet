import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, removeTree } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { type ExtractedBrandResult, extractBrandFromUrl } from './extract';
import type { DnsResolverDeps } from './network';
import {
  type BrandContextFile,
  type BrandKit,
  type BrandLogo,
  type BrandStyle,
  effectiveBrandStyle,
  validateBrandStyle,
} from './types';

export const BrandKitsDirEnv = 'ONSET_BRAND_KITS_DIR';
export const ProjectBrandKitRelPath = path.join('production', 'brand-kit.json');

const MaxContextFileBytes = 8 * 1024 * 1024;
const MaxContextFilesPerKit = 32;

/** 用户级跨项目品牌包目录（所有项目共享，与音色库同级）。 */
export function defaultBrandKitsDir(env: Record<string, string | undefined> = process.env): string {
  if (env[BrandKitsDirEnv]) return path.resolve(env[BrandKitsDirEnv]!);
  const xdg = env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'onset', 'brand-kits');
  const home = env.HOME || os.homedir();
  return path.join(home, '.local', 'share', 'onset', 'brand-kits');
}

function safeKitId(id: string): string {
  const clean = id.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(clean)) {
    throw new Error(`非法品牌包 ID：${id}`);
  }
  return clean;
}

function kitDir(root: string, id: string): string {
  return path.join(root, safeKitId(id));
}

function kitFile(root: string, id: string): string {
  return path.join(kitDir(root, id), 'brand-kit.json');
}

function slugId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${base || 'brand'}-${crypto.randomBytes(3).toString('hex')}`;
}

/** 列出全部已保存品牌包（按更新时间降序）。 */
export function listBrandKits(root: string): BrandKit[] {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
  const kits: BrandKit[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'brand-kit.json');
    if (!fs.existsSync(file)) continue;
    try {
      kits.push(JSON.parse(fs.readFileSync(file, 'utf8')) as BrandKit);
    } catch {
      // 忽略损坏目录
    }
  }
  return kits.sort((a, b) => (a.updated_at > b.updated_at ? -1 : a.updated_at < b.updated_at ? 1 : 0));
}

/** 按 ID 读取单个品牌包。 */
export function getBrandKit(root: string, id: string): BrandKit | undefined {
  const file = kitFile(root, id);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as BrandKit;
}

export interface SaveBrandKitInput {
  id?: string;
  name: string;
  source_url?: string;
  style?: Partial<BrandStyle>;
  style_overrides?: Partial<BrandStyle>;
  rules?: string[];
  expected_updated_at?: string;
}

/** 创建或更新品牌包（更新时支持 expected_updated_at 乐观锁，并保留用户覆写项与上下文附件）。 */
export function saveBrandKit(root: string, input: SaveBrandKitInput): BrandKit {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new Error('品牌包名称必须在 1–80 字符内');
  const now = new Date().toISOString();

  if (input.id) {
    const existing = getBrandKit(root, input.id);
    if (!existing) throw new Error(`找不到品牌包：${input.id}`);
    if (input.expected_updated_at && existing.updated_at !== input.expected_updated_at) {
      throw new Error('BRAND_KIT_CHANGED：品牌包已被其他操作修改，请重新读取后再保存');
    }
    const nextOverrides: Partial<BrandStyle> = {
      ...(existing.style_overrides ?? {}),
      ...(input.style_overrides ?? {}),
    };
    const baseStyle = input.style ? validateBrandStyle({ ...existing.style, ...input.style }) : existing.style;
    // 校验合并后的最终样式
    validateBrandStyle({ ...baseStyle, ...nextOverrides });
    const updated: BrandKit = {
      ...existing,
      name,
      name_override: name !== existing.name ? name : existing.name_override,
      source_url: input.source_url ?? existing.source_url,
      style: baseStyle,
      style_overrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
      rules: input.rules !== undefined ? input.rules.map((r) => r.trim()).filter(Boolean) : existing.rules,
      updated_at: now,
    };
    atomicWrite(kitFile(root, updated.id), marshalIndent(updated) + '\n', 0o644);
    return updated;
  }

  const id = slugId(name);
  const style = validateBrandStyle(input.style ?? {});
  const created: BrandKit = {
    schema: 1,
    id,
    name,
    source_url: input.source_url,
    style,
    style_overrides: input.style_overrides,
    logos: [],
    rules: (input.rules ?? []).map((r) => r.trim()).filter(Boolean),
    context_files: [],
    created_at: now,
    updated_at: now,
  };
  atomicWrite(kitFile(root, id), marshalIndent(created) + '\n', 0o644);
  return created;
}

/** 从公开官网 URL 提取并保存为新品牌包，或重扫已有品牌包（无损保留 name_override / style_overrides / rules / context_files）。 */
export async function extractAndSaveBrandKit(
  root: string,
  url: string,
  opts: {
    kitId?: string;
    expectedUpdatedAt?: string;
    deps?: DnsResolverDeps;
    signal?: AbortSignal;
    extractor?: (url: string) => Promise<ExtractedBrandResult>;
  } = {},
): Promise<BrandKit> {
  const extracted = opts.extractor
    ? await opts.extractor(url)
    : await extractBrandFromUrl(url, { deps: opts.deps, signal: opts.signal });
  const now = new Date().toISOString();

  if (opts.kitId) {
    const existing = getBrandKit(root, opts.kitId);
    if (!existing) throw new Error(`找不到品牌包：${opts.kitId}`);
    if (opts.expectedUpdatedAt && existing.updated_at !== opts.expectedUpdatedAt) {
      throw new Error('BRAND_KIT_CHANGED：品牌包已被修改，请重新读取后再重扫');
    }
    const updated: BrandKit = {
      ...existing,
      name: existing.name_override || extracted.name,
      source_url: extracted.source_url,
      style: extracted.style,
      tokens: extracted.tokens,
      updated_at: now,
    };
    atomicWrite(kitFile(root, updated.id), marshalIndent(updated) + '\n', 0o644);
    return updated;
  }

  const id = slugId(extracted.name);
  const created: BrandKit = {
    schema: 1,
    id,
    name: extracted.name,
    source_url: extracted.source_url,
    style: extracted.style,
    tokens: extracted.tokens,
    logos: [],
    rules: [],
    context_files: [],
    created_at: now,
    updated_at: now,
  };
  atomicWrite(kitFile(root, id), marshalIndent(created) + '\n', 0o644);
  return created;
}

/** 给品牌包添加一个惰性参考附件（Logo 或品牌资料，单文件 ≤ 8 MiB，每包 ≤ 32 个）。 */
export function addBrandAttachment(
  root: string,
  kitId: string,
  kind: 'logo' | 'context',
  sourcePath: string,
  displayName?: string,
): BrandKit {
  const kit = getBrandKit(root, kitId);
  if (!kit) throw new Error(`找不到品牌包：${kitId}`);
  const st = fs.statSync(sourcePath);
  if (!st.isFile()) throw new Error(`不是常规文件：${sourcePath}`);
  if (st.size > MaxContextFileBytes) throw new Error('单个品牌附件不得超过 8 MiB');
  if (kind === 'context' && kit.context_files.length >= MaxContextFilesPerKit) {
    throw new Error(`每个品牌包最多保留 ${MaxContextFilesPerKit} 个参考附件`);
  }

  const bytes = fs.readFileSync(sourcePath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const ext = path.extname(sourcePath).toLowerCase() || '.bin';
  const itemId = crypto.randomUUID().slice(0, 12);
  const relFile = `${kind === 'logo' ? 'logos' : 'context'}/${itemId}${ext}`;
  const dest = path.join(kitDir(root, kitId), ...relFile.split('/'));
  atomicWrite(dest, bytes, 0o644);

  const now = new Date().toISOString();
  if (kind === 'logo') {
    const logo: BrandLogo = { id: itemId, file: relFile, sha256, source: displayName || path.basename(sourcePath) };
    kit.logos = [...kit.logos, logo];
  } else {
    const ctx: BrandContextFile = {
      id: itemId,
      name: displayName || path.basename(sourcePath),
      file: relFile,
      bytes: bytes.length,
      sha256,
    };
    kit.context_files = [...kit.context_files, ctx];
  }
  kit.updated_at = now;
  atomicWrite(kitFile(root, kitId), marshalIndent(kit) + '\n', 0o644);
  return kit;
}

/** 删除品牌包。 */
export function deleteBrandKit(root: string, id: string): void {
  const dir = kitDir(root, id);
  if (!fs.existsSync(dir)) throw new Error(`找不到品牌包：${id}`);
  removeTree(dir);
}

export interface AppliedProjectBrandKit {
  style_only: true;
  kit_id: string;
  name: string;
  source_url?: string;
  applied_at: string;
  style: BrandStyle;
  rules: string[];
  logos: string[];
}

/**
 * 将品牌包以 Style-Only 契约挂载到指定项目：
 * 写出 production/brand-kit.json 并把 Logo 拷进项目 assets/brand/。
 */
export function applyBrandKitToProject(root: string, kitId: string, projectRoot: string): AppliedProjectBrandKit {
  const kit = getBrandKit(root, kitId);
  if (!kit) throw new Error(`找不到品牌包：${kitId}`);
  const style = effectiveBrandStyle(kit);
  const copiedLogos: string[] = [];

  for (const logo of kit.logos) {
    const src = path.join(kitDir(root, kitId), ...logo.file.split('/'));
    if (!fs.existsSync(src)) continue;
    const relDest = `assets/brand/${path.basename(logo.file)}`;
    atomicWrite(path.join(projectRoot, ...relDest.split('/')), fs.readFileSync(src), 0o644);
    copiedLogos.push(relDest);
  }

  const applied: AppliedProjectBrandKit = {
    style_only: true,
    kit_id: kit.id,
    name: kit.name,
    source_url: kit.source_url,
    applied_at: new Date().toISOString(),
    style,
    rules: kit.rules,
    logos: copiedLogos,
  };
  atomicWrite(path.join(projectRoot, ProjectBrandKitRelPath), marshalIndent(applied) + '\n', 0o644);
  return applied;
}

/** 读取项目当前挂载的品牌包快照（未挂载时返回 null）。 */
export function readProjectBrandKit(projectRoot: string): AppliedProjectBrandKit | null {
  const file = path.join(projectRoot, ProjectBrandKitRelPath);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AppliedProjectBrandKit;
  } catch {
    return null;
  }
}

/** 生成可注入分镜与渲染提示词的 Style-Only 品牌视觉段。 */
export function brandKitPromptSection(applied: AppliedProjectBrandKit): string {
  const s = applied.style;
  const lines = [
    `## 品牌包约束（仅视觉与产品事实，不锁死镜头节奏）`,
    `- 品牌名称：${applied.name}${applied.source_url ? `（来源：${applied.source_url}）` : ''}`,
    `- 配色：底色 ${s.bg}、卡片/面板 ${s.surface}、主字色 ${s.text}、辅字色 ${s.muted}、强调色 ${s.accent}`,
    `- 字体：标题 ${s.display_font}；正文 ${s.body_font}${s.mono_font ? `；等宽 ${s.mono_font}` : ''}；圆角 ${s.radius}`,
  ];
  if (applied.logos.length > 0) {
    lines.push(`- 品牌 Logo 文件：${applied.logos.join('、')}`);
  }
  if (applied.rules.length > 0) {
    lines.push('- 品牌事实与规则：');
    for (const r of applied.rules) lines.push(`  - ${r}`);
  }
  lines.push('- 注意：以上仅约束视觉身份与真实品牌事实；叙事结构、镜头时长与动效节奏仍按本项目分镜计划执行。');
  return lines.join('\n');
}
