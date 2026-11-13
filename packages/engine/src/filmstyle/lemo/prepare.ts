// 移植自 internal/filmstyle/lemo/prepare.go 与 setup.go。
//
// 风格库是前置资源：只由 am setup 经 prepareLibrary 一次下全（全部风格的说明、
// demo 源码、海报、core/assets 模型，以及 three.js 风格要的 Node 依赖），其余地方只用
// requireLibrary / requireStyle 检查，缺了抛 prereq.MissingError，不联网。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../../envutil';
import type { Writer } from '../../hyperframes';
import { missing } from '../../prereq';
import type { PrepareProgress } from '../filmstyle';

/** prepareLibrary 的进度，与 filmstyle 的通用进度相同。 */
export type { PrepareProgress };
import { catalog, entryLabel, type Entry } from './lemo';
import {
  ensureLibrary,
  errorText,
  exists,
  gitCommand,
  libraryDir,
  lock,
  openLibrary,
  posterPath,
  readSparse,
  runCommand,
  stageAttempts,
  writeSparse,
  type Library,
  type LibraryOptions,
} from './library';

/** 记录风格库已完整下载（am 管理的风格库才有）。 */
const completeMarker = 'am-complete';

/** 完整检出的稀疏规则：除图鉴与文档图片以外的全部内容。 */
const fullSparse = ['/*', '!/styleboard/', '!/docs/'];

/**
 * 每批检出的 demo 数。demo 合计约 73 MB，一批里断一次整批白下，
 * 分批后已取回的留在本地。
 */
const demoBatch = 10;

/** 一次完整准备。 */
export interface PrepareOptions extends LibraryOptions {
  /** 非空时每进一步汇报一次。 */
  progress?: (p: PrepareProgress) => void;
}

/**
 * 风格库已完整可用：am 管理的看完成记录；用户自己的检出
 * 看第一种风格的 demo 与海报在不在（它的 git 状态 am 不碰）。
 */
export function libraryComplete(lib: Library): boolean {
  if (lib.managed) return exists(path.join(lib.dir, '.git', completeMarker));
  const entries = catalog();
  if (entries.length === 0) return false;
  const first = entries[0]!.slug;
  return exists(path.join(lib.dir, 'styles', first, 'demo', 'index.html')) && exists(posterPath(lib, first));
}

/** 完整可用的风格库，否则抛 prereq.MissingError。 */
export function requireLibrary(opts: LibraryOptions): Library {
  let lib: Library;
  try {
    lib = openLibrary(opts);
  } catch {
    throw missing('lemo-opuscar 风格库', '没有下载到 ' + libraryDir(opts));
  }
  if (!libraryComplete(lib)) throw missing('lemo-opuscar 风格库', lib.dir + ' 还没下载完整');
  return lib;
}

/** 检查装 style 要用的东西都在风格库里：demo 源码，以及 three.js 风格的 three。 */
export function requireStyle(lib: Library, style: Entry): void {
  if (!exists(path.join(lib.dir, 'styles', style.slug, 'demo', 'index.html'))) {
    throw missing('风格 ' + entryLabel(style) + ' 的 demo 源码', '风格库 ' + lib.dir + ' 里没有');
  }
  if (style.three_js && !exists(path.join(lib.dir, 'node_modules', 'three', 'build', 'three.module.js'))) {
    throw missing('风格库的 three.js 依赖', entryLabel(style) + ' 要用，风格库里还没有 node_modules/three');
  }
}

/**
 * 把风格库完整下载好（am setup 用）：先按 ensureLibrary 的几段取基础部分，
 * 再取海报、按批取 demo、取 core/assets，最后装 three.js 依赖。每段各自重试、断了重跑
 * 接着下；已完整的直接返回。用户自己的检出只检查不下载。
 */
export async function prepareLibrary(opts: PrepareOptions, signal?: AbortSignal): Promise<Library> {
  const report = opts.progress ?? (() => {});
  try {
    const existing = openLibrary(opts);
    if (libraryComplete(existing)) return existing;
  } catch {
    // 还没有，往下走。
  }
  const entries = catalog();
  const batches = Math.floor((entries.length + demoBatch - 1) / demoBatch);
  const steps = 1 + 1 + batches + 1 + 1; // 基础、海报、demo 各批、core/assets、Node 依赖
  let step = 0;
  const next = (stage: string) => {
    step++;
    report({ step, steps, stage });
  };
  next('下载风格库基础部分（指南、core/、全部风格说明）');
  const lib = await ensureLibrary(opts, signal);
  if (!lib.managed) {
    if (!libraryComplete(lib)) {
      throw new Error(`${lib.dir} 是你自己的检出，am 不改它：请在里面检出全部 demo 与海报（styles/*/demo、styles/*/poster.jpg）`);
    }
    return lib;
  }
  let git: string;
  try {
    git = lookPath('git', opts.env.PATH ?? '');
  } catch (err) {
    throw new Error(`找不到 git，无法下载风格库：${errorText(err)}`, { cause: err });
  }
  const unlock = await lock(lib.dir + '.lock', signal);
  try {
    let patterns: string[];
    try {
      patterns = readSparse(lib.dir);
    } catch (err) {
      throw new Error(`读取风格库稀疏规则：${errorText(err)}`, { cause: err });
    }
    const stage = async (what: string, ...add: string[]) => {
      for (const pattern of add) {
        // 非 cone 规则后写的生效，盖过前面的排除。
        if (!patterns.includes(pattern)) patterns.push(pattern);
      }
      writeSparse(lib.dir, patterns);
      let readErr: unknown;
      for (let attempt = 1; attempt <= stageAttempts; attempt++) {
        try {
          await gitCommand(git, lib.dir, opts.env, opts.output, ['read-tree', '--reset', '-u', 'HEAD'], signal);
          readErr = undefined;
          break;
        } catch (err) {
          readErr = err;
        }
        if (signal?.aborted) break;
        if (opts.output && attempt < stageAttempts) opts.output.write(`${what}失败，重试（${attempt + 1}/${stageAttempts}）…\n`);
      }
      if (readErr !== undefined) {
        throw new Error(`${what}失败（再运行一次会接着下载）：${errorText(readErr)}`, { cause: readErr });
      }
    };
    next('下载风格海报');
    await stage('下载风格海报', '/styles/*/poster.jpg');
    for (let i = 0; i < entries.length; i += demoBatch) {
      const end = Math.min(i + demoBatch, entries.length);
      const label = `下载 demo 源码（第 ${i / demoBatch + 1}/${batches} 批）`;
      next(label);
      await stage(label, ...entries.slice(i, end).map((style) => '/styles/' + style.slug + '/demo/'));
    }
    next('下载 core/assets 模型与贴图');
    await stage('下载 core/assets', '/core/assets/');
    // 收尾时换成完整规则，之后读稀疏规则的人看到的就是最终状态。
    patterns = [...fullSparse];
    await stage('整理风格库');
    next('安装 three.js 依赖（npm ci）');
    await setupNode(lib, { env: opts.env, output: opts.output }, signal);
    fs.writeFileSync(path.join(lib.dir, '.git', completeMarker), lib.commit + '\n', { mode: 0o644 });
    return lib;
  } finally {
    unlock();
  }
}

/** 一次风格库依赖安装。 */
export interface SetupOptions {
  env: Record<string, string>;
  output?: Writer;
}

/** 记录装 node_modules 时 package.json 与 package-lock.json 的摘要。 */
const nodeMarker = '.am-ok';

/**
 * 在风格库里按 package-lock.json 装 Node 依赖（three.js）。只有用 three.js 的
 * 风格要它，由 prepareLibrary（am setup）在最后一步调用。
 * 用 npm ci 而不是 npm install：后者会改写锁文件，同一个 commit 装出不同版本。
 * --ignore-scripts：只要 three 的源文件，不跑任何安装脚本，也不下载浏览器。
 */
export async function setupNode(lib: Library, opts: SetupOptions, signal?: AbortSignal): Promise<void> {
  let want: string;
  try {
    want = filesDigest(path.join(lib.dir, 'package.json'), path.join(lib.dir, 'package-lock.json'));
  } catch (err) {
    throw new Error(`读取风格库的 package.json：${errorText(err)}`, { cause: err });
  }
  const marker = path.join(lib.dir, 'node_modules', nodeMarker);
  let got = '';
  try {
    got = fs.readFileSync(marker, 'utf8');
  } catch {
    // 没有标记。
  }
  if (got.trim() === want) return;
  let npm: string;
  try {
    npm = lookPath('npm', opts.env.PATH ?? '');
  } catch (err) {
    throw new Error(`找不到 npm（需要 Node 20+），无法安装风格库的 three.js：${errorText(err)}`, { cause: err });
  }
  const output: Writer = opts.output ?? { write: () => true };
  output.write('安装风格库的 Node 依赖（npm ci）…\n');
  try {
    await runCommand(npm, ['ci', '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts'], {
      cwd: lib.dir,
      env: opts.env,
      stdout: output,
      stderr: output,
      signal,
    });
  } catch (err) {
    throw new Error(`npm ci 失败：${errorText(err)}`, { cause: err });
  }
  // 没有依赖时 npm ci 不建 node_modules，标记要自己建目录。
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, want + '\n', { mode: 0o644 });
}

function filesDigest(...files: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(fs.readFileSync(file));
  return hash.digest('hex').slice(0, 16);
}
