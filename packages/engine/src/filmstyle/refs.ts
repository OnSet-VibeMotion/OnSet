/**
 * 离线本地风格参考帧检索与 SHA-256 校验。
 *
 * ~40MB 级别的高清风格参考帧不提交进 git 仓库，而是由用户在本地目录存放：
 *   <refs_dir>/<slug>/*.{png,jpg,jpeg,webp}
 * 可选附带 <refs_dir>/<slug>/manifest.json 或 <refs_dir>/manifest.json 记录 SHA-256 校验和。
 *
 * 严格防护路径穿越与符号链接逃逸；未配置目录或目录不存在时优雅降级，不阻断制作流程。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';

/** 指定本地风格参考帧根目录的环境变量。 */
export const RefsDirEnv = 'ONSET_FILM_STYLE_REFS_DIR';

const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const safeSlugRe = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const sha256Re = /^(?:sha256:)?([a-f0-9]{64})$/i;

export interface RefFrame {
  file: string;
  path: string;
  size_bytes: number;
  sha256?: string;
  expected_sha256?: string;
  verified?: boolean;
  mismatch?: boolean;
}

export interface RefMismatch {
  file: string;
  expected: string;
  actual: string;
}

export interface RefsResult {
  available: boolean;
  slug: string;
  refs_dir: string;
  frames: RefFrame[];
  manifest_checked: boolean;
  mismatches: RefMismatch[];
  hint?: string;
}

export interface RefsOptions {
  /** 显式参考帧根目录，优先于环境变量 ONSET_FILM_STYLE_REFS_DIR。 */
  refsDir?: string;
  /** 读取环境变量的映射，默认 process.env。 */
  env?: Record<string, string | undefined>;
  /** 存在 manifest.json 时是否校验 SHA-256（默认 true）。 */
  verify?: boolean;
}

/** 校验并归一化风格 slug（允许传 "mg-styles/03-isometric" 或 "03-isometric"），严格拦截路径穿越。 */
export function normalizeRefSlug(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('风格标识不能为空');
  if (trimmed.includes('\0') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error(`非法的风格参考帧路径（禁止路径穿越）：${input}`);
  }
  const parts = trimmed.split('/');
  if (parts.length > 2) throw new Error(`非法的风格参考帧路径（禁止多级路径）：${input}`);
  const slug = parts.length === 2 ? parts[1] : parts[0];
  if (parts.length === 2 && !safeSlugRe.test(parts[0])) {
    throw new Error(`非法的风格来源标识：${input}`);
  }
  if (!safeSlugRe.test(slug)) {
    throw new Error(`非法的风格参考帧目录名：${input}`);
  }
  return slug;
}

/** 解析参考帧根目录：显式参数优先于环境变量。 */
export function resolveRefsRoot(opts: RefsOptions = {}): string {
  const explicit = (opts.refsDir ?? '').trim();
  if (explicit) return path.resolve(explicit);
  const env = opts.env ?? process.env;
  const fromEnv = (env[RefsDirEnv] ?? '').trim();
  return fromEnv ? path.resolve(fromEnv) : '';
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(rootReal, candidateReal);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertContained(rootReal: string, targetPath: string, label: string): string {
  let targetReal: string;
  try {
    targetReal = fs.realpathSync(targetPath);
  } catch (err) {
    throw new Error(`无法解析参考帧路径 ${label}：${(err as Error).message}`, { cause: err });
  }
  if (!isInsideRoot(rootReal, targetReal)) {
    throw new Error(`安全拦截：参考帧路径越界逃逸出根目录（${label}）`);
  }
  return targetReal;
}

function normalizeSha256(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const m = sha256Re.exec(raw.trim());
  return m ? m[1].toLowerCase() : '';
}

/**
 * 读取可选 manifest.json，兼容两种位置（<slug>/manifest.json 优先于 <root>/manifest.json）
 * 以及对象映射 / files 数组 / files 对象三种常见结构。
 */
function loadManifestChecksums(rootReal: string, styleDirReal: string, slug: string): Map<string, string> | null {
  const candidates = [path.join(styleDirReal, 'manifest.json'), path.join(rootReal, 'manifest.json')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const real = assertContained(rootReal, file, path.basename(file));
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(real, 'utf8'));
    } catch (err) {
      throw new Error(`参考帧 manifest.json 格式损坏：${(err as Error).message}`, { cause: err });
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('参考帧 manifest.json 顶层必须是 JSON 对象');
    }
    const map = new Map<string, string>();
    const obj = raw as Record<string, unknown>;
    const addEntry = (key: string, hashVal: unknown) => {
      const hash = normalizeSha256(hashVal);
      if (!hash) return;
      const clean = key.replace(/\\/g, '/').replace(/^\.\//, '');
      if (clean.startsWith(`${slug}/`)) {
        map.set(clean.slice(slug.length + 1), hash);
      } else if (!clean.includes('/')) {
        map.set(clean, hash);
      }
    };
    const filesField = obj.files;
    if (Array.isArray(filesField)) {
      for (const item of filesField) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          const name = typeof rec.file === 'string' ? rec.file : typeof rec.path === 'string' ? rec.path : '';
          if (name) addEntry(name, rec.sha256);
        }
      }
    } else if (filesField && typeof filesField === 'object') {
      for (const [k, v] of Object.entries(filesField as Record<string, unknown>)) {
        addEntry(k, typeof v === 'string' ? v : (v as Record<string, unknown> | null)?.sha256);
      }
    } else {
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'version' || k === 'schema' || k === 'generated_at') continue;
        addEntry(k, typeof v === 'string' ? v : (v as Record<string, unknown> | null)?.sha256);
      }
    }
    return map;
  }
  return null;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function unavailable(slug: string, refsDir: string, hint: string): RefsResult {
  return { available: false, slug, refs_dir: refsDir, frames: [], manifest_checked: false, mismatches: [], hint };
}

/** 列出指定风格的本地离线参考帧，并在存在 manifest.json 时校验 SHA-256。 */
export function listStyleRefs(styleOrSlug: string, opts: RefsOptions = {}): RefsResult {
  const slug = normalizeRefSlug(styleOrSlug);
  const refsDir = resolveRefsRoot(opts);
  if (!refsDir) {
    return unavailable(
      slug,
      '',
      `未配置本地参考帧目录：请设置环境变量 ${RefsDirEnv} 或传入 refs_dir 参数，按 <refs_dir>/<slug>/*.{png,jpg,webp} 组织参考帧。`,
    );
  }
  if (!fs.existsSync(refsDir)) {
    return unavailable(slug, refsDir, `本地参考帧目录不存在：${refsDir}（不会阻断制作，准备好参考帧后可再次查询）。`);
  }
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(refsDir);
    if (!fs.statSync(rootReal).isDirectory()) {
      return unavailable(slug, refsDir, `参考帧路径不是目录：${refsDir}`);
    }
  } catch {
    return unavailable(slug, refsDir, `无法访问参考帧目录：${refsDir}`);
  }

  const styleDirPath = path.join(rootReal, slug);
  if (!fs.existsSync(styleDirPath)) {
    return unavailable(
      slug,
      rootReal,
      `目录 ${rootReal} 下没有风格 ${slug} 的参考帧子目录（期望 ${path.join(rootReal, slug)}）。`,
    );
  }
  const styleDirReal = assertContained(rootReal, styleDirPath, slug);
  if (!fs.statSync(styleDirReal).isDirectory()) {
    return unavailable(slug, rootReal, `风格参考帧路径不是目录：${styleDirPath}`);
  }

  const shouldVerify = opts.verify !== false;
  const checksums = shouldVerify ? loadManifestChecksums(rootReal, styleDirReal, slug) : null;
  const entries = fs.readdirSync(styleDirReal, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));

  const frames: RefFrame[] = [];
  const mismatches: RefMismatch[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!imageExts.has(ext)) continue;
    const candidate = path.join(styleDirReal, entry.name);
    const realFile = assertContained(rootReal, candidate, `${slug}/${entry.name}`);
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) continue;
    const frame: RefFrame = { file: entry.name, path: realFile, size_bytes: stat.size };
    if (checksums !== null) {
      const actual = sha256File(realFile);
      frame.sha256 = actual;
      const expected = checksums.get(entry.name);
      if (expected !== undefined) {
        frame.expected_sha256 = expected;
        frame.verified = actual === expected;
        if (!frame.verified) {
          frame.mismatch = true;
          mismatches.push({ file: entry.name, expected, actual });
        }
      }
    }
    frames.push(frame);
  }

  if (frames.length === 0) {
    return {
      available: false,
      slug,
      refs_dir: rootReal,
      frames: [],
      manifest_checked: checksums !== null,
      mismatches: [],
      hint: `目录 ${styleDirReal} 中未找到 .png / .jpg / .webp 参考帧。`,
    };
  }
  return {
    available: true,
    slug,
    refs_dir: rootReal,
    frames,
    manifest_checked: checksums !== null,
    mismatches,
  };
}
