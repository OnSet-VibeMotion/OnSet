import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../../envutil';
import { goExt } from '../../gofmt';
import type { Writer } from '../../hyperframes';
import { sourceDir } from '../../filmstyle';
import { errorText, exists, gitEnv, lock, sortedEntries, sparseDownload } from '../../filmstyle/gitlib';
import { LibraryEnv, PinnedCommit, RepoURL, SourceID } from './lemo';

// 通用的下载零件在 filmstyle/gitlib.ts（anidoodle 来源也用），这里照旧转出，lemo 的调用方不用改。
export {
  errorText,
  exists,
  gitCommand,
  gitEnv,
  lock,
  readSparse,
  runCommand,
  sortedEntries,
  stageAttempts,
  writeSparse,
} from '../../filmstyle/gitlib';

/** 一份风格库检出。 */
export interface Library {
  /** 检出根目录（含 core/、styles/）。 */
  dir: string;
  /** 检出的 commit；读不到时为空。 */
  commit: string;
  /**
   * 这份检出由 onset 克隆（有 managedMarker）；
   * 为 false 时是用户自己的检出，onset 不改动它的 git 状态。
   */
  managed: boolean;
}

/** 一次风格库准备。 */
export interface LibraryOptions {
  /** 当前进程环境：PATH、代理、HOME / XDG_DATA_HOME 与 LibraryEnv。 */
  env: Record<string, string>;
  /** 留空取 RepoURL；测试指向本地夹具仓库。 */
  repoURL?: string;
  /** 留空取 PinnedCommit。 */
  commit?: string;
  /** 接收 git 的错误输出。 */
  output?: Writer;
}

function repoOf(opts: LibraryOptions): string {
  return opts.repoURL || RepoURL;
}

function commitOf(opts: LibraryOptions): string {
  return opts.commit || PinnedCommit;
}

/**
 * 默认的风格库目录：<风格根目录>/lemo-opuscar/<commit 前 12 位>。
 * 按 commit 分目录，升级 onset 换了固定版本时新旧两份并存，老项目引用的那份不会被改写。
 */
export function defaultLibraryDir(env: Record<string, string | undefined>, commit: string): string {
  if (commit.length > 12) commit = commit.slice(0, 12);
  return path.join(sourceDir(env, SourceID), commit);
}

/** 本次要用的风格库目录：LibraryEnv 优先，否则默认目录。 */
export function libraryDir(opts: LibraryOptions): string {
  const dir = opts.env[LibraryEnv];
  if (dir) return dir;
  return defaultLibraryDir(opts.env, commitOf(opts));
}

function isLibrary(dir: string): boolean {
  return ['core/lib.js', 'styles'].every((rel) => exists(path.join(dir, rel)));
}

/** 风格库还没有下载（对应 Go 包着 os.ErrNotExist 的错误）。 */
export class LibraryNotFoundError extends Error {
  readonly code = 'ENOENT';
  constructor(readonly dir: string) {
    super(`风格库 ${dir} 还没有下载：file does not exist`);
    this.name = 'LibraryNotFoundError';
  }
}

function lookGit(env: Record<string, string>): string | undefined {
  try {
    return lookPath('git', env.PATH ?? '');
  } catch {
    return undefined;
  }
}

/** 已有的风格库，不联网；没有时抛 LibraryNotFoundError。 */
export function openLibrary(opts: LibraryOptions): Library {
  const dir = libraryDir(opts);
  if (!isLibrary(dir)) throw new LibraryNotFoundError(dir);
  const lib: Library = { dir, commit: '', managed: exists(path.join(dir, managedMarker)) };
  const git = lookGit(opts.env);
  if (git !== undefined) {
    const result = spawnSync(git, ['rev-parse', 'HEAD'], { cwd: dir, env: gitEnv(opts.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status === 0 && !result.error) lib.commit = result.stdout.trim();
  }
  return lib;
}

/**
 * 返回可用的风格库，没有时按固定 commit 稀疏克隆。
 *
 * 只检出指南、core/、tools/ 与每种风格的 STYLE.md / style.json / DEMO.md；
 * demo 源码、海报与图鉴由 prepareLibrary 之后的几段补，与上游 setup.sh 的
 * 稀疏规则一致。
 *
 * 下载可以续传：克隆在固定的 <目录>.partial 里进行，失败时保留，下次接着下。
 * --filter=blob:none 的文件内容是检出时一批取回的，一批里断一次整批白下，
 * 所以检出分成 libraryStages 几段逐段扩大稀疏规则，每段取回的文件留在本地，
 * 每段各自重试。全部完成、校验过 commit 后才整体改名进位，别处看到的风格库
 * 永远是完整的。同一时间只有一个进程在下（锁文件）。
 */
export async function ensureLibrary(opts: LibraryOptions, signal?: AbortSignal): Promise<Library> {
  try {
    return openLibrary(opts);
  } catch {
    // 没有，往下走。
  }
  const dir = libraryDir(opts);
  // 用户经 LibraryEnv 指向的已有目录不是风格库时不往里克隆：那多半是指错了地方。
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // 不存在或读不了，按空目录处理。
  }
  if (entries.length > 0) throw new Error(`${dir} 不是 lemo-opuscar 风格库（缺少 core/lib.js 或 styles/）`);
  let git: string;
  try {
    git = lookPath('git', opts.env.PATH ?? '');
  } catch (err) {
    throw new Error(`找不到 git，无法下载风格库：${errorText(err)}`, { cause: err });
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const unlock = await lock(dir + '.lock', signal);
  try {
    // 等锁期间另一个进程可能已经下完了。
    try {
      return openLibrary(opts);
    } catch {
      // 还没有。
    }
    const partial = dir + '.partial';
    const commit = commitOf(opts);
    try {
      await downloadLibrary(git, partial, commit, opts, signal);
    } catch (err) {
      throw new Error(
        `${errorText(err)}\n已下载的部分保留在 ${partial}，再运行一次会接着下载；也可以自己 git clone ${repoOf(opts).replace(/\.git$/, '')} 后用 ${LibraryEnv} 指向它`,
        { cause: err },
      );
    }
    fs.writeFileSync(path.join(partial, managedMarker), commit + '\n', { mode: 0o644 });
    // 空目录（例如开工前预先建好的）挡不住改名。
    try {
      fs.rmdirSync(dir);
    } catch {
      // 不存在或非空，忽略。
    }
    try {
      fs.renameSync(partial, dir);
    } catch (err) {
      throw new Error(`放置风格库到 ${dir}：rename ${partial} ${dir}: ${errorText(err)}`, { cause: err });
    }
    return { dir, commit, managed: true };
  } finally {
    unlock();
  }
}

/** 风格库的稀疏检出规则（非 cone 模式）。 */
export const librarySparse: string[] = [
  '/*',
  '!/styles/*/demo/',
  '!/styles/*/poster.jpg',
  '!/styleboard/',
  '!/docs/',
  '!/core/assets/',
];

/**
 * 检出的几段稀疏规则，逐段扩大，最后一段等于 librarySparse。
 * 先取体积小、立刻要用的（顶层文件、core/ 的代码、每种风格的说明），
 * 体积大的（core/assets/ 等）放最后。
 */
export const libraryStages: string[][] = [
  ['/*', '!/*/'],
  ['/*', '!/*/', '/core/', '!/core/assets/'],
  ['/*', '!/*/', '/core/', '!/core/assets/', '/styles/*/STYLE.md', '/styles/*/style.json', '/styles/*/DEMO.md'],
  librarySparse,
];

/** commit 下载并检出到 partial，已有的进度直接沿用。 */
async function downloadLibrary(git: string, partial: string, commit: string, opts: LibraryOptions, signal?: AbortSignal): Promise<void> {
  await sparseDownload({ git, dir: partial, repoURL: repoOf(opts), commit, env: opts.env, output: opts.output, stages: libraryStages }, signal);
  if (!isLibrary(partial)) throw new Error(`风格库 ${commit} 上缺少 core/lib.js 或 styles/：上游目录结构已变`);
}

/**
 * 标记一份由 onset 克隆的风格库：只有它的稀疏规则可以由 onset 改。
 * 用户自己的检出没有这个文件，onset 不碰它的 git 状态。
 * 不用「目录是不是默认目录」来判断：onset 会把风格库目录经 LibraryEnv 显式传给
 * 子进程，子进程看到的总是显式指定。
 */
export const managedMarker = '.onset-library';

/** demo 里不带进项目的东西：审片截图、渲染产物与本地依赖。 */
export const skipInDemo = new Set(['stills', 'out', 'chk', 'node_modules']);

/** demo 源码是否引用风格库的 core/assets/（Poly Haven 模型与贴图）。 */
export function demoUsesCoreAssets(demo: string): boolean {
  // 对应 Go 版的 WalkDir：根目录读不了时为 false，找到一处即停。
  const walk = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = sortedEntries(dir);
    } catch {
      return false;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipInDemo.has(entry.name)) continue;
        if (walk(file)) return true;
        continue;
      }
      switch (goExt(file).toLowerCase()) {
        case '.js':
        case '.mjs':
        case '.html':
        case '.json':
          break;
        default:
          continue;
      }
      try {
        if (fs.readFileSync(file, 'utf8').includes('core/assets/')) return true;
      } catch {
        // 读不了就跳过。
      }
    }
    return false;
  };
  let root: fs.Stats;
  try {
    root = fs.lstatSync(demo);
  } catch {
    return false;
  }
  if (!root.isDirectory()) return false;
  if (skipInDemo.has(path.basename(demo))) return false;
  return walk(demo);
}

/** 风格库里某种风格海报的路径（不保证存在）。 */
export function posterPath(lib: Library, slug: string): string {
  return path.join(lib.dir, 'styles', slug, 'poster.jpg');
}
