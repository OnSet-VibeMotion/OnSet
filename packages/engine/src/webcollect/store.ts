/**
 * 采集素材的安全落盘、SHA-256 去重、SVG 净化与清单（manifest.json）维护。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import {
  type CollectedAssetEntry,
  type CollectedAssetKind,
  CollectedAssetsRelDir,
  type CollectedManifest,
  CollectedManifestFile,
  MaxCollectedFileBytes,
} from './types';

const AllowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.avif']);

/** 净化内联或外部 SVG：剥离 script / iframe / foreignObject / object / embed、on* 事件与危险 URI。 */
export function sanitizeSvg(raw: string): string {
  let out = raw.trim();
  if (!/<svg\b/i.test(out)) {
    throw new Error('无效的 SVG 内容：缺少 <svg> 根节点');
  }
  // 去掉 XML 注释与 DOCTYPE（避免 DTD 实体注入）
  out = out.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  // 剥离危险标签及其内容（含自闭合形式）
  for (const tag of ['script', 'iframe', 'foreignObject', 'object', 'embed', 'applet']) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    const single = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    out = out.replace(paired, '').replace(single, '');
  }
  // 剥离全部内联事件属性（onload / onclick / onerror 等，支持双引号、单引号或无引号值）
  out = out.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 剥离 href / xlink:href / src / action 中的 javascript: / vbscript: / data:text/html
  out = out.replace(
    /\s+(?:xlink:)?(?:href|src|action|formaction)\s*=\s*(?:"\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^"]*"|'\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^']*'|[^\s>]*javascript:[^\s>]*)/gi,
    '',
  );
  // 剥离样式里的 javascript: 与 expression(...)
  out = out.replace(/javascript\s*:/gi, '');
  out = out.replace(/expression\s*\([^)]*\)/gi, '');
  out = out.trim();
  if (!/<svg\b/i.test(out)) {
    throw new Error('SVG 净化后已无有效图形节点');
  }
  return out;
}

/** 从二进制或 SVG 缓冲中尽力探测图像像素宽高（零外部依赖）。 */
export function probeImageDimensions(buf: Buffer, ext: string): { width?: number; height?: number } {
  const lower = ext.toLowerCase();
  if (lower === '.svg') return probeSvgDimensions(buf.toString('utf8'));
  // PNG: 8-byte signature + IHDR chunk (width @ 16, height @ 20)
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: GIF87a / GIF89a (width @ 6, height @ 8 LE)
  if (buf.length >= 10 && buf.subarray(0, 4).toString('ascii') === 'GIF8') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP: RIFF....WEBP
  if (
    buf.length >= 30 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunk = buf.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width, height };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
  }
  // JPEG: 扫描 SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && i + 9 < buf.length) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  // ICO: 取 ICONDIRENTRY 中最大的尺寸
  if (buf.length >= 22 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) {
    const count = Math.min(buf.readUInt16LE(4), 32);
    let maxW = 0;
    let maxH = 0;
    for (let idx = 0; idx < count; idx++) {
      const off = 6 + idx * 16;
      if (off + 16 > buf.length) break;
      const w = buf[off] === 0 ? 256 : buf[off];
      const h = buf[off + 1] === 0 ? 256 : buf[off + 1];
      if (w * h > maxW * maxH) {
        maxW = w;
        maxH = h;
      }
    }
    if (maxW > 0 && maxH > 0) return { width: maxW, height: maxH };
  }
  return {};
}

function probeSvgDimensions(svg: string): { width?: number; height?: number } {
  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  const wAttr = openTag.match(/\bwidth\s*=\s*["']\s*(\d+(?:\.\d+)?)(?:px)?\s*["']/i)?.[1];
  const hAttr = openTag.match(/\bheight\s*=\s*["']\s*(\d+(?:\.\d+)?)(?:px)?\s*["']/i)?.[1];
  if (wAttr && hAttr) {
    const width = Math.round(Number(wAttr));
    const height = Math.round(Number(hAttr));
    if (width > 0 && height > 0) return { width, height };
  }
  const vb = openTag.match(/\bviewBox\s*=\s*["']\s*[-0-9.]+\s+[-0-9.]+\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*["']/i);
  if (vb) {
    const width = Math.round(Number(vb[1]));
    const height = Math.round(Number(vb[2]));
    if (width > 0 && height > 0) return { width, height };
  }
  return {};
}

/** 校验采集目录及其已存在父目录均不为符号链接，并返回项目真实根下的采集目录路径。 */
export function assertSafeCollectedDir(projectRoot: string): string {
  const realRoot = fs.realpathSync(path.resolve(projectRoot));
  let cur = realRoot;
  for (const part of CollectedAssetsRelDir.split('/')) {
    cur = path.join(cur, part);
    if (fs.existsSync(cur)) {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`采集目录不允许是符号链接或非目录：${cur}`);
      }
    }
  }
  const manifestPath = path.join(cur, CollectedManifestFile);
  if (fs.existsSync(manifestPath)) {
    const st = fs.lstatSync(manifestPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`采集清单不允许是符号链接：${manifestPath}`);
    }
  }
  return cur;
}

/** 采集目录的绝对路径：<projectRoot>/assets/collected。 */
export function collectedDir(projectRoot: string): string {
  return path.resolve(projectRoot, CollectedAssetsRelDir);
}

/** 清单文件的相对路径（统一使用正斜杠）。 */
export function collectedManifestRelPath(): string {
  return `${CollectedAssetsRelDir}/${CollectedManifestFile}`;
}

/** 清单文件的绝对路径。 */
export function collectedManifestAbsPath(projectRoot: string): string {
  return path.join(collectedDir(projectRoot), CollectedManifestFile);
}

/** 校验文件名并拒绝任何路径穿越尝试。 */
export function assertSafeAssetName(rawName: string): string {
  if (rawName.includes('\0') || rawName.includes('..') || rawName.includes('/') || rawName.includes('\\')) {
    throw new Error(`非法素材名称（禁止路径分隔符或 ..）：${rawName}`);
  }
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'asset';
}

function normalizeExt(rawExt: string): string {
  const ext = (rawExt.startsWith('.') ? rawExt : `.${rawExt}`).toLowerCase();
  if (!AllowedExtensions.has(ext)) {
    throw new Error(`不支持的素材文件扩展名：${rawExt}`);
  }
  return ext;
}

/** 读取项目已有的采集清单，若尚未创建则返回空清单。 */
export function readCollectedManifest(projectRoot: string): CollectedManifest {
  const dir = assertSafeCollectedDir(projectRoot);
  const file = path.join(dir, CollectedManifestFile);
  if (!fs.existsSync(file)) {
    return { version: 1, updated_at: '', assets: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CollectedManifest>;
  const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
  return {
    version: 1,
    updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : '',
    assets: [...assets].sort((a, b) => compareBytes(a.id, b.id)),
  };
}

/** 原子写出采集清单（权限 0644，使用 gojson 固定格式）。 */
export function writeCollectedManifest(projectRoot: string, manifest: CollectedManifest): string {
  const dir = assertSafeCollectedDir(projectRoot);
  const file = path.join(dir, CollectedManifestFile);
  const normalized: CollectedManifest = {
    version: 1,
    updated_at: manifest.updated_at || new Date().toISOString(),
    assets: [...manifest.assets].sort((a, b) => compareBytes(a.id, b.id)),
  };
  atomicWrite(file, `${marshalIndent(normalized, '  ', false)}\n`, 0o644);
  return file;
}

export interface SaveCollectedAssetInput {
  projectRoot: string;
  buffer: Buffer;
  ext: string;
  kind: CollectedAssetKind;
  source: string;
  caption: string;
  name?: string;
  mimeType?: string;
  dryRun?: boolean;
  maxBytes?: number;
}

export interface SaveCollectedAssetResult {
  entry: CollectedAssetEntry;
  deduplicated: boolean;
}

/**
 * 将单个素材安全落盘到 <projectRoot>/assets/collected/ 并更新 manifest.json：
 * - 强制单文件体积硬上限（默认 24 MB）；
 * - SVG 自动先净化再算摘要；
 * - 按 SHA-256 去重：内容相同且已有文件时直接返回既有条目，不重复写盘；
 * - 严格防止路径穿越，文件权限固定 0644。
 */
export function saveCollectedAsset(input: SaveCollectedAssetInput): SaveCollectedAssetResult {
  const maxBytes = input.maxBytes ?? MaxCollectedFileBytes;
  if (input.buffer.length === 0) {
    throw new Error('素材内容为空，拒绝保存');
  }
  if (input.buffer.length > maxBytes) {
    throw new Error(`素材体积超过上限（${input.buffer.length} > ${maxBytes} 字节）`);
  }
  const ext = normalizeExt(input.ext);
  let finalBuf = input.buffer;
  if (ext === '.svg' || input.kind === 'vector') {
    const clean = sanitizeSvg(input.buffer.toString('utf8'));
    finalBuf = Buffer.from(clean, 'utf8');
    if (finalBuf.length > maxBytes) {
      throw new Error(`净化后 SVG 体积超过上限（${finalBuf.length} > ${maxBytes} 字节）`);
    }
  }

  const sha256 = crypto.createHash('sha256').update(finalBuf).digest('hex');
  const dir = assertSafeCollectedDir(input.projectRoot);
  const realRoot = fs.realpathSync(path.resolve(input.projectRoot));
  const manifest = readCollectedManifest(input.projectRoot);
  const existing = manifest.assets.find((item) => item.sha256 === sha256);
  if (existing) {
    if (input.dryRun) return { entry: existing, deduplicated: true };
    const existingAbs = path.resolve(realRoot, existing.file);
    const existingRel = path.relative(dir, existingAbs);
    if (!existingRel.startsWith('..') && !path.isAbsolute(existingRel) && fs.existsSync(existingAbs)) {
      const st = fs.lstatSync(existingAbs);
      if (!st.isSymbolicLink() && st.isFile()) {
        const diskSha = crypto.createHash('sha256').update(fs.readFileSync(existingAbs)).digest('hex');
        if (diskSha === sha256) return { entry: existing, deduplicated: true };
      }
    }
  }

  const stem = input.name ? assertSafeAssetName(input.name) : input.kind;
  const shortHash = sha256.slice(0, 10);
  let suffix = '';
  let fileName = `${stem}-${shortHash}${ext}`;
  let absTarget = path.resolve(dir, fileName);
  // 若目标文件已存在但内容与本次摘要不同（用户手工替换过），分配新名以保留用户修改过的文件。
  if (!input.dryRun) {
    for (let n = 2; fs.existsSync(absTarget); n++) {
      const st = fs.lstatSync(absTarget);
      if (!st.isSymbolicLink() && st.isFile()) {
        const diskSha = crypto.createHash('sha256').update(fs.readFileSync(absTarget)).digest('hex');
        if (diskSha === sha256) break;
      }
      suffix = `-${n}`;
      fileName = `${stem}-${shortHash}${suffix}${ext}`;
      absTarget = path.resolve(dir, fileName);
    }
  }
  const relCheck = path.relative(dir, absTarget);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`目标路径越出采集目录：${fileName}`);
  }

  const dims = probeImageDimensions(finalBuf, ext);
  const now = new Date().toISOString();
  const entry: CollectedAssetEntry = {
    id: `${stem}-${shortHash}${suffix}`,
    file: `${CollectedAssetsRelDir}/${fileName}`,
    kind: input.kind,
    bytes: finalBuf.length,
    sha256,
    width: dims.width,
    height: dims.height,
    source: input.source,
    caption: input.caption,
    mime_type: input.mimeType,
    collected_at: now,
  };

  if (!input.dryRun) {
    const existedBefore = fs.existsSync(absTarget);
    atomicWrite(absTarget, finalBuf, 0o644);
    try {
      const nextAssets = manifest.assets.filter((item) => item.sha256 !== sha256 && item.id !== entry.id);
      nextAssets.push(entry);
      writeCollectedManifest(input.projectRoot, {
        version: 1,
        updated_at: now,
        assets: nextAssets,
      });
    } catch (err) {
      if (!existedBefore) {
        try {
          fs.rmSync(absTarget, { force: true });
        } catch {
          // 忽略回滚删除失败
        }
      }
      throw err;
    }
  }
  return { entry, deduplicated: false };
}
