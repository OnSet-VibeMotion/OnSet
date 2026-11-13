import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPlan, execute } from './index';

const hasGit = spawnSync('git', ['--version']).status === 0;
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-archive-'));
  temps.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stdout}${result.stderr}`);
  }
  return result.stdout + result.stderr;
}

function repository(): string {
  const dir = tempDir();
  git(dir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'video/test');
  return dir;
}

describe.skipIf(!hasGit)('archive', () => {
  it('plan separates candidates from shared changes', () => {
    const dir = repository();
    fs.writeFileSync(path.join(dir, 'scene.json'), 'scene');
    let plan = buildPlan(dir, 'main', path.join(tempDir(), 'archives'), 'test');
    expect(plan.candidates).toEqual(['scene.json']);
    expect(plan.shared).toHaveLength(0);
    fs.writeFileSync(path.join(dir, 'README.md'), 'changed');
    plan = buildPlan(dir, 'main', path.join(tempDir(), 'archives'), 'test2');
    expect(plan.shared, 'shared change not detected').toEqual(['README.md']);
  });

  it('execute moves candidates and detaches at main', () => {
    const dir = repository();
    fs.mkdirSync(path.join(dir, 'scenes'));
    fs.writeFileSync(path.join(dir, 'scenes', 'one.txt'), 'payload');
    const archiveRoot = path.join(tempDir(), 'archives');
    const plan = buildPlan(dir, 'main', archiveRoot, 'test');
    execute(plan);
    expect(fs.existsSync(path.join(plan.destination, 'files', 'scenes', 'one.txt'))).toBe(true);
    expect(git(dir, 'branch', '--show-current'), 'expected detached HEAD').toBe('');
  });

  it('execute refuses shared or ignored files', () => {
    const dir = repository();
    fs.writeFileSync(path.join(dir, 'README.md'), 'changed');
    const plan = buildPlan(dir, 'main', path.join(tempDir(), 'archives'), 'test');
    expect(() => execute(plan), 'expected shared blocker').toThrow();
  });

  it('buildPlan rejects archive name traversal', () => {
    const dir = repository();
    expect(() => buildPlan(dir, 'main', path.join(tempDir(), 'archives'), '../escape'), 'expected archive name traversal rejection').toThrow();
  });
});
