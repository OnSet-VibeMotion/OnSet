import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../../envutil';
import { compareBytes } from '../../gojson';
import { goExt, goPathError } from '../../gofmt';
import type { Writer } from '../../hyperframes';
import { ExitError, abortReason } from '../../procgroup';
import { sourceDir } from '../filmstyle';
import { LibraryEnv, PinnedCommit, RepoURL, SourceID } from './lemo';

/** 一份风格库检出。 */
export interface Library {
  /** 检出根目录（含 core/、styles/）。 */
  dir: string;
  /** 检出的 commit；读不到时为空。 */
  commit: string;
  /**
   * 这份检出由 am 克隆（有 managedMarker）；
   * 为 false 时是用户自己的检出，am 不改动它的 git 状态。
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
 * 错误的文字（%w 的展开）。Node 的文件错误换成 Go *fs.PathError 的写法（open x: no such file or directory）。
 */
export function errorText(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e && typeof e === 'object' && typeof e.code === 'string' && typeof e.path === 'string' && typeof e.syscall === 'string') {
    return goPathError(e.syscall, e.path, e);
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * 默认的风格库目录：<风格根目录>/lemo-opuscar/<commit 前 12 位>。
 * 按 commit 分目录，升级 am 换了固定版本时新旧两份并存，老项目引用的那份不会被改写。
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

export function exists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
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

/**
 * 每一步网络操作的尝试次数。经代理时偶尔整条 TLS 握手失败
 * （SSL_ERROR_SYSCALL），重连一次就好，所以给得宽。
 */
export const stageAttempts = 5;

/** commit 下载并检出到 partial，已有的进度直接沿用。 */
async function downloadLibrary(git: string, partial: string, commit: string, opts: LibraryOptions, signal?: AbortSignal): Promise<void> {
  const run = (...args: string[]) => gitCommand(git, partial, opts.env, opts.output, args, signal);
  const retry = async (what: string, ...args: string[]) => {
    let last: unknown;
    for (let attempt = 1; attempt <= stageAttempts; attempt++) {
      try {
        await run(...args);
        return;
      } catch (err) {
        last = err;
      }
      if (signal?.aborted) throw abortReason(signal);
      if (opts.output && attempt < stageAttempts) opts.output.write(`${what}失败，重试（${attempt + 1}/${stageAttempts}）…\n`);
    }
    throw new Error(`${what}失败：${errorText(last)}`, { cause: last });
  };
  if (!exists(path.join(partial, '.git'))) {
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true });
    for (const step of [
      ['init', '--quiet'],
      ['remote', 'add', 'origin', repoOf(opts)],
      ['config', 'core.sparseCheckout', 'true'],
    ]) {
      try {
        await run(...step);
      } catch (err) {
        throw new Error(`准备风格库克隆（git ${step.join(' ')}）：${errorText(err)}`, { cause: err });
      }
    }
  } else {
    try {
      await run('remote', 'set-url', 'origin', repoOf(opts));
    } catch (err) {
      throw new Error(`更新风格库的上游地址：${errorText(err)}`, { cause: err });
    }
  }
  let haveCommit = true;
  try {
    await run('rev-parse', '--verify', '--quiet', commit + '^{commit}');
  } catch {
    haveCommit = false;
  }
  if (!haveCommit) {
    await retry('从 ' + repoOf(opts) + ' 下载风格库 ' + commit + ' ', 'fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', commit);
  }
  let head = '';
  try {
    head = await run('rev-parse', '--verify', '--quiet', 'HEAD');
  } catch {
    head = '';
  }
  if (head !== commit) {
    writeSparse(partial, libraryStages[0]!);
    await retry('检出风格库', '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', commit);
  }
  const stages = libraryStages;
  for (let i = 0; i < stages.length; i++) {
    writeSparse(partial, stages[i]!);
    // --reset：上一次在这一段中途断开时工作区可能只更新了一半，按 HEAD 重来。
    await retry(`检出风格库（第 ${i + 1}/${stages.length} 段）`, 'read-tree', '--reset', '-u', 'HEAD');
  }
  const finalHead = await run('rev-parse', 'HEAD');
  if (finalHead !== commit) throw new Error(`风格库检出到 ${finalHead}，与固定的 ${commit} 不符，拒绝使用`);
  if (!isLibrary(partial)) throw new Error(`风格库 ${commit} 上缺少 core/lib.js 或 styles/：上游目录结构已变`);
}

/**
 * 标记一份由 am 克隆的风格库：只有它的稀疏规则可以由 am 改。
 * 用户自己的检出没有这个文件，am 不碰它的 git 状态。
 * 不用「目录是不是默认目录」来判断：am 会把风格库目录经 LibraryEnv 显式传给
 * 子进程，子进程看到的总是显式指定。
 */
export const managedMarker = '.am-library';


export function writeSparse(dir: string, patterns: string[]): void {
  const info = path.join(dir, '.git', 'info');
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(path.join(info, 'sparse-checkout'), patterns.join('\n') + '\n', { mode: 0o644 });
}

export function readSparse(dir: string): string[] {
  const body = fs.readFileSync(path.join(dir, '.git', 'info', 'sparse-checkout'), 'utf8');
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** demo 里不带进项目的东西：审片截图、渲染产物与本地依赖。 */
export const skipInDemo = new Set(['stills', 'out', 'chk', 'node_modules']);

/** 按名字排序的目录项（os.ReadDir 的顺序）。 */
export function sortedEntries(dir: string): fs.Dirent[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}

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

/**
 * 在 dir 里运行 git，屏蔽用户 git 配置并跳过 LFS，返回去掉首尾空白的标准输出。
 * 非零退出抛 procgroup.ExitError（exit status N）；signal 取消时杀掉进程并抛取消原因。
 */
export function gitCommand(
  git: string,
  dir: string,
  env: Record<string, string>,
  stderr: Writer | undefined,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return runCommand(git, args, { cwd: dir, env: gitEnv(env), stderr, signal }).then((out) => out.trim());
}

interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** 标准输出接到这里；不给时收集起来作为返回值。 */
  stdout?: Writer;
  stderr?: Writer;
  signal?: AbortSignal;
}

/** 跑一个外部命令并等它结束，对应 exec.CommandContext(...).Output() / Run()。 */
export function runCommand(file: string, args: string[], options: CommandOptions = {}): Promise<string> {
  const { signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', options.stderr ? 'pipe' : 'ignore'],
    });
    let out = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (options.stdout) options.stdout.write(chunk);
      else out += chunk;
    });
    if (options.stderr) {
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => options.stderr!.write(chunk));
    }
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    let failed = false;
    child.once('error', (err) => {
      failed = true;
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (failed) return;
      if (signal?.aborted) reject(abortReason(signal));
      else if (sig) reject(new ExitError(-1, sig));
      else if (code !== 0) reject(new ExitError(code ?? -1, null));
      else resolve(out);
    });
  });
}

/**
 * 沿用 PATH 与代理，屏蔽用户的 git 配置：钩子、filter、autocrlf 会让
 * 同一个 commit 在不同机器上检出不同的树。
 */
export function gitEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...env };
  out.GIT_LFS_SKIP_SMUDGE = '1';
  out.GIT_CONFIG_GLOBAL = '/dev/null';
  out.GIT_CONFIG_SYSTEM = '/dev/null';
  out.GIT_TERMINAL_PROMPT = '0';
  // 连接被掐断时 git 的按需取文件（--filter=blob:none）不报错，只是一直挂着
  // （实测：检出时 fetch-pack 断开后整个 am 卡了半小时）。低于 1 KB/s 持续
  // 60 秒就放弃，让调用方拿到一个能重试的错误。用户显式设置时尊重用户的值。
  if (!out.GIT_HTTP_LOW_SPEED_LIMIT) out.GIT_HTTP_LOW_SPEED_LIMIT = '1000';
  if (!out.GIT_HTTP_LOW_SPEED_TIME) out.GIT_HTTP_LOW_SPEED_TIME = '60';
  return out;
}

/** 这么久之后的锁视为上一个进程崩溃留下的。 */
const lockStale = 30 * 60 * 1000;

/** 以独占创建锁文件的方式串行化对同一份风格库的改动。返回解锁函数。 */
export async function lock(file: string, signal?: AbortSignal): Promise<() => void> {
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o644);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(file);
        } catch {
          // 已经没了。
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`创建锁 ${file}：${goPathError('open', file, err)}`, { cause: err });
      }
    }
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > lockStale) {
        fs.rmSync(file, { force: true });
        continue;
      }
    } catch {
      // 锁刚被释放，重试。
    }
    if (signal?.aborted) throw abortReason(signal);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, 200);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal!));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** 风格库里某种风格海报的路径（不保证存在）。 */
export function posterPath(lib: Library, slug: string): string {
  return path.join(lib.dir, 'styles', slug, 'poster.jpg');
}
