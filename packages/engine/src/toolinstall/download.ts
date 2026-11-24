/**
 * 下载、哈希校验与子进程执行公共工具。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../envutil';
import type { Progress, Writer } from '../hyperframes';
import { abortReason } from '../procgroup';
import { binDir } from '../toolpath';

/** GitHub release 下载地址的镜像前缀，例如 https://ghfast.top/https://github.com/ 。文件都有 sha256，走镜像也安全。 */
export const GitHubMirrorEnv = 'ONSET_GITHUB_MIRROR';

/** 一个钉死的下载文件。 */
export interface Asset {
  url: string;
  sha256: string;
  /** 字节数：用来按已下载的大小算进度。 */
  size: number;
}

/** 一次安装。 */
export interface InstallOptions {
  /** 当前环境：HOME 决定装到哪，https_proxy 给 curl。 */
  env: Record<string, string>;
  /** 覆盖模型安装目标目录（例如 ONSET_ACESTEP_MODELS_DIR）。 */
  targetDir?: string;
  output?: Writer;
  progress?: (p: Progress) => void;
  signal?: AbortSignal;
}

export function platformKey(): string {
  return `${process.platform}/${process.arch}`;
}

export function requireBinDir(env: Record<string, string | undefined>): string {
  const dir = binDir(env);
  if (dir === '') throw new Error('无法确定工具的安装目录：环境里没有 HOME');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 镜像改写：只改 GitHub 的地址。 */
export function mirrored(url: string, env: Record<string, string | undefined>): string {
  const mirror = env[GitHubMirrorEnv];
  if (!mirror || !url.startsWith('https://github.com/')) return url;
  return mirror.replace(/\/?$/, '/') + url.slice('https://github.com/'.length);
}

/**
 * 下载 asset 到 dir/name，核对 sha256 后返回路径。断点续传：中途失败留下 .partial，下次接着下；
 * 核对不过就删掉重下（每次运行最多重试 3 次）。
 */
export async function download(
  asset: Asset,
  dir: string,
  name: string,
  opts: InstallOptions,
  onBytes: (bytes: number) => void,
): Promise<string> {
  const target = path.join(dir, name);
  const partial = target + '.partial';
  const curl =
    process.platform === 'darwin' && fs.existsSync('/usr/bin/curl')
      ? '/usr/bin/curl'
      : lookPath('curl', opts.env.PATH ?? '');
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const timer = setInterval(() => {
      try {
        onBytes(fs.statSync(partial).size);
      } catch {
        // 还没开始写
      }
    }, 500);
    try {
      await run(
        curl,
        [
          '--fail',
          '--silent',
          '--show-error',
          '--location',
          '--retry',
          '5',
          '--retry-all-errors',
          '--connect-timeout',
          '20',
          '--speed-limit',
          '1024',
          '--speed-time',
          '60',
          // 只在有上次没下完的文件时续传：全新下载不带 Range，少一种出错的可能。
          ...(fs.existsSync(partial) ? ['--continue-at', '-'] : []),
          '--output',
          partial,
          mirrored(asset.url, opts.env),
        ],
        opts,
      );
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      opts.output?.write(`下载 ${name} 失败（${attempt}/3）：${(err as Error).message}\n`);
      // 416：本地 .partial 已经比远端大或已完整，丢掉重下。
      if (/416/.test(String((err as Error).message))) fs.rmSync(partial, { force: true });
      continue;
    } finally {
      clearInterval(timer);
    }
    const digest = await sha256File(partial);
    if (digest === asset.sha256) {
      fs.renameSync(partial, target);
      return target;
    }
    fs.rmSync(partial, { force: true });
    lastErr = new Error(`${name} 的 sha256 是 ${digest}，期望 ${asset.sha256}`);
    opts.output?.write(`${(lastErr as Error).message}，删掉重下\n`);
  }
  throw new Error(
    `下载 ${name} 失败（可以加 --proxy 走代理，或设 ${GitHubMirrorEnv} 用镜像；断了重跑会接着下）：${(lastErr as Error)?.message ?? ''}`,
    {
      cause: lastErr,
    },
  );
}

/**
 * 按流算文件的 sha256。不能 readFileSync 整个读进来：Node 单个 Buffer 上限 2 GiB，
 * Breeze TTS 2 的权重 3.9 GB，读的时候直接抛「File size … is greater than 2 GiB」（实测）。
 */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function run(file: string, args: string[], opts: InstallOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortReason(opts.signal));
      return;
    }
    const child = spawn(file, args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => opts.output?.write(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      opts.output?.write(chunk.toString('utf8'));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} 退出码 ${code}：${stderr.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

export function runCommandIn(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  output: Writer,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let tail = '';
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-2000);
      output.write(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${path.basename(file)} ${args.slice(0, 2).join(' ')} 退出码 ${code}：${tail.trim().split('\n').slice(-3).join(' ')}`,
          ),
        );
    });
  });
}
