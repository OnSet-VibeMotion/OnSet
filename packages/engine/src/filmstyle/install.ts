// 移植自 internal/filmstyle/install.go。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goPathError, goQuote } from '../gofmt';
import { compareBytes, marshalIndent } from '../gojson';
import { sourceByID, styleKey, styleLabel, type Style } from './filmstyle';

/** 技能在项目里的落点，与 hyperframes.SkillsSubdir 一致。 */
export const SkillsSubdir = '.agents/skills';

/**
 * 整片风格在项目 .agents/skills/ 下的目录名。
 *
 * 带 am- 前缀而不叫 film-style：技能解析会从镜头目录逐级向上找 .agents/skills，
 * 名字太通用容易撞上用户自己装的别的技能。
 */
export const SkillName = 'am-film-style';

/** 整片风格技能目录里的来源记录。 */
export const ManifestFile = 'am-film-style.json';

/** 契约里的两份必需文件。 */
export const StyleFile = 'STYLE.md';
export const GuideFile = 'SKILL.md';

// LegacySkillName / legacyManifest 是只有 lemo-opuscar 一个来源时的目录名与记录。
// 早先装过的项目照样认（读、渲染、去掉），下次装风格时换成新目录。
export const LegacySkillName = 'lemo-film-style';
const legacyManifest = 'lemo-upstream.json';
const legacySource = 'lemo-opuscar';

/** am-film-style.json：这个项目装的是哪个来源的哪种风格。字段名照抄 Go 的 JSON tag。 */
export interface Manifest {
  source: string;
  slug: string;
  cn: string;
  en: string;
  /** 来源给的版本标识（例如上游 commit）。 */
  version: string;
  /** 技能目录里除本文件外全部文件的内容摘要，用来判断重装是否有变化。 */
  digest: string;
  installed_at: string;
  /** 表示读自旧目录（lemo-film-style），不写进文件（json:"-"）。 */
  legacy: boolean;
}

/** <来源>/<目录名>。 */
export function manifestKey(manifest: Pick<Manifest, 'source' | 'slug'>): string {
  return manifest.source + '/' + manifest.slug;
}

/** 项目里整片风格技能目录的路径。 */
export function skillDir(projectDir: string): string {
  return path.join(projectDir, SkillsSubdir, SkillName);
}

function legacyDir(projectDir: string): string {
  return path.join(projectDir, SkillsSubdir, LegacySkillName);
}

function exists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 项目里实际装着整片风格的目录（新目录或旧目录）；没有时为空。 */
export function installedDir(projectDir: string): string {
  if (exists(path.join(skillDir(projectDir), ManifestFile))) return skillDir(projectDir);
  if (exists(path.join(legacyDir(projectDir), legacyManifest))) return legacyDir(projectDir);
  return '';
}

function readOptional(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(goPathError('open', file, err), { cause: err });
  }
}

/**
 * encoding/json 解码进字符串字段：键名先找完全相同的，再不区分大小写地找；
 * 值不是字符串（也不是 null）时报错；没有这个键时为空串。
 */
function stringField(object: Record<string, unknown>, name: string): string {
  let value: unknown;
  if (Object.hasOwn(object, name)) value = object[name];
  else {
    const lower = name.toLowerCase();
    const key = Object.keys(object).find((k) => k.toLowerCase() === lower);
    value = key === undefined ? undefined : object[key];
  }
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go struct field .${name} of type string`);
  return value;
}

function jsonKind(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function decodeObject(body: string): Record<string, unknown> {
  const value: unknown = JSON.parse(body);
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go value of type struct`);
  }
  return value as Record<string, unknown>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 读取项目里已装的整片风格；没有时 ok 为 false。 */
export function installed(projectDir: string): { manifest: Manifest; ok: boolean } {
  const empty: Manifest = { source: '', slug: '', cn: '', en: '', version: '', digest: '', installed_at: '', legacy: false };
  let body = readOptional(path.join(skillDir(projectDir), ManifestFile));
  if (body !== undefined) {
    try {
      const raw = decodeObject(body);
      return {
        manifest: {
          source: stringField(raw, 'source'),
          slug: stringField(raw, 'slug'),
          cn: stringField(raw, 'cn'),
          en: stringField(raw, 'en'),
          version: stringField(raw, 'version'),
          digest: stringField(raw, 'digest'),
          installed_at: stringField(raw, 'installed_at'),
          legacy: false,
        },
        ok: true,
      };
    } catch (err) {
      throw new Error(`${ManifestFile} 损坏：${errorText(err)}`, { cause: err });
    }
  }
  body = readOptional(path.join(legacyDir(projectDir), legacyManifest));
  if (body === undefined) return { manifest: empty, ok: false };
  try {
    // 旧记录的字段没有 JSON tag（Commit、Slug……），encoding/json 按名字不区分大小写匹配。
    const raw = decodeObject(body);
    return {
      manifest: {
        source: legacySource,
        slug: stringField(raw, 'Slug'),
        cn: stringField(raw, 'CN'),
        en: stringField(raw, 'EN'),
        version: stringField(raw, 'Commit'),
        digest: stringField(raw, 'Digest'),
        installed_at: stringField(raw, 'installed_at'),
        legacy: true,
      },
      ok: true,
    };
  } catch (err) {
    throw new Error(`${legacyManifest} 损坏：${errorText(err)}`, { cause: err });
  }
}

/** 一次整片风格安装。 */
export interface InstallOptions {
  projectDir: string;
  style: Style;
  /** 交给来源找它的数据。 */
  env?: Record<string, string>;
  /**
   * 为 true 时允许把已装的另一种风格换掉。换风格会让所有镜头的输入
   * 指纹变化，所以默认拒绝。
   */
  replace?: boolean;
  /** 用于测试；不给时取当前时间。 */
  now?: Date;
}

/** 安装结果。 */
export interface InstallResult {
  manifest: Manifest;
  /** 项目里已是同一份内容，没有改动任何文件。 */
  unchanged: boolean;
  /** 被换掉的风格标识，没有换时为空。 */
  replaced: string;
}

/** Go 的 time.RFC3339（UTC，秒精度）。 */
function rfc3339(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, 'Z');
}

function linkError(op: string, from: string, to: string, err: unknown): string {
  return goPathError(op, `${from} ${to}`, err);
}

/**
 * 把 opts.style 装进项目的 .agents/skills/am-film-style/。不联网：来源数据
 * 没就绪时由来源抛 prereq.MissingError。
 *
 * 先在同级临时目录让来源写好整棵技能树、校验契约，再整体换位：中途失败时项目里
 * 要么是旧风格、要么是新风格，不会半新半旧。装好后删掉旧目录（lemo-film-style）。
 */
export function install(opts: InstallOptions): InstallResult {
  const style = opts.style;
  const source = sourceByID(style.source);
  if (!source) throw new Error(`没有风格来源 ${goQuote(style.source)}`);
  const { manifest: previous, ok: had } = installed(opts.projectDir);
  if (had && manifestKey(previous) !== styleKey(style) && !opts.replace) {
    throw new Error(
      `项目已使用整片风格 ${previous.cn} ${previous.en}（${manifestKey(previous)}）。换成 ${styleLabel(style)} 会让全部镜头需要重渲染；确认要换就加 --replace`,
    );
  }
  const parent = path.dirname(skillDir(opts.projectDir));
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.' + SkillName + '-'));
  try {
    const version = source.fill(staging, style, opts.env ?? {});
    for (const required of [StyleFile, GuideFile]) {
      if (!exists(path.join(staging, required))) {
        throw new Error(`风格来源 ${source.id()} 没有写出 ${required}：违反整片风格契约`);
      }
    }
    const digest = treeDigest(staging);
    if (had && !previous.legacy && manifestKey(previous) === styleKey(style) && previous.digest === digest && previous.version === version) {
      return { manifest: previous, unchanged: true, replaced: '' };
    }
    const manifest: Manifest = {
      source: style.source,
      slug: style.slug,
      cn: style.cn,
      en: style.en,
      version,
      digest,
      installed_at: rfc3339(opts.now ?? new Date()),
      legacy: false,
    };
    const body = marshalIndent({
      source: manifest.source,
      slug: manifest.slug,
      cn: manifest.cn,
      en: manifest.en,
      version: manifest.version,
      digest: manifest.digest,
      installed_at: manifest.installed_at,
    });
    atomicWrite(path.join(staging, ManifestFile), body + '\n', 0o644);
    const target = skillDir(opts.projectDir);
    let backup = '';
    if (exists(target)) {
      backup = staging + '.old';
      try {
        fs.renameSync(target, backup);
      } catch (err) {
        throw new Error(`移开旧的整片风格：${linkError('rename', target, backup, err)}`, { cause: err });
      }
    }
    try {
      fs.renameSync(staging, target);
    } catch (err) {
      if (backup !== '') {
        try {
          fs.renameSync(backup, target);
        } catch {
          // 恢复失败不掩盖原错误。
        }
      }
      throw new Error(`放置整片风格：${linkError('rename', staging, target, err)}`, { cause: err });
    }
    if (backup !== '') fs.rmSync(backup, { recursive: true, force: true });
    // 旧目录与新目录并存的话，两份都会被当成整片风格；新的放好了就删旧的。
    try {
      fs.rmSync(legacyDir(opts.projectDir), { recursive: true, force: true });
    } catch {
      // 与 Go 版一样忽略错误。
    }
    const result: InstallResult = { manifest, unchanged: false, replaced: '' };
    if (had && manifestKey(previous) !== styleKey(style)) result.replaced = manifestKey(previous);
    return result;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 删除项目里的整片风格（新旧目录都删），回到镜头自主定视觉。 */
export function remove(projectDir: string): { manifest: Manifest; had: boolean } {
  const { manifest, ok } = installed(projectDir);
  if (!ok) return { manifest, had: false };
  fs.rmSync(skillDir(projectDir), { recursive: true, force: true });
  fs.rmSync(legacyDir(projectDir), { recursive: true, force: true });
  return { manifest, had: true };
}

/** 按名字排序的目录项，对应 os.ReadDir / filepath.WalkDir 的遍历顺序。 */
function sortedEntries(dir: string): fs.Dirent[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}

/** 目录下全部文件（按相对路径排序）的内容摘要，不含来源记录本身。 */
export function treeDigest(root: string): string {
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of sortedEntries(dir)) {
      const childRel = rel === '' ? entry.name : rel + '/' + entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile() && entry.name !== ManifestFile) files.push(childRel);
    }
  };
  walk(root, '');
  files.sort(compareBytes);
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
    hash.update(`${rel} ${sum}\n`);
  }
  return 'sha256:' + hash.digest('hex');
}
