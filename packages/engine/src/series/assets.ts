import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { goTrimSpace } from '../gofmt';
import { readBinding, writeBinding } from './binding';
import { readDirections } from './brief';
import { publishTemplateDigest, readPublishTemplate } from './publish_template';
import { seriesDir } from './store';
import { type AssetKind, ConfigFile, DirectionsFile, PublishTemplateFile } from './types';

export const AssetNamePattern = /^[a-z][a-z0-9-]{0,39}$/;
export const MaxSharedComponentBytes = 5 * 1024 * 1024;
export const MaxSeriesAssetBytes = 200 * 1024 * 1024;

export type DirAssetKind = 'shared' | 'cast' | 'bumper' | 'audio' | 'cover';
export type BumperMode = 'video' | 'template';

export interface SeriesAssetEntry {
  key: string;
  kind: AssetKind;
  name: string;
  target_path: string;
  digest: string;
  files: number;
  bytes: number;
  bumper_mode?: BumperMode;
}

export interface PromoteAssetResult {
  key: string;
  kind: DirAssetKind;
  name: string;
  files: number;
  bytes: number;
  digest: string;
  bumper_mode?: BumperMode;
  replaced: boolean;
  unchanged: boolean;
}

const dirSubpath: Record<DirAssetKind, string> = {
  shared: 'shared',
  cast: 'cast',
  bumper: 'bumpers',
  audio: 'audio',
  cover: 'covers',
};

export function isDirAssetKind(kind: string): kind is DirAssetKind {
  return kind === 'shared' || kind === 'cast' || kind === 'bumper' || kind === 'audio' || kind === 'cover';
}

export function validateAssetName(name: string): string {
  const clean = goTrimSpace(name);
  if (!AssetNamePattern.test(clean)) {
    throw new Error('资产名须以小写字母开头，只含小写字母、数字与短横线，最长 40 位');
  }
  return clean;
}

export function assetKey(kind: AssetKind, name: string): string {
  return `${kind}:${name}`;
}

/** 某类资产在单期项目里的默认目标相对路径。 */
export function projectTargetPath(kind: AssetKind, name: string): string {
  if (kind === 'shared') return `production/shared/${name}`;
  if (kind === 'cast') return `cast/${name}`;
  if (kind === 'bumper') return `assets/series/bumpers/${name}`;
  if (kind === 'audio') return `assets/series/audio/${name}`;
  if (kind === 'cover') return `assets/series/covers/${name}`;
  if (kind === 'directions') return 'production/audio/directions.md';
  return 'assets/series/publish-template.json';
}

/** 专栏库内某目录资产的路径。 */
export function seriesAssetDir(rootDir: string, seriesId: string, kind: DirAssetKind, name: string): string {
  return path.join(seriesDir(rootDir, seriesId), 'assets', dirSubpath[kind], validateAssetName(name));
}

/** 递归列出目录里的普通文件（按字典序）；跳过点开头；遇符号链接报错。 */
export function listRegularFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(dir, prefix)).sort()) {
    if (name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const info = fs.lstatSync(path.join(dir, rel));
    if (info.isSymbolicLink()) throw new Error(`资产目录不能包含符号链接：${rel}`);
    if (info.isDirectory()) out.push(...listRegularFiles(dir, rel));
    else if (info.isFile()) out.push(rel);
    else throw new Error(`资产目录只能包含普通文件：${rel}`);
  }
  return out;
}

/** 计算目录树的稳定内容摘要与总字节数。 */
export function inspectTree(dir: string): { files: string[]; bytes: number; digest: string } {
  const files = listRegularFiles(dir);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(dir, rel));
    bytes += buf.length;
    hash.update(rel);
    hash.update('\0');
    hash.update(buf);
    hash.update('\0');
  }
  return { files, bytes, digest: hash.digest('hex') };
}

/** 计算单文件的内容摘要；不存在返回空串。 */
export function fileDigest(file: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** 识别片头/片尾资产形态：有 index.html 为可参数化模板，否则含视频文件为固定成片。 */
export function detectBumperMode(files: readonly string[]): BumperMode | undefined {
  if (files.some((f) => f === 'index.html' || f.endsWith('/index.html'))) return 'template';
  if (files.some((f) => /\.(mp4|mov|webm)$/i.test(f))) return 'video';
  return undefined;
}

/** 原子将源目录（或单文件包装进目录）拷贝到目标目录。 */
export function copyTreeAtomic(source: string, target: string, isSingleFile: boolean): void {
  const staging = `${target}.onset-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(staging, { recursive: true });
    if (isSingleFile) {
      fs.copyFileSync(source, path.join(staging, path.basename(source)));
    } else {
      for (const rel of listRegularFiles(source)) {
        const dest = path.join(staging, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(source, rel), dest);
      }
    }
    const existed = fs.existsSync(target);
    const old = `${target}.onset-old-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    if (existed) fs.renameSync(target, old);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(staging, target);
    } catch (err) {
      if (existed) fs.renameSync(old, target);
      throw err;
    }
    if (existed) fs.rmSync(old, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 列出专栏库里全部可复用的跨期资产（含目录类、directions.md、publish-template.json）。 */
export function listSeriesAssets(rootDir: string, seriesId: string): SeriesAssetEntry[] {
  const base = seriesDir(rootDir, seriesId);
  if (!fs.existsSync(path.join(base, ConfigFile))) throw new Error(`找不到专栏：${seriesId}`);
  const out: SeriesAssetEntry[] = [];

  for (const kind of ['shared', 'cast', 'bumper', 'audio', 'cover'] as const) {
    const kindDir = path.join(base, 'assets', dirSubpath[kind]);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(kindDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !AssetNamePattern.test(entry.name)) continue;
      const full = path.join(kindDir, entry.name);
      try {
        const info = inspectTree(full);
        if (info.files.length === 0) continue;
        out.push({
          key: assetKey(kind, entry.name),
          kind,
          name: entry.name,
          target_path: projectTargetPath(kind, entry.name),
          digest: info.digest,
          files: info.files.length,
          bytes: info.bytes,
          ...(kind === 'bumper' ? { bumper_mode: detectBumperMode(info.files) } : {}),
        });
      } catch {
        // 跳过损坏资产目录，不影响列表。
      }
    }
  }

  const directionsText = readDirections(rootDir, seriesId);
  if (directionsText !== '') {
    const dirFile = path.join(base, DirectionsFile);
    out.push({
      key: assetKey('directions', 'default'),
      kind: 'directions',
      name: 'default',
      target_path: projectTargetPath('directions', 'default'),
      digest: fileDigest(dirFile),
      files: 1,
      bytes: Buffer.byteLength(directionsText, 'utf8'),
    });
  }

  const tpl = readPublishTemplate(rootDir, seriesId);
  if (tpl) {
    const tplFile = path.join(base, PublishTemplateFile);
    out.push({
      key: assetKey('publish_template', 'default'),
      kind: 'publish_template',
      name: 'default',
      target_path: projectTargetPath('publish_template', 'default'),
      digest: publishTemplateDigest(tpl),
      files: 1,
      bytes: fs.statSync(tplFile).size,
    });
  }

  return out;
}

/** 校验源路径严格位于项目根内（防路径穿越）。 */
function resolveProjectSource(projectRoot: string, fromRel: string): { real: string; isFile: boolean } {
  const rootReal = fs.realpathSync(projectRoot);
  const abs = path.resolve(rootReal, fromRel);
  if (!fs.existsSync(abs)) throw new Error(`找不到要沉淀的源路径：${fromRel}`);
  const real = fs.realpathSync(abs);
  const rel = path.relative(rootReal, real);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`源路径必须在当前项目目录内：${fromRel}`);
  }
  const stat = fs.statSync(real);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`源路径必须是普通文件或目录：${fromRel}`);
  return { real, isFile: stat.isFile() };
}

/**
 * 将单期项目里验收好的资产（共用组件、常驻角色、片头/片尾、音频、封面）沉淀回专栏库。
 * 已有同名且内容不同时要求 replace: true；成功后自动刷新项目 onset.series.json.synced_assets。
 */
export function promoteAssetToSeries(
  rootDir: string,
  seriesId: string,
  projectRoot: string,
  opts: { kind: DirAssetKind; name: string; from?: string; replace?: boolean },
): PromoteAssetResult {
  const base = seriesDir(rootDir, seriesId);
  if (!fs.existsSync(path.join(base, ConfigFile))) throw new Error(`找不到专栏：${seriesId}`);
  const name = validateAssetName(opts.name);
  const fromRel = goTrimSpace(opts.from ?? '') || projectTargetPath(opts.kind, name);
  const { real, isFile } = resolveProjectSource(projectRoot, fromRel);

  if (opts.kind === 'shared' && isFile) {
    throw new Error('共用组件必须是一个包含 README.md 和代码入口的目录');
  }
  const files = isFile ? [path.basename(real)] : listRegularFiles(real);
  if (files.length === 0) throw new Error(`源目录为空，没有可沉淀的文件：${fromRel}`);

  if (opts.kind === 'shared') {
    if (!files.includes('README.md')) throw new Error(`共用组件必须包含 README.md：${fromRel}`);
    if (!files.some((f) => /\.(m?js|css)$/.test(f))) {
      throw new Error(`共用组件必须包含 .js / .mjs / .css 入口文件：${fromRel}`);
    }
  }
  let bumperMode: BumperMode | undefined;
  if (opts.kind === 'bumper') {
    bumperMode = detectBumperMode(files);
    if (!bumperMode) {
      throw new Error(`片头/片尾须包含成片视频（.mp4/.mov/.webm）或可参数化模板（index.html）：${fromRel}`);
    }
  }

  let bytes = 0;
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    const filePath = isFile ? real : path.join(real, rel);
    const buf = fs.readFileSync(filePath);
    bytes += buf.length;
    hash.update(rel);
    hash.update('\0');
    hash.update(buf);
    hash.update('\0');
  }
  const limit = opts.kind === 'shared' ? MaxSharedComponentBytes : MaxSeriesAssetBytes;
  if (bytes > limit) throw new Error(`资产体积超出上限（${bytes} 字节，上限 ${limit} 字节）`);
  const digest = hash.digest('hex');

  const target = seriesAssetDir(rootDir, seriesId, opts.kind, name);
  const existed = fs.existsSync(target);
  if (existed) {
    const prev = inspectTree(target);
    if (prev.digest === digest) {
      updateSyncedRecord(projectRoot, seriesId, opts.kind, name, digest);
      return { key: assetKey(opts.kind, name), kind: opts.kind, name, files: files.length, bytes, digest, bumper_mode: bumperMode, replaced: false, unchanged: true };
    }
    if (!opts.replace) {
      throw new Error(`专栏里已有同名资产「${opts.kind}:${name}」且内容不同；确认覆盖请加 replace: true`);
    }
  }

  copyTreeAtomic(real, target, isFile);
  updateSyncedRecord(projectRoot, seriesId, opts.kind, name, digest);
  return { key: assetKey(opts.kind, name), kind: opts.kind, name, files: files.length, bytes, digest, bumper_mode: bumperMode, replaced: existed, unchanged: false };
}

function updateSyncedRecord(projectRoot: string, seriesId: string, kind: AssetKind, name: string, digest: string): void {
  const binding = readBinding(projectRoot);
  if (!binding || binding.series_id !== seriesId) return;
  const key = assetKey(kind, name);
  binding.synced_assets[key] = {
    kind,
    name,
    target_path: projectTargetPath(kind, name),
    series_digest: digest,
    synced_at: new Date().toISOString(),
  };
  writeBinding(projectRoot, binding);
}

/** 删除专栏库里的某项资产（只删专栏库，不影响任何已有项目）。 */
export function deleteSeriesAsset(rootDir: string, seriesId: string, kind: DirAssetKind, name: string): void {
  const target = seriesAssetDir(rootDir, seriesId, kind, name);
  if (!fs.existsSync(target)) throw new Error(`专栏里找不到资产：${kind}:${name}`);
  fs.rmSync(target, { recursive: true, force: true });
}
