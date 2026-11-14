//
// anidoodle 检出的位置、下载与检查。数据是前置资源：只由 onset setup 经 prepareLibrary 下载并构建（build.ts），
// 其余地方只用 requireLibrary 检查，缺了抛 prereq.MissingError，不联网。
//
// 只稀疏检出要用的部分（约 2 MB）：许可、风格说明、几份通用说明、每种风格要带的引擎模块与图鉴。
// 仓库其余的部分（README 的动图与视频、配乐采样、发布片模板、测试）不下载。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../../envutil';
import type { Writer } from '../../hyperframes';
import { missing } from '../../prereq';
import { sourceDir, type PrepareProgress } from '../../filmstyle';
import { errorText, exists, gitEnv, lock, sparseDownload } from '../../filmstyle/gitlib';
import { EngineSrc, LibraryEnv, PinnedCommit, RepoURL, SkillRoot, SourceID, catalogFile, type Catalog } from './anidoodle';
import { build, buildComplete, buildDir } from './build';

/** 一份 anidoodle 检出。 */
export interface Library {
  dir: string;
  /** 检出的 commit；读不到时为空。 */
  commit: string;
  /** 由 onset 克隆（有 managedMarker）；为 false 时是用户自己的检出，onset 不改它。 */
  managed: boolean;
}

export interface LibraryOptions {
  env: Record<string, string>;
  /** 留空取 RepoURL；测试指向本地夹具仓库。 */
  repoURL?: string;
  /** 留空取 PinnedCommit。 */
  commit?: string;
  /** 留空取随程序下发的 catalog.json；测试用小目录。 */
  catalog?: Catalog;
  output?: Writer;
}

/** 标记一份由 onset 克隆的检出。 */
export const managedMarker = '.onset-library';

function commitOf(opts: LibraryOptions): string {
  return opts.commit || PinnedCommit;
}

/** 默认目录：<风格根目录>/anidoodle/<commit 前 12 位>，升级固定版本时新旧并存。 */
export function defaultLibraryDir(env: Record<string, string | undefined>, commit: string): string {
  return path.join(sourceDir(env, SourceID), commit.slice(0, 12));
}

/** 本次要用的检出目录：LibraryEnv 优先，否则默认目录。 */
export function libraryDir(opts: LibraryOptions): string {
  return opts.env[LibraryEnv] || defaultLibraryDir(opts.env, commitOf(opts));
}

function isLibrary(dir: string): boolean {
  return exists(path.join(dir, EngineSrc, 'canvas-core', 'core.ts')) && exists(path.join(dir, SkillRoot, 'references', 'styles'));
}

/** 检出的几段稀疏规则（非 cone 模式），逐段扩大：先说明与许可，再模块，最后图鉴。 */
export function libraryStages(catalog: Catalog): string[][] {
  const base = [
    '/LICENSE',
    '/NOTICE',
    `/${SkillRoot}/SKILL.md`,
    `/${SkillRoot}/references/styles/`,
    `/${SkillRoot}/engine/styles.gen.json`,
    ...catalog.references.map((ref) => '/' + ref),
  ];
  const modules = [...new Set(catalog.styles.flatMap((s) => s.modules))].sort().map((rel) => `/${EngineSrc}/${rel}`);
  return [base, [...base, ...modules], [...base, ...modules, '/' + catalog.sheet.path]];
}

/** 已有的检出，不联网；没有时抛错。 */
export function openLibrary(opts: LibraryOptions): Library {
  const dir = libraryDir(opts);
  if (!isLibrary(dir)) throw new Error(`anidoodle 检出 ${dir} 还没有下载`);
  const lib: Library = { dir, commit: '', managed: exists(path.join(dir, managedMarker)) };
  let git: string | undefined;
  try {
    git = lookPath('git', opts.env.PATH ?? '');
  } catch {
    git = undefined;
  }
  if (git !== undefined) {
    const result = spawnSync(git, ['rev-parse', 'HEAD'], { cwd: dir, env: gitEnv(opts.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status === 0 && !result.error) lib.commit = result.stdout.trim();
  }
  if (lib.managed && lib.commit === '') {
    // 没有 git 也要认得 onset 自己克隆的版本：标记里记着 commit。
    lib.commit = fs.readFileSync(path.join(dir, managedMarker), 'utf8').trim();
  }
  return lib;
}

/** 下载好并构建过的检出，否则抛 prereq.MissingError。 */
export function requireLibrary(opts: LibraryOptions): Library {
  let lib: Library;
  try {
    lib = openLibrary(opts);
  } catch {
    throw missing('anidoodle 风格库', '没有下载到 ' + libraryDir(opts));
  }
  if (!buildComplete(lib, opts.env)) throw missing('anidoodle 风格库', lib.dir + ' 还没有准备完整');
  return lib;
}

/** 返回可用的检出，没有时按固定 commit 稀疏克隆（可续传，同一时间只有一个进程在下）。 */
export async function ensureLibrary(opts: LibraryOptions, signal?: AbortSignal): Promise<Library> {
  try {
    return openLibrary(opts);
  } catch {
    // 没有，往下走。
  }
  const dir = libraryDir(opts);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // 不存在。
  }
  if (entries.length > 0) throw new Error(`${dir} 不是 anidoodle 检出（缺少 ${EngineSrc}/canvas-core/core.ts）`);
  let git: string;
  try {
    git = lookPath('git', opts.env.PATH ?? '');
  } catch (err) {
    throw new Error(`找不到 git，无法下载 anidoodle：${errorText(err)}`, { cause: err });
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const unlock = await lock(dir + '.lock', signal);
  try {
    try {
      return openLibrary(opts);
    } catch {
      // 还没有。
    }
    const partial = dir + '.partial';
    const commit = commitOf(opts);
    const repoURL = opts.repoURL || RepoURL;
    try {
      await sparseDownload({ git, dir: partial, repoURL, commit, env: opts.env, output: opts.output, stages: libraryStages(opts.catalog ?? catalogFile()) }, signal);
      if (!isLibrary(partial)) throw new Error(`anidoodle ${commit} 上缺少 ${EngineSrc}/canvas-core/core.ts：上游目录结构已变`);
    } catch (err) {
      throw new Error(
        `${errorText(err)}\n已下载的部分保留在 ${partial}，再运行一次会接着下载；也可以自己 git clone ${repoURL.replace(/\.git$/, '')} 后用 ${LibraryEnv} 指向它`,
        { cause: err },
      );
    }
    fs.writeFileSync(path.join(partial, managedMarker), commit + '\n', { mode: 0o644 });
    try {
      fs.rmdirSync(dir);
    } catch {
      // 不存在或非空。
    }
    fs.renameSync(partial, dir);
    return { dir, commit, managed: true };
  } finally {
    unlock();
  }
}

export interface PrepareOptions extends LibraryOptions {
  progress?: (p: PrepareProgress) => void;
}

/** onset setup：下载、转换、裁海报。已完整的直接返回。用户自己的检出只构建，不改它。 */
export async function prepareLibrary(opts: PrepareOptions, signal?: AbortSignal): Promise<Library> {
  const report = opts.progress ?? (() => {});
  const steps = 3;
  report({ step: 1, steps, stage: '下载 anidoodle（风格说明与绘图模块）' });
  const lib = await ensureLibrary(opts, signal);
  if (lib.commit !== commitOf(opts)) {
    throw new Error(`${lib.dir} 检出的是 ${lib.commit || '未知版本'}，onset 要的是 ${commitOf(opts)}${lib.managed ? '' : `：请在你的检出里切到这个 commit，或去掉 ${LibraryEnv}`}`);
  }
  let step = 1;
  await build(lib, { env: opts.env, catalog: opts.catalog, stage: (what) => report({ step: ++step, steps, stage: what }) }, signal);
  return lib;
}

export { buildDir };
