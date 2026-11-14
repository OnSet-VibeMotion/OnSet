//
// 风格来源下载数据用的通用零件：按固定 commit 分段稀疏检出（可续传）、同一份数据的进程间锁、
// 屏蔽用户 git 配置的 git 调用。lemo-opuscar、anidoodle 与 huashu 几个来源共用；来源自己的目录结构、
// 检出规则与说法留在各自插件里。
//
// 只用于来源数据的下载（前置资源，只由 onset setup 调用）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import { goPathError } from '../gofmt';
import type { Writer } from '../hyperframes';
import { ExitError, abortReason } from '../procgroup';

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

export function exists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 按名字排序的目录项（os.ReadDir 的顺序）。 */
export function sortedEntries(dir: string): fs.Dirent[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}

/**
 * 每一步网络操作的尝试次数。经代理时偶尔整条 TLS 握手失败
 * （SSL_ERROR_SYSCALL），重连一次就好，所以给得宽。
 */
export const stageAttempts = 5;

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

/** 一次分段稀疏检出。 */
export interface SparseDownload {
  git: string;
  /** 检出目录（通常是 <目录>.partial）；已有的进度直接沿用。 */
  dir: string;
  repoURL: string;
  commit: string;
  env: Record<string, string>;
  output?: Writer;
  /** 逐段扩大的稀疏规则（非 cone 模式），最后一段是最终规则。 */
  stages: string[][];
}

/**
 * 把 commit 下载并检出到 dir，已有的进度直接沿用。
 *
 * --filter=blob:none 的文件内容是检出时一批取回的，一批里断一次整批白下，
 * 所以检出分成几段逐段扩大稀疏规则，每段取回的文件留在本地，每段各自重试。
 * 检出完核对 HEAD 等于 commit。
 */
export async function sparseDownload(opts: SparseDownload, signal?: AbortSignal): Promise<void> {
  const { git, dir, commit } = opts;
  const run = (...args: string[]) => gitCommand(git, dir, opts.env, opts.output, args, signal);
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
  if (!exists(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const step of [
      ['init', '--quiet'],
      ['remote', 'add', 'origin', opts.repoURL],
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
      await run('remote', 'set-url', 'origin', opts.repoURL);
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
    await retry('从 ' + opts.repoURL + ' 下载风格库 ' + commit + ' ', 'fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', commit);
  }
  let head = '';
  try {
    head = await run('rev-parse', '--verify', '--quiet', 'HEAD');
  } catch {
    head = '';
  }
  if (head !== commit) {
    writeSparse(dir, opts.stages[0]!);
    await retry('检出风格库', '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', commit);
  }
  for (let i = 0; i < opts.stages.length; i++) {
    writeSparse(dir, opts.stages[i]!);
    // --reset：上一次在这一段中途断开时工作区可能只更新了一半，按 HEAD 重来。
    await retry(`检出风格库（第 ${i + 1}/${opts.stages.length} 段）`, 'read-tree', '--reset', '-u', 'HEAD');
  }
  const finalHead = await run('rev-parse', 'HEAD');
  if (finalHead !== commit) throw new Error(`风格库检出到 ${finalHead}，与固定的 ${commit} 不符，拒绝使用`);
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

export interface CommandOptions {
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
  // （实测：检出时 fetch-pack 断开后整个 onset 卡了半小时）。低于 1 KB/s 持续
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
