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
  if (parts.length !== 2 || parts.some((p) => p === '' || p === '.' || p === '..' || /\s/.test(p) || p.includes('\\'))) {
    throw new Error(`风格标识要写成「来源/目录名」，收到 ${goQuote(key)}`);
  }
  return [parts[0], parts[1]];
}

function exists(file: string): boolean {
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
  /**
   * extra：装成额外风格（个别镜头用），不动默认风格。不给时装成默认风格。
   */
  as?: 'default' | 'extra';
  /**
   * 换掉默认风格时，把旧的默认风格留作额外风格而不是删掉：还有镜头点名用它时要这样，
   * 否则那些镜头渲染时找不到风格。
   */
  keepReplaced?: boolean;
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
 * 把 opts.style 装进项目：默认装成默认风格（.agents/skills/onset-film-style/），
 * as: 'extra' 时装成额外风格（.agents/onset-film-styles/<来源>/<目录名>/）。不联网：来源数据
 * 没就绪时由来源抛 prereq.MissingError。
 *
 * 先在同级临时目录让来源写好整棵技能树、校验契约，再整体换位：中途失败时项目里
 * 要么是旧风格、要么是新风格，不会半新半旧。
 */
export function install(opts: InstallOptions): InstallResult {
  const style = opts.style;
  const source = sourceByID(style.source);
  if (!source) throw new Error(`没有风格来源 ${goQuote(style.source)}`);
  const asExtra = opts.as === 'extra';
  const { manifest: currentDefault, ok: hasDefault } = installed(opts.projectDir);
  let previous: Manifest;
  let had: boolean;
  let target: string;
  if (asExtra) {
    if (hasDefault && manifestKey(currentDefault) === styleKey(style)) {
      throw new Error(`${styleLabel(style)} 已经是本项目的默认风格，镜头不写 film_style 就会用它`);
    }
    target = extraDir(opts.projectDir, styleKey(style));
    const found = readManifest(path.join(target, ManifestFile));
    previous = found ?? currentDefault;
    had = found !== null;
  } else {
    previous = currentDefault;
    had = hasDefault;
    target = skillDir(opts.projectDir);
    if (had && manifestKey(previous) !== styleKey(style) && !opts.replace) {
      throw new Error(
        `项目已使用整片风格 ${previous.cn} ${previous.en}（${manifestKey(previous)}）。换成 ${styleLabel(style)} 会让全部镜头需要重渲染；确认要换就加 --replace`,
      );
    }
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.' + path.basename(target) + '-'));
  try {
    const version = source.fill(staging, style, opts.env ?? {});
    for (const required of [StyleFile, GuideFile]) {
      if (!exists(path.join(staging, required))) {
        throw new Error(`风格来源 ${source.id()} 没有写出 ${required}：违反整片风格契约`);
      }
    }
    const digest = treeDigest(staging);
    if (had && manifestKey(previous) === styleKey(style) && previous.digest === digest && previous.version === version) {
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
    const replacedKey = had && manifestKey(previous) !== styleKey(style) ? manifestKey(previous) : '';
    if (backup !== '') {
      // 换掉的默认风格还有镜头点名在用：留作额外风格，不删。
      if (!asExtra && replacedKey !== '' && opts.keepReplaced) {
        const keep = extraDir(opts.projectDir, replacedKey);
        fs.rmSync(keep, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(keep), { recursive: true });
        fs.renameSync(backup, keep);
      } else {
        fs.rmSync(backup, { recursive: true, force: true });
      }
    }
    if (!asExtra) {
      // 新的默认风格原先是额外风格时，那份额外的就多余了：点名它的镜头现在落到默认目录上。
      removeExtraDir(opts.projectDir, styleKey(style));
    }
    return { manifest, unchanged: false, replaced: asExtra ? '' : replacedKey };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 删掉一份额外风格，连同空下来的来源目录。 */
function removeExtraDir(projectDir: string, key: string): boolean {
  const dir = extraDir(projectDir, key);
  if (!exists(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(dir));
  } catch {
    // 来源目录里还有别的风格。
  }
  return true;
}

/** 删掉项目里的某种风格（默认或额外）；没装时 had 为 false。 */
export function removeStyle(projectDir: string, key: string): { manifest: Manifest | null; had: boolean; wasDefault: boolean } {
  const { manifest, ok } = installed(projectDir);
  if (ok && manifestKey(manifest) === key) {
    remove(projectDir);
    return { manifest, had: true, wasDefault: true };
  }
  const extra = readManifest(path.join(extraDir(projectDir, key), ManifestFile));
  if (!extra) return { manifest: null, had: false, wasDefault: false };
  removeExtraDir(projectDir, key);
  return { manifest: extra, had: true, wasDefault: false };
}

/** 删除项目的默认风格，不写 film_style 的镜头回到自主定视觉。额外风格不动。 */
export function remove(projectDir: string): { manifest: Manifest; had: boolean } {
  const { manifest, ok } = installed(projectDir);
  if (!ok) return { manifest, had: false };
  fs.rmSync(skillDir(projectDir), { recursive: true, force: true });
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
