// Go 版的 gen 没有测试；这里钉住它的两道前置检查（没有 -src、HEAD 与固定 commit 不符）。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateCatalog } from './main';

const hasGit = spawnSync('sh', ['-c', 'command -v git']).status === 0;

describe('generateCatalog', () => {
  it('requires a source checkout', () => {
    expect(() => generateCatalog('')).toThrow('必须用 -src 指定 lemo-opuscar 检出目录');
  });

  it.skipIf(!hasGit)('rejects a checkout that is not at the pinned commit', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-lemo-gen-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo, env });
    const out = path.join(repo, 'catalog.json');
    expect(() => generateCatalog(repo, out)).toThrow('与 lemo.PinnedCommit');
    expect(fs.existsSync(out)).toBe(false);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
