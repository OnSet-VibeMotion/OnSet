// 不用 git 取上游技能：按固定 commit 从 GitHub 逐个文件下载，用 git 的 blob 摘要逐个校验。
//
// 客户端用户的 Mac 上未必有 git：没装 Xcode 命令行工具时 /usr/bin/git 只是一个占位程序，一运行就弹窗要求安装。
// 整个仓库的 tarball 有 144 MB（2026-11 实测），而技能只有几 MB，所以不下 tarball：先用 GitHub API 列出技能目录的
// 文件树（几次请求，远低于未登录每小时 60 次的限额），再从 raw.githubusercontent.com 取文件内容。文件树里带每个文件
// 的 blob 摘要，下载后按 git 的算法（sha1("blob <长度>\0" + 内容)）核对，与按 commit 克隆一样可复现、防篡改。
//
// 下载用系统自带的 curl（macOS 的 /usr/bin/curl 不需要命令行工具）：它认 https_proxy，自带重试，不必在 Node 里
// 再实现一遍代理隧道。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../envutil';
import { errorText, runCommand } from './util';

/** GitHub 仓库的 owner/repo；不是 GitHub 地址时为空。 */
export function githubRepo(url: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** 一次下载。 */
export interface DownloadOptions {
  owner: string;
  repo: string;
  commit: string;
  /** 仓库里要取的目录，例如 ['skills', '.agents/skills']；不存在的跳过。 */
  subdirs: string[];
  /** 写到这里，保持仓库里的相对路径。 */
  dir: string;
  env: Record<string, string>;
  /** 已完成的文件数与总数。 */
  progress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** 测试用：替换 API 与文件内容的地址。 */
  apiBase?: string;
  rawBase?: string;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

interface Tree {
  sha: string;
  tree: TreeEntry[];
  truncated?: boolean;
}

/** 同时下载的文件数。 */
const concurrency = 8;

function curlPath(env: Record<string, string>): string {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/curl')) return '/usr/bin/curl';
  return lookPath('curl', env.PATH ?? '');
}

/** curl 的公共参数：失败就报错、跟随跳转、重试，连接被掐断时不无限挂着。 */
const curlBase = ['--fail', '--silent', '--show-error', '--location', '--retry', '5', '--retry-all-errors', '--connect-timeout', '20', '--speed-limit', '1024', '--speed-time', '60'];

/** 按 git 的算法算 blob 摘要。 */
export function gitBlobSHA(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/**
 * 下载 subdirs 里的全部文件，返回取到的文件数。任何一个文件的摘要对不上、遇到符号链接或子模块都直接报错：
 * 前者说明内容被改过，后两者搬进项目会成为静默失效的空技能（与 copyTree 拒收符号链接同一个理由）。
 */
export async function downloadTree(opts: DownloadOptions): Promise<number> {
  const curl = curlPath(opts.env);
  const api = (opts.apiBase ?? 'https://api.github.com') + `/repos/${opts.owner}/${opts.repo}/git/trees/`;
  const raw = (opts.rawBase ?? 'https://raw.githubusercontent.com') + `/${opts.owner}/${opts.repo}/${opts.commit}/`;
  const getJSON = async (url: string): Promise<Tree> => {
    const out = await runCommand(curl, [...curlBase, '-H', 'Accept: application/vnd.github+json', url], { env: opts.env, signal: opts.signal, stderr: { write: () => true } });
    try {
      return JSON.parse(out) as Tree;
    } catch (err) {
      throw new Error(`GitHub 返回的不是 JSON（${url}）：${errorText(err)}`, { cause: err });
    }
  };

  const files: TreeEntry[] = [];
  for (const sub of opts.subdirs) {
    // 逐级找到子目录的 tree，再一次性递归列出：只列技能目录，不碰整个仓库的树。
    let tree = await getJSON(api + opts.commit);
    let found = true;
    for (const part of sub.split('/')) {
      const entry = tree.tree.find((e) => e.path === part && e.type === 'tree');
      if (!entry) {
        found = false;
        break;
      }
      tree = await getJSON(api + entry.sha);
    }
    if (!found) continue;
    const listing = await getJSON(api + tree.sha + '?recursive=1');
    if (listing.truncated) throw new Error(`GitHub 截断了 ${sub} 的文件列表，无法完整下载`);
    for (const entry of listing.tree) {
      if (entry.type === 'tree') continue;
      if (entry.type === 'commit') throw new Error(`${sub}/${entry.path} 是子模块，不能作为技能文件`);
      if (entry.mode === '120000') throw new Error(`${sub}/${entry.path} 是符号链接，搬进项目后会失效，拒绝安装`);
      files.push({ ...entry, path: `${sub}/${entry.path}` });
    }
  }

  let done = 0;
  opts.progress?.(0, files.length);
  const queue = [...files];
  const worker = async (): Promise<void> => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const target = path.join(opts.dir, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const url = raw + entry.path.split('/').map(encodeURIComponent).join('/');
      try {
        await runCommand(curl, [...curlBase, '--output', target, url], { env: opts.env, signal: opts.signal, stderr: { write: () => true } });
      } catch (err) {
        throw new Error(`下载 ${entry.path} 失败：${errorText(err)}`, { cause: err });
      }
      const got = gitBlobSHA(fs.readFileSync(target));
      if (got !== entry.sha) throw new Error(`${entry.path} 的内容与 ${opts.commit} 上的不符（${got} ≠ ${entry.sha}），拒绝安装`);
      if (entry.mode === '100755') fs.chmodSync(target, 0o755);
      done++;
      opts.progress?.(done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(files.length, 1)) }, worker));
  return files.length;
}
