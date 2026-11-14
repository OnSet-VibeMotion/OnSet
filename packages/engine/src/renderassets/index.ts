/**
 * 渲染资源：项目里每种内容只存一份，镜头用相对文件链接保持原来的 URL 与模块路径。
 * 不联网、不改来源、不用硬链接（改副本不能污染风格库）。缓存随项目保存，不自动清理：旧镜头仍会引用旧版本。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';

export const CacheDir = '.onset/resources';
export const ManifestFile = '.onset-resources.json';

export interface Mount {
  from: string;
  /** 镜头内的相对路径；目录内结构原样保留。不存在的可选来源跳过。 */
  to: string;
}
export interface Resource {
  from: string;
  path: string;
  sha256: string;
}
interface Entry {
  path: string;
  sha256: string;
  kind: 'link' | 'copy';
}

function digest(body: Buffer | string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}
// 客户端会频繁查询全部镜头的状态。相同文件只算一次摘要；ctime 也入签名，恢复 mtime 不能藏住改写。
const digests = new Map<string, { signature: string; hash: string }>();
function fileDigest(file: string): string {
  const info = fs.statSync(file, { bigint: true });
  const signature = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  const cached = digests.get(file);
  if (cached?.signature === signature) return cached.hash;
  const hash = digest(fs.readFileSync(file));
  if (digests.size >= 4096) digests.clear();
  digests.set(file, { signature, hash });
  return hash;
}
function stat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
function relative(name: string): string {
  if (!name || name.includes('\\') || name.includes(':') || name.includes('\0') ||
      name.split('/').some((p) => !p || p.startsWith('.') || p === 'onset.conf' || p === 'scene.json' || p === 'transcript.srt')) {
    throw new Error(`渲染资源必须是镜头内的普通相对路径：${name}`);
  }
  return name;
}

/** 提前展开、校验、去重；同一路径的不同内容不允许静默覆盖。 */
export function collect(mounts: Mount[]): Resource[] {
  const files = new Map<string, Resource>();
  const visit = (from: string, to: string): void => {
    relative(to);
    const info = stat(from);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`渲染资源来源不能有符号链接：${from}`);
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(from).sort(compareBytes)) {
        if (name.startsWith('.')) continue;
        visit(path.join(from, name), to + '/' + name);
      }
    } else if (info.isFile()) {
      const sha256 = fileDigest(from);
      if (files.has(to) && files.get(to)!.sha256 !== sha256) throw new Error(`渲染资源路径冲突：${to}`);
      files.set(to, { from, path: to, sha256 });
    } else throw new Error(`渲染资源不是普通文件：${from}`);
  };
  for (const mount of mounts) visit(mount.from, mount.to);
  return [...files.values()].sort((a, b) => compareBytes(a.path, b.path));
}

/** 目录链不能穿过符号链接，避免把缓存或目标写出项目。root 本身由调用方 realpath。 */
function parents(root: string, file: string): void {
  const rel = path.relative(root, file);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error(`渲染资源路径逃出目录：${file}`);
  let dir = root;
  for (const name of rel.split(path.sep).slice(0, -1)) {
    dir = path.join(dir, name);
    const info = stat(dir);
    if (info?.isSymbolicLink()) throw new Error(`渲染资源目录不能是符号链接：${dir}`);
    if (info && !info.isDirectory()) throw new Error(`渲染资源目录被文件占用：${dir}`);
  }
}
function manifest(scene: string): Entry[] {
  const file = path.join(scene, ManifestFile);
  const info = stat(file);
  if (!info) return [];
  if (!info.isFile()) throw new Error(`渲染资源清单不是普通文件：${file}`);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.schema !== 1 || !Array.isArray(value.files)) throw new Error(`渲染资源清单格式错误：${file}`);
  const seen = new Set<string>();
  for (const entry of value.files) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || !['link', 'copy'].includes(entry.kind)) throw new Error(`渲染资源清单条目错误：${file}`);
    relative(entry.path);
    if (seen.has(entry.path)) throw new Error(`渲染资源清单路径重复：${entry.path}`);
    seen.add(entry.path);
  }
  return value.files;
}
function writeManifest(scene: string, files: Entry[]): void {
  atomicWrite(path.join(scene, ManifestFile), marshalIndent({ schema: 1, files: files.sort((a, b) => compareBytes(a.path, b.path)) }) + '\n');
}

export function paths(scene: string): string[] {
  return manifest(scene).map((entry) => entry.path);
}

/** 只认指向本项目内容池的相对链接；清单本身不能授权读取项目外的任意文件。 */
function checkLink(scene: string, file: string, entry: Entry): void {
  const link = fs.readlinkSync(file);
  const target = path.resolve(path.dirname(file), link);
  // 从镜头找归属，不能反过来从链接目标推项目：否则指向更上层（例如家目录）的缓存也会被误认。
  let project = scene;
  while (!stat(path.join(project, 'onset.conf'))?.isFile() && !stat(path.join(project, CacheDir))?.isDirectory()) {
    const parent = path.dirname(project);
    if (parent === project) throw new Error(`渲染资源链接目标没有所属项目：${file}`);
    project = parent;
  }
  if (path.isAbsolute(link) || target !== path.join(project, CacheDir, entry.sha256) ||
      !scene.startsWith(project + path.sep)) throw new Error(`渲染资源链接目标错误：${file}`);
  parents(project, target);
  if (!stat(target)?.isFile()) throw new Error(`渲染资源缓存缺失：${file}`);
}
function resourcePath(scene: string, entry: Entry): string {
  const file = path.join(scene, entry.path);
  parents(scene, file);
  const info = stat(file);
  if (info?.isSymbolicLink()) checkLink(scene, file, entry);
  else if (!info?.isFile()) throw new Error(`渲染资源缺失：${entry.path}`);
  return file;
}
function bytes(scene: string, entry: Entry): Buffer {
  return fs.readFileSync(resourcePath(scene, entry));
}

/**
 * 只替换自己管理且未被改写的文件，或内容完全相同的老副本。旧资源保留，已有合成仍能预览。
 * Windows 创建符号链接可能没有权限，退回独立副本；不使用绝对 junction，以免项目搬家后断链。
 */
export function prepare(project: string, scene: string, files: Resource[]): void {
  if (files.length === 0) return;
  project = fs.realpathSync(project);
  scene = fs.realpathSync(scene);
  if (scene === project || !scene.startsWith(project + path.sep)) throw new Error('共享渲染资源的镜头必须在项目内');
  const old = new Map(manifest(scene).map((e) => [e.path, e]));
  // 所有覆盖冲突先查完，避免第一个文件已更新、后一个才发现用户改过。
  for (const file of files) {
    relative(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`渲染资源摘要格式错误：${file.path}`);
    const target = path.join(scene, file.path);
    parents(scene, target);
    const info = stat(target);
    if (!info) continue;
    const previous = old.get(file.path);
    if (!info.isSymbolicLink() && !info.isFile()) throw new Error(`已有文件不是普通渲染资源：${file.path}`);
    // 上次在 rename 后、清单落盘前中断：内容寻址的项目内链接仍可安全认领。
    const entry = previous ?? { path: file.path, sha256: file.sha256, kind: 'link' as const };
    const actual = digest(bytes(scene, entry));
    if (actual !== file.sha256 && actual !== previous?.sha256) throw new Error(`已有文件与共享资源不同，保留原文件：${file.path}`);
  }
  for (const file of files) {
    const blob = path.join(project, CacheDir, file.sha256);
    parents(project, blob);
    const body = fs.readFileSync(file.from);
    if (digest(body) !== file.sha256) throw new Error(`准备期间渲染资源发生变化：${file.from}`);
    const cached = stat(blob);
    if (cached) {
      if (!cached.isFile() || digest(fs.readFileSync(blob)) !== file.sha256) throw new Error(`渲染资源缓存损坏：${blob}`);
    } else {
      // 不硬链接来源。0644 便于从模板复制后编辑；macOS 沙箱禁止写镜头外的缓存，其他平台靠摘要检查。
      atomicWrite(blob, body);
    }
    const target = path.join(scene, file.path);
    if (old.get(file.path)?.sha256 === file.sha256 && stat(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = path.join(path.dirname(target), '.onset-resource-' + crypto.randomBytes(8).toString('hex'));
    let kind: Entry['kind'] = 'link';
    try {
      try {
        fs.symlinkSync(path.relative(path.dirname(target), blob), tmp, 'file');
      } catch (err) {
        if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
        fs.copyFileSync(blob, tmp);
        kind = 'copy';
      }
      fs.renameSync(tmp, target);
      old.set(file.path, { path: file.path, sha256: file.sha256, kind });
      // 每放好一个就记下所有权，中断后可以安全重试。
      writeManifest(scene, [...old.values()]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

/** 指纹按资源字节与镜头 URL 记，不记机器路径。来源更新与已挂载资源损坏都能被发现。 */
export function inputs(scene: string, files: Resource[]): Record<string, string> {
  scene = fs.realpathSync(scene);
  const desired = new Map(files.map((f) => [f.path, f.sha256]));
  for (const entry of manifest(scene)) {
    let actual: string;
    try { actual = fileDigest(resourcePath(scene, entry)); } catch { actual = 'missing'; }
    const expected = desired.get(entry.path) ?? entry.sha256;
    desired.set(entry.path, actual === entry.sha256 ? expected : digest(expected + '\n' + actual));
  }
  return Object.fromEntries([...desired].sort(([a], [b]) => compareBytes(a, b)).map(([name, hash]) => ['asset:' + name, hash]));
}

/** 渲染器不能改写共享库；在正式验收前核对，避免把污染的缓存当作成功产物。 */
export function verify(scene: string): void {
  scene = fs.realpathSync(scene);
  for (const entry of manifest(scene)) {
    if (digest(bytes(scene, entry)) !== entry.sha256) throw new Error(`共享渲染资源已被修改：${entry.path}；请把修改另存为镜头自己的文件`);
  }
}

/** 记忆重放与单独导出镜头时实体化资源，不让快照依赖原项目或缓存。 */
export function freeze(scene: string, target: string): void {
  scene = fs.realpathSync(scene);
  const entries = manifest(scene);
  if (entries.length === 0) return;
  fs.mkdirSync(target, { recursive: true });
  target = fs.realpathSync(target);
  for (const entry of entries) {
    const body = bytes(scene, entry);
    if (digest(body) !== entry.sha256) throw new Error(`冻结的渲染资源已被修改：${entry.path}`);
    const file = path.join(target, entry.path);
    parents(target, file);
    if (stat(file)) throw new Error(`冻结目标已有文件：${entry.path}`);
    atomicWrite(file, body);
  }
  writeManifest(target, entries.map((e) => ({ ...e, kind: 'copy' })));
}

/** 归档移走镜头前读取资源；只实体化本项目内容池的链接，其余符号链接维持原有归档契约。 */
export function archiveContent(project: string, file: string): { body: Buffer; link: string } | undefined {
  const rel = path.relative(project, file);
  project = fs.realpathSync(project);
  file = path.join(project, rel);
  parents(project, file);
  if (!stat(file)?.isSymbolicLink()) return undefined;
  const link = fs.readlinkSync(file);
  const target = path.resolve(path.dirname(file), link);
  const cache = path.resolve(project, CacheDir);
  if (path.isAbsolute(link) || path.dirname(target) !== cache || !/^[a-f0-9]{64}$/.test(path.basename(target))) return undefined;
  parents(project, target);
  if (!stat(target)?.isFile()) throw new Error(`归档的渲染资源缓存缺失：${file}`);
  const body = fs.readFileSync(target);
  if (digest(body) !== path.basename(target)) throw new Error(`归档的渲染资源缓存损坏：${file}`);
  return { body, link };
}
