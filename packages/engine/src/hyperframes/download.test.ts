import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cachedTree, PinnedSkillsCommit, PinnedSkillsCount, prepareSkills } from './index';
import { downloadTree, gitBlobSHA, githubRepo } from './download';

/** 一个假的 GitHub：trees 接口与 raw 文件，内容由测试决定。 */
function fakeGitHub(files: Record<string, { body: string; mode?: string; sha?: string }>) {
  const trees = new Map<string, { path: string; mode: string; type: string; sha: string }[]>();
  const blobs = new Map<string, string>();
  // 根 → skills（子目录 a/）；递归列表直接给出全部文件。
  trees.set('c0ffee', [{ path: 'skills', mode: '040000', type: 'tree', sha: 'tskills' }]);
  const recursive = Object.entries(files).map(([p, f]) => {
    const sha = f.sha ?? gitBlobSHA(Buffer.from(f.body));
    blobs.set('skills/' + p, f.body);
    return { path: p, mode: f.mode ?? '100644', type: 'blob', sha };
  });
  trees.set('tskills', [{ path: 'a', mode: '040000', type: 'tree', sha: 'ta' }]);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const tree = /^\/repos\/o\/r\/git\/trees\/([^/]+)$/.exec(url.pathname);
    if (tree) {
      const sha = tree[1];
      const body = url.searchParams.get('recursive') ? { sha, tree: recursive } : { sha, tree: trees.get(sha) ?? [] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
      return;
    }
    const raw = /^\/o\/r\/c0ffee\/(.+)$/.exec(url.pathname);
    const blob = raw && blobs.get(decodeURIComponent(raw[1]));
    if (blob === undefined || blob === null) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.end(blob);
  });
  return server;
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onset-download-'));
}

const env = { PATH: process.env.PATH ?? '' };

describe('download', () => {
  it('recognizes GitHub repository URLs', () => {
    expect(githubRepo('https://github.com/heygen-com/hyperframes.git')).toEqual({ owner: 'heygen-com', repo: 'hyperframes' });
    expect(githubRepo('file:///tmp/repo')).toBeNull();
  });

  it('computes git blob hashes', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSHA(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = fakeGitHub({
      'a/SKILL.md': { body: '# a\n' },
      'a/run.sh': { body: '#!/bin/sh\n', mode: '100755' },
      'a/references/x.md': { body: 'x\n' },
    });
    base = await listen(server);
  });
  afterAll(() => server.close());

  it('downloads every file of the subdirectory and verifies it', async () => {
    const dir = tempDir();
    const seen: number[] = [];
    const n = await downloadTree({ owner: 'o', repo: 'r', commit: 'c0ffee', subdirs: ['skills', '.agents/skills'], dir, env, apiBase: base, rawBase: base, progress: (d) => seen.push(d) });
    expect(n).toBe(3);
    expect(fs.readFileSync(path.join(dir, 'skills/a/references/x.md'), 'utf8')).toBe('x\n');
    expect(fs.statSync(path.join(dir, 'skills/a/run.sh')).mode & 0o111).not.toBe(0);
    expect(seen.at(-1)).toBe(3);
  });

  it('rejects content that does not match the tree', async () => {
    const bad = fakeGitHub({ 'a/SKILL.md': { body: '# tampered\n', sha: gitBlobSHA(Buffer.from('# a\n')) } });
    const url = await listen(bad);
    try {
      await expect(downloadTree({ owner: 'o', repo: 'r', commit: 'c0ffee', subdirs: ['skills'], dir: tempDir(), env, apiBase: url, rawBase: url })).rejects.toThrow(/不符/);
    } finally {
      bad.close();
    }
  });

  it('rejects symlinks', async () => {
    const bad = fakeGitHub({ 'a/link': { body: '../elsewhere', mode: '120000' } });
    const url = await listen(bad);
    try {
      await expect(downloadTree({ owner: 'o', repo: 'r', commit: 'c0ffee', subdirs: ['skills'], dir: tempDir(), env, apiBase: url, rawBase: url })).rejects.toThrow(/符号链接/);
    } finally {
      bad.close();
    }
  });
});

// 真实下载：联网，CI 不跑。改了下载路径后在本机跑一遍：
//   ONSET_TEST_SKILLS_DOWNLOAD=1 npx vitest run --root packages/engine src/hyperframes/download -t RealDownload
describe.runIf(process.env.ONSET_TEST_SKILLS_DOWNLOAD === '1')('RealDownload', () => {
  it('fetches the pinned skills without git, matching the clone byte for byte', async () => {
    const cache = tempDir();
    await prepareSkills({ env: { ...env, HOME: tempDir(), ONSET_NO_GIT: '1' }, cacheDir: cache });
    expect(cachedTree(cache, PinnedSkillsCommit, PinnedSkillsCount)).not.toBe('');
    // 与用 git 克隆进缓存的同一 commit 逐文件比对（本机已有那份缓存时）。
    const cloned = process.env.ONSET_TEST_SKILLS_CLONED;
    if (cloned) {
      const list = (root: string): string[] =>
        fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(root, path.join(e.parentPath, e.name))).sort();
      const got = path.join(cache, PinnedSkillsCommit);
      const files = list(cloned).filter((f) => !f.startsWith('.onset-'));
      expect(list(got).filter((f) => !f.startsWith('.onset-'))).toEqual(files);
      for (const f of files) expect(fs.readFileSync(path.join(got, f)).equals(fs.readFileSync(path.join(cloned, f))), f).toBe(true);
    }
  }, 600_000);
});
