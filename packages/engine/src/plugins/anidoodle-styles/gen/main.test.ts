// 生成器的前置检查，以及（设了 ONSET_ANIDOODLE_SRC 时）提交的 catalog.json 与固定 commit 的检出逐字节一致。
// 升级上游：检出新 commit、改 PinnedCommit 与 gen/zh.ts 后，ONSET_UPDATE_GOLDEN=1 ONSET_ANIDOODLE_SRC=<检出> 重跑本测试。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { marshalIndent } from '../../../gojson';
import { buildCatalog, defaultCatalogPath, generateCatalog } from './main';

const hasGit = spawnSync('sh', ['-c', 'command -v git']).status === 0;
const src = process.env.ONSET_ANIDOODLE_SRC ?? '';

describe('generateCatalog', () => {
  it('requires a source checkout', () => {
    expect(() => generateCatalog('')).toThrow('必须指定 anidoodle 检出目录');
  });

  it.skipIf(!hasGit)('rejects a checkout that is not at the pinned commit', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-anidoodle-gen-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo, env });
    const out = path.join(repo, 'catalog.json');
    expect(() => generateCatalog(repo, out)).toThrow('与 anidoodle.PinnedCommit');
    expect(fs.existsSync(out)).toBe(false);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it.skipIf(src === '')('matches the pinned checkout byte-for-byte', () => {
    if (process.env.ONSET_UPDATE_GOLDEN === '1') generateCatalog(src);
    expect(fs.readFileSync(defaultCatalogPath(), 'utf8')).toBe(marshalIndent(buildCatalog(src)) + '\n');
  });
});
