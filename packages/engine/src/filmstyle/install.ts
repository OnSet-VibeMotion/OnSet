import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goPathError, goQuote } from '../gofmt';
import { marshalIndent } from '../gojson';
import { type Style, sourceByID, styleKey, styleLabel } from './filmstyle';
import {
  exists,
  extraDir,
  GuideFile,
  installed,
  type Manifest,
  ManifestFile,
  manifestKey,
  readManifest,
  StyleFile,
  skillDir,
  treeDigest,
} from './manifest';

export {
  changedAfter,
  ExtraSubdir,
  extraDir,
  GuideFile,
  installed,
  installedDir,
  installedExtras,
  type Manifest,
  ManifestFile,
  manifestKey,
  NoFilmStyle,
  PlanBehindStyleNote,
  readManifest,
  type SceneStyleUse,
  SkillName,
  SkillsSubdir,
  StyleFile,
  sceneStyles,
  scenesNaming,
  skillDir,
  splitKey,
  styleDirOf,
  treeDigest,
} from './manifest';

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
    if (
      had &&
      manifestKey(previous) === styleKey(style) &&
      previous.digest === digest &&
      previous.version === version
    ) {
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
export function removeStyle(
  projectDir: string,
  key: string,
): { manifest: Manifest | null; had: boolean; wasDefault: boolean } {
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
