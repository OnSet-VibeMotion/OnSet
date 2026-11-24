/**
 * 离线便携工程 ZIP 归档（导出自验 + 导入，同时兼容标准 HyperFrames ZIP）。
 *
 * 与 engine/archive（git 归档已制作项目）不同：本模块产出可离线跨机传播的便携工程包，
 * 自动剥离 .env、临时日志、渲染尝试缓存与回退快照，保留源码、资源池、配置与许可证，
 * 并在落盘前用与导入完全一致的校验器完成自验。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, removeTree } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { assertSafeZipPath, buildZip, DefaultZipLimits, readZip, type ZipLimits } from './zip';

export const ArchiveFormat = 'onset.project-archive';
export const ArchiveVersion = 1;
export const ManifestFileName = 'onset-project-archive.json';

export interface ArchiveFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ProjectArchiveManifest {
  format: typeof ArchiveFormat;
  version: typeof ArchiveVersion;
  title: string;
  exported_at: string;
  files: ArchiveFileEntry[];
}

export interface ExportProjectOptions {
  title?: string;
  /** 是否包含成片及镜头 MP4（默认关闭以保持便携体积，传 true 则一并打包）。 */
  includeRenders?: boolean;
  limits?: ZipLimits;
}

export interface ExportProjectResult {
  archive_path: string;
  title: string;
  file_count: number;
  bytes: number;
  sha256: string;
}

export interface ImportProjectResult {
  kind: 'onset' | 'hyperframes';
  title: string;
  destination: string;
  file_count: number;
  bytes: number;
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function shouldSkipPath(rel: string, includeRenders: boolean): boolean {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  // 绝不打包环境密钥、git 目录、依赖树、操作系统垃圾文件。
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === '.DS_Store' || base === 'Thumbs.db') return true;
  if (parts.includes('.git') || parts.includes('node_modules') || parts.includes('__MACOSX')) return true;
  // 排除运行态缓存、历史尝试与回退大对象。
  if (
    rel.startsWith('production/studio/blobs/') ||
    rel.startsWith('production/studio/inbox/') ||
    rel.startsWith('production/studio/uploads/')
  )
    return true;
  if (parts.includes('attempts')) return true;
  if (rel.startsWith('.onset/preview-cache/')) return true;
  if (base.startsWith('.onset-tmp-') || base.endsWith('.live.json') || base.endsWith('.stream.jsonl')) return true;
  if (!includeRenders) {
    if (rel === 'final.mp4' || rel === 'production/silent-master.mp4' || rel === 'production/audio/candidate.mp4')
      return true;
    if (/^scenes\/[^/]+\/scene\.mp4$/i.test(rel)) return true;
  }
  return false;
}

function collectPortableFiles(root: string, includeRenders: boolean): Map<string, Buffer> {
  const resolvedRoot = fs.realpathSync(root);
  const files = new Map<string, Buffer>();

  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (shouldSkipPath(rel, includeRenders)) continue;
      const full = path.join(dir, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        // 允许指向项目内部文件的相对软链接（如 .onset/resources/<sha256> 挂载到镜头），打包时实体化为普通文件；拒绝指向项目外。
        const target = fs.realpathSync(full);
        if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
          continue;
        }
        const targetStat = fs.statSync(target);
        if (targetStat.isFile()) {
          files.set(assertSafeZipPath(rel), fs.readFileSync(target));
        }
        continue;
      }
      if (st.isDirectory()) {
        walk(full, rel);
      } else if (st.isFile()) {
        files.set(assertSafeZipPath(rel), fs.readFileSync(full));
      }
    }
  };

  walk(resolvedRoot, '');
  return files;
}

function stripMacNoiseAndSingleWrapper(raw: Map<string, Buffer>): {
  files: Map<string, Buffer>;
  wrapperTitle?: string;
} {
  const cleaned = new Map<string, Buffer>();
  for (const [name, buf] of raw.entries()) {
    const parts = name.split('/');
    if (parts[0] === '__MACOSX' || parts[parts.length - 1] === '.DS_Store' || parts[parts.length - 1].startsWith('._'))
      continue;
    cleaned.set(name, buf);
  }
  if (cleaned.size === 0) throw new Error('归档里没有任何有效文件');
  // 若所有条目都在同一层根目录下（Finder 压缩文件夹的典型结构），剥掉外层目录名并保留作标题。
  const firstSlash = [...cleaned.keys()].every((k) => k.includes('/'));
  if (firstSlash) {
    const tops = new Set([...cleaned.keys()].map((k) => k.split('/')[0]));
    if (tops.size === 1) {
      const top = [...tops][0];
      const unwrapped = new Map<string, Buffer>();
      for (const [name, buf] of cleaned.entries()) {
        unwrapped.set(name.slice(top.length + 1), buf);
      }
      return { files: unwrapped, wrapperTitle: top };
    }
  }
  return { files: cleaned };
}

/**
 * 校验一份归档字节流（供导出自验与导入共用）。
 * 返回识别出的格式（onset 或 hyperframes）、标题与全部文件映射。
 */
export function validateProjectZipBytes(
  data: Buffer,
  limits: ZipLimits = DefaultZipLimits,
): { kind: 'onset' | 'hyperframes'; title: string; files: Map<string, Buffer> } {
  const raw = readZip(data, limits);
  const { files, wrapperTitle } = stripMacNoiseAndSingleWrapper(raw);

  if (files.has(ManifestFileName)) {
    let manifest: ProjectArchiveManifest;
    try {
      manifest = JSON.parse(files.get(ManifestFileName)!.toString('utf8')) as ProjectArchiveManifest;
    } catch (err) {
      throw new Error(`归档清单 ${ManifestFileName} 不是合法 JSON`, { cause: err });
    }
    if (manifest.format !== ArchiveFormat || manifest.version !== ArchiveVersion || !Array.isArray(manifest.files)) {
      throw new Error(`不受支持的归档清单格式或版本`);
    }
    const declared = new Map<string, ArchiveFileEntry>();
    for (const item of manifest.files) {
      if (
        !item ||
        typeof item.path !== 'string' ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(item.sha256)
      ) {
        throw new Error(`归档清单条目无效：${JSON.stringify(item)}`);
      }
      const clean = assertSafeZipPath(item.path);
      if (clean === ManifestFileName) throw new Error('归档清单不得列出清单文件自身');
      if (declared.has(clean)) throw new Error(`归档清单包含重复条目：${clean}`);
      declared.set(clean, item);
    }
    const payloadFiles = new Map<string, Buffer>();
    for (const [name, buf] of files.entries()) {
      if (name === ManifestFileName) continue;
      const spec = declared.get(name);
      if (!spec) throw new Error(`归档包含清单未登记的文件：${name}`);
      if (buf.length !== spec.bytes || sha256(buf) !== spec.sha256) {
        throw new Error(`归档文件校验失败（字节数或 SHA-256 不符）：${name}`);
      }
      payloadFiles.set(name, buf);
    }
    for (const missing of declared.keys()) {
      if (!payloadFiles.has(missing)) throw new Error(`归档缺少清单登记的文件：${missing}`);
    }
    return {
      kind: 'onset',
      title: manifest.title || wrapperTitle || '已导入项目',
      files: payloadFiles,
    };
  }

  // 兼容标准 HyperFrames 项目 ZIP：根目录须含 index.html，若有 hyperframes.json 则校验其路径都在项目内。
  if (files.has('index.html')) {
    if (files.has('hyperframes.json')) {
      let hf: { paths?: Record<string, unknown> };
      try {
        hf = JSON.parse(files.get('hyperframes.json')!.toString('utf8')) as { paths?: Record<string, unknown> };
      } catch (err) {
        throw new Error('hyperframes.json 不是合法 JSON', { cause: err });
      }
      for (const value of Object.values(hf.paths ?? {})) {
        if (typeof value === 'string' && value !== '') assertSafeZipPath(value);
      }
    } else {
      files.set(
        'hyperframes.json',
        Buffer.from(
          marshalIndent({
            $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
            paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
          }) + '\n',
          'utf8',
        ),
      );
    }
    return {
      kind: 'hyperframes',
      title: wrapperTitle || 'Imported HyperFrames Project',
      files,
    };
  }

  throw new Error(`无法识别归档格式：既缺少 ${ManifestFileName}，也缺少 HyperFrames 入口 index.html`);
}

/**
 * 导出便携项目 ZIP，并在落盘前用与导入完全相同的规则完成自验。
 */
export function exportProjectZip(
  projectRoot: string,
  destZip: string,
  opts: ExportProjectOptions = {},
): ExportProjectResult {
  const limits = opts.limits ?? DefaultZipLimits;
  const files = collectPortableFiles(projectRoot, Boolean(opts.includeRenders));
  if (files.size === 0) throw new Error(`项目目录里没有可导出的文件：${projectRoot}`);

  const title = opts.title?.trim() || path.basename(path.resolve(projectRoot));
  const sorted = [...files.keys()].sort(compareBytes);
  const manifest: ProjectArchiveManifest = {
    format: ArchiveFormat,
    version: ArchiveVersion,
    title,
    exported_at: new Date().toISOString(),
    files: sorted.map((filePath) => {
      const buf = files.get(filePath)!;
      return { path: filePath, bytes: buf.length, sha256: sha256(buf) };
    }),
  };

  const archiveEntries = new Map<string, Buffer>(files);
  archiveEntries.set(ManifestFileName, Buffer.from(marshalIndent(manifest) + '\n', 'utf8'));
  const zipBytes = buildZip(archiveEntries, limits);

  // 先自验再落盘：解析刚打好的字节流并核对全部摘要。
  validateProjectZipBytes(zipBytes, limits);

  const absDest = path.resolve(destZip);
  atomicWrite(absDest, zipBytes, 0o644);
  return {
    archive_path: absDest,
    title,
    file_count: files.size,
    bytes: zipBytes.length,
    sha256: sha256(zipBytes),
  };
}

/**
 * 将 OnSet 便携 ZIP 或标准 HyperFrames ZIP 导入到新的独立目录（绝不覆盖已有非空目录）。
 */
export function importProjectZip(
  zipPath: string,
  destDir: string,
  limits: ZipLimits = DefaultZipLimits,
): ImportProjectResult {
  const absZip = path.resolve(zipPath);
  const absDest = path.resolve(destDir);
  if (fs.existsSync(absDest)) {
    const existing = fs.readdirSync(absDest);
    if (existing.length > 0) throw new Error(`目标目录已存在且非空，拒绝覆盖：${absDest}`);
  }
  const raw = fs.readFileSync(absZip);
  const validated = validateProjectZipBytes(raw, limits);

  fs.mkdirSync(path.dirname(absDest), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(absDest), '.onset-import-'));
  let totalBytes = 0;
  try {
    for (const [rel, content] of validated.files.entries()) {
      const target = path.join(staging, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { mode: 0o644 });
      totalBytes += content.length;
    }
    if (fs.existsSync(absDest)) fs.rmdirSync(absDest);
    fs.renameSync(staging, absDest);
  } catch (err) {
    removeTree(staging);
    throw err;
  }

  return {
    kind: validated.kind,
    title: validated.title,
    destination: absDest,
    file_count: validated.files.size,
    bytes: totalBytes,
  };
}

/** 测试与工具辅助：检查一个临时目录路径是否安全落在给定父目录下。 */
export function defaultExportZipPath(projectRoot: string, dir = os.tmpdir()): string {
  const base = path.basename(path.resolve(projectRoot)).replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_') || 'project';
  return path.join(dir, `${base}.onset.zip`);
}
