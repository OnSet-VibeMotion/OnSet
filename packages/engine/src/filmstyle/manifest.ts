import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { goPathError, goQuote } from '../gofmt';
import { compareBytes } from '../gojson';

/** 技能在项目里的落点，与 hyperframes.SkillsSubdir 一致。 */
export const SkillsSubdir = '.agents/skills';

/**
 * 整片风格在项目 .agents/skills/ 下的目录名。
 *
 * 带 onset- 前缀而不叫 film-style：技能解析会从镜头目录逐级向上找 .agents/skills，
 * 名字太通用容易撞上用户自己装的别的技能。
 */
export const SkillName = 'onset-film-style';

/** 整片风格技能目录里的来源记录。 */
export const ManifestFile = 'onset-film-style.json';

/** 契约里的两份必需文件。 */
export const StyleFile = 'STYLE.md';
export const GuideFile = 'SKILL.md';

/** onset-film-style.json：这个项目装的是哪个来源的哪种风格。字段名照抄 Go 的 JSON tag。 */
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
}

/** <来源>/<目录名>。 */
export function manifestKey(manifest: Pick<Manifest, 'source' | 'slug'>): string {
  return manifest.source + '/' + manifest.slug;
}

/** 项目里整片风格技能目录的路径（默认风格）。 */
export function skillDir(projectDir: string): string {
  return path.join(projectDir, SkillsSubdir, SkillName);
}

/**
 * 默认风格之外、个别镜头用的风格装在这里：.agents/onset-film-styles/<来源>/<目录名>/。
 *
 * 不放进 .agents/skills：镜头的输入指纹把整个 .agents/skills 算成一份摘要，
 * 装在那里的话给项目添一种风格，所有镜头都会变成 Stale。放在这里，只有用到它的镜头
 * 才把它算进指纹（scene.resolveAllSkills）。契约与默认风格相同（STYLE.md + SKILL.md + 来源记录）。
 */
export const ExtraSubdir = '.agents/onset-film-styles';

/** 额外风格在项目里的目录。 */
export function extraDir(projectDir: string, key: string): string {
  const [source, slug] = splitKey(key);
  return path.join(projectDir, ExtraSubdir, source, slug);
}

/** 镜头 scene.json 里 film_style 写 none 表示这个镜头不用任何整片风格。 */
export const NoFilmStyle = 'none';

/** 拆开「来源/目录名」；写法不对时报错。 */
export function splitKey(key: string): [string, string] {
  const parts = key.split('/');
  if (
    parts.length !== 2 ||
    parts.some((p) => p === '' || p === '.' || p === '..' || /\s/.test(p) || p.includes('\\'))
  ) {
    throw new Error(`风格标识要写成「来源/目录名」，收到 ${goQuote(key)}`);
  }
  return [parts[0], parts[1]];
}

export function exists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 项目里实际装着整片风格的目录；没有时为空。 */
export function installedDir(projectDir: string): string {
  if (exists(path.join(skillDir(projectDir), ManifestFile))) return skillDir(projectDir);
  return '';
}

/**
 * 默认风格在 t（毫秒）之后装上或换过：manifest 每次 film_style_use 都重写，看它的修改时间。没装为 false。
 * 制作路线用它判断分镜是不是照旧的视觉写的（分镜写好之后才定风格、或换了风格，镜头语言要按新风格改）。
 */
export function changedAfter(projectDir: string, t: number): boolean {
  try {
    return fs.statSync(path.join(skillDir(projectDir), ManifestFile)).mtimeMs > t;
  } catch {
    return false;
  }
}

/** 分镜比默认风格旧时，制作路线上「上游改过」的说明。 */
export const PlanBehindStyleNote = '整片风格是在分镜写好之后定的（或换过），镜头语言要按新风格改一遍';

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
  if (typeof value !== 'string') {
    throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go struct field .${name} of type string`);
  }
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
  const empty: Manifest = { source: '', slug: '', cn: '', en: '', version: '', digest: '', installed_at: '' };
  const body = readOptional(path.join(skillDir(projectDir), ManifestFile));
  if (body === undefined) return { manifest: empty, ok: false };
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
      },
      ok: true,
    };
  } catch (err) {
    throw new Error(`${ManifestFile} 损坏：${errorText(err)}`, { cause: err });
  }
}

/** 读指定风格的来源记录（默认与额外风格共用）；没有文件时返回 null。 */
export function readManifest(file: string): Manifest | null {
  const body = readOptional(file);
  if (body === undefined) return null;
  let raw: Record<string, unknown>;
  try {
    raw = decodeObject(body);
  } catch (err) {
    throw new Error(`${file} 损坏：${errorText(err)}`, { cause: err });
  }
  return {
    source: stringField(raw, 'source'),
    slug: stringField(raw, 'slug'),
    cn: stringField(raw, 'cn'),
    en: stringField(raw, 'en'),
    version: stringField(raw, 'version'),
    digest: stringField(raw, 'digest'),
    installed_at: stringField(raw, 'installed_at'),
  };
}

/** 项目里装的额外风格（不含默认风格），按标识排序。 */
export function installedExtras(projectDir: string): Manifest[] {
  const root = path.join(projectDir, ExtraSubdir);
  const out: Manifest[] = [];
  let sources: fs.Dirent[];
  try {
    sources = sortedEntries(root);
  } catch {
    return out;
  }
  for (const source of sources) {
    if (!source.isDirectory() || source.name.startsWith('.')) continue;
    for (const slug of sortedEntries(path.join(root, source.name))) {
      if (!slug.isDirectory() || slug.name.startsWith('.')) continue;
      const manifest = readManifest(path.join(root, source.name, slug.name, ManifestFile));
      if (manifest) out.push(manifest);
    }
  }
  return out;
}

/** 项目里某种风格所在的目录（默认风格或额外风格）；没装时为空串。 */
export function styleDirOf(projectDir: string, key: string): string {
  const { manifest, ok } = installed(projectDir);
  if (ok && manifestKey(manifest) === key) return installedDir(projectDir);
  const dir = extraDir(projectDir, key);
  return exists(path.join(dir, ManifestFile)) ? dir : '';
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
    const sum = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(root, rel)))
      .digest('hex');
    hash.update(`${rel} ${sum}\n`);
  }
  return 'sha256:' + hash.digest('hex');
}

/** 项目里一个镜头点名的风格（scene.json 的 film_style）。 */
export interface SceneStyleUse {
  /** 镜头目录名（scenes/ 下）。 */
  dir: string;
  id: string;
  /** film_style 原值：空表示默认风格，none 表示不用整片风格。 */
  film_style: string;
}

/**
 * 读 <项目>/scenes/<镜头>/scene.json 的 film_style，按目录名排序。只认 id 与 film_style 两个字段、
 * 读不了的镜头跳过：这里只用来回答「去掉 / 换掉这种风格会影响哪些镜头」，镜头本身的合法性由
 * scene.load 负责。filmstyle 不依赖 scene，所以不调 scene.load。
 */
export function sceneStyles(projectDir: string): SceneStyleUse[] {
  const root = path.join(projectDir, 'scenes');
  let entries: fs.Dirent[];
  try {
    entries = sortedEntries(root);
  } catch {
    return [];
  }
  const out: SceneStyleUse[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(root, entry.name, 'scene.json'), 'utf8'));
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    out.push({
      dir: entry.name,
      id: typeof obj.id === 'string' ? obj.id : entry.name,
      film_style: typeof obj.film_style === 'string' ? obj.film_style : '',
    });
  }
  return out;
}

/** 点名用某种风格（写了「来源/目录名」）的镜头 id。 */
export function scenesNaming(projectDir: string, key: string): string[] {
  return sceneStyles(projectDir)
    .filter((s) => s.film_style === key)
    .map((s) => s.id);
}
