/**
 * 不用 git 取插件：插件中心给 GitHub 来源的每一版记了内容摘要（index.json 的 `digest`，与 treeDigest 同一算法，
 * 由插件中心的 CI 从同一份压缩包算出），客户端用 curl 下 `codeload.github.com/<仓库>/tar.gz/<commit>`、用 tar 解开，
 * 摘要对上了才当作这一版。客户端用户的 Mac 上可以没有 git（占位的 /usr/bin/git 一运行就弹窗要装命令行工具），
 * 而 curl 与 tar 是系统自带的（Windows 10 起也有）。
 *
 * 摘要对不上或下不来时由调用方决定退回 git 克隆（clone 照旧核对 commit）。这里只取、只核对，不写已装插件清单。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../envutil';
import { removeTree } from '../fsutil';
import { treeDigest } from './digest';
import { parseSource } from './fetch';

type Env = Record<string, string | undefined>;

/** 插件压缩包的大小上限：插件只是清单、脚本与页面，几 MB 已经很大。 */
export const MaxArchiveBytes = 50 * 1024 * 1024;

const commitPattern = /^[0-9a-f]{40}$/;

/** GitHub 来源某个 commit 的压缩包地址；不是 GitHub 来源或 ref 不是完整 commit 时为空。 */
export function githubArchiveURL(spec: string): string {
  let src: ReturnType<typeof parseSource>;
  try {
    src = parseSource(spec);
  } catch {
    return '';
  }
  if (src.kind !== 'git' || !commitPattern.test(src.ref)) return '';
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(src.url);
  return m ? `https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/${src.ref}` : '';
}

function curlPath(env: Env): string {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/curl')) return '/usr/bin/curl';
  return lookPath('curl', env.PATH ?? '');
}

function tarPath(env: Env): string {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/tar')) return '/usr/bin/tar';
  return lookPath('tar', env.PATH ?? '');
}

function run(file: string, args: string[], env: Env, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    let failure: Error | undefined;
    child.on('error', err => { failure = err; });
    child.on('close', (code) => {
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} 退出码 ${code}：${stderr.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

/**
 * 下载压缩包、解开到 dest（必须还不存在；去掉 GitHub 包里的顶层目录），核对内容摘要。
 * 失败时清掉 dest 并抛错。proxy 是设置里的 NETWORK_PROXY（空就按环境里的 https_proxy，curl 认它）。
 */
export async function fetchArchive(url: string, digest: string, dest: string, env: Env, opts: { proxy?: string; log?: (line: string) => void; signal?: AbortSignal } = {}): Promise<void> {
  const curl = curlPath(env);
  const tar = tarPath(env);
  if (curl === '' || tar === '') throw new Error('这台电脑上没有 curl 或 tar，不能下载插件压缩包');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const file = `${dest}.tar.gz`;
  try {
    opts.log?.(`下载 ${url}`);
    await run(
      curl,
      [
        '--fail', '--silent', '--show-error', '--location', '--retry', '3', '--connect-timeout', '20', '--speed-limit', '1024', '--speed-time', '60',
        '--max-filesize', String(MaxArchiveBytes),
        ...(opts.proxy ? ['--proxy', opts.proxy] : []),
        '--output', file, url,
      ],
      env,
      opts.signal,
    );
    fs.mkdirSync(dest);
    // GitHub 的包里只有一个顶层目录 <仓库>-<commit>，去掉它。bsdtar（macOS、Windows）与 GNU tar 都认 --strip-components。
    await run(tar, ['-xzf', file, '-C', dest, '--strip-components', '1'], env, opts.signal);
    const got = treeDigest(dest);
    if (got !== digest) throw new Error(`下载的插件内容摘要是 ${got}，插件中心记的是 ${digest}`);
  } catch (err) {
    removeTree(dest);
    throw err;
  } finally {
    fs.rmSync(file, { force: true });
  }
}
