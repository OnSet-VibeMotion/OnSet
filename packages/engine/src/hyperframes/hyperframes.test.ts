import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { envMap } from '../envutil';
import { isMissing } from '../prereq';
import {
  CLIDirEnv,
  GitProgress,
  ManifestFile,
  SkillsSubdir,
  cacheMarker,
  cachedTree,
  copySkills,
  install,
  prepareSkills,
  readManifest,
  requireCLI,
  skillDigest,
  type Options,
  type Progress,
} from './index';
import { manifestFile } from './constants';
import { copyStart } from './progress';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onset-hftest-'));
}

const PATH = process.env.PATH ?? '';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

function writeSkill(root: string, name: string, files: Record<string, string> = {}): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!(manifestFile in files)) files = { ...files, [manifestFile]: '# ' + name + '\n' };
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { mode: 0o644 });
  }
}

class Sink {
  text = '';
  write(chunk: string): void {
    this.text += chunk;
  }
}

/**
 * 造一个本地上游仓库：skills/ 与 .agents/skills/ 两处各放几个技能，打上 tag。
 * 测试用 file:// 克隆它，走的是与真实安装完全相同的代码路径，只是
 * 换了个源——比伪造 git 二进制更接近真实，也完全离线。
 */
function fixtureRepo(tag: string, topSkills: string[], agentSkills: string[]): { url: string; commit: string } {
  const repo = tempDir();
  const run = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...envMap(),
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  run('init', '-q', '-b', 'main');
  for (const name of topSkills) writeSkill(path.join(repo, 'skills'), name);
  for (const name of agentSkills) writeSkill(path.join(repo, '.agents', 'skills'), name);
  // 两处各放一个不是技能的条目，验证筛选按 SKILL.md 而不是"目录就算"。
  for (const [dir, name] of [
    [path.join(repo, 'skills'), 'notes.test.mjs'],
    [path.join(repo, '.agents', 'skills'), 'README.md'],
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), '//\n');
  }
  run('add', '-A');
  run('commit', '-qm', 'fixture');
  run('tag', tag);
  return { url: 'file://' + repo, commit: run('rev-parse', 'HEAD') };
}

describe('copySkills', () => {
  it('moves whole tree', () => {
    const source = tempDir();
    const dest = tempDir();
    writeSkill(source, 'hyperframes-animation', { 'rules-index.md': '索引', 'rules/typography.md': '规则', 'scripts/run.sh': '#!/bin/sh\n' });
    writeSkill(source, 'hyperframes-core');
    const result = copySkills([source], dest);
    expect(result.installed).toHaveLength(2);
    for (const rel of [
      'hyperframes-animation/SKILL.md',
      'hyperframes-animation/rules-index.md',
      'hyperframes-animation/rules/typography.md',
      'hyperframes-animation/scripts/run.sh',
      'hyperframes-core/SKILL.md',
    ]) {
      expect(fs.existsSync(path.join(dest, rel)), rel).toBe(true);
    }
  });

  // 技能自带的脚本丢了执行位就跑不起来，而失败信息会是 permission denied，
  // 与「技能没装好」毫无关联，极难排查。
  it.skipIf(process.platform === 'win32')('preserves executable bit', () => {
    const source = tempDir();
    const dest = tempDir();
    writeSkill(source, 'hyperframes-cli');
    const script = path.join(source, 'hyperframes-cli', 'scripts', 'render.sh');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    copySkills([source], dest);
    const mode = fs.statSync(path.join(dest, 'hyperframes-cli', 'scripts', 'render.sh')).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  // 随二进制下发的技能是 fork 过的，被上游同名技能覆盖等于静默丢掉本仓库的改动。
  it('protects builtin skills', () => {
    const source = tempDir();
    const dest = tempDir();
    writeSkill(source, 'hyperframes-animation');
    writeSkill(source, 'text-to-lottie', { [manifestFile]: '上游版本\n' });
    writeSkill(dest, 'text-to-lottie', { [manifestFile]: '本仓库 fork 版本\n' });
    const result = copySkills([source], dest, new Set(['text-to-lottie']));
    expect(result.protected).toEqual(['text-to-lottie']);
    expect(fs.readFileSync(path.join(dest, 'text-to-lottie', manifestFile), 'utf8')).toContain('fork');
  });

  // 同名技能整体替换。残留上一版的文件会让技能树处于两个版本混合的状态，而那正是固定版本要消除的。
  it('replaces rather than merges', () => {
    const source = tempDir();
    const dest = tempDir();
    writeSkill(source, 'hyperframes-animation', { 'rules/new.md': '新版' });
    writeSkill(dest, 'hyperframes-animation', { 'rules/removed-upstream.md': '旧版残留' });
    copySkills([source], dest);
    expect(fs.existsSync(path.join(dest, 'hyperframes-animation', 'rules', 'removed-upstream.md'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'hyperframes-animation', 'rules', 'new.md'))).toBe(true);
  });

  it('ignores non-skill directories', () => {
    const source = tempDir();
    const dest = tempDir();
    writeSkill(source, 'hyperframes-core');
    // 没有 SKILL.md，不是技能目录。
    fs.mkdirSync(path.join(source, 'cache'));
    fs.writeFileSync(path.join(source, 'README.md'), 'x');
    expect(copySkills([source], dest).installed).toEqual(['hyperframes-core']);
  });

  it('fails when nothing installed', () => {
    const source = tempDir();
    fs.writeFileSync(path.join(source, 'README.md'), 'x');
    // 产物里没有技能时应当报错，而不是静默成功。
    expect(() => copySkills([source], tempDir())).toThrow();
  });

  // 上游在 Unix 上用符号链接把技能镜像到其他 agent 目录，链接指回它自己的 home store。
  // 搬进项目后临时 HOME 已删除，那些链接会成为静默失效的空技能。
  it.skipIf(process.platform === 'win32')('copyTree rejects symlinks', () => {
    const source = tempDir();
    writeSkill(source, 'linked');
    fs.symlinkSync('/somewhere/else', path.join(source, 'linked', 'ref'));
    expect(() => copySkills([source], tempDir())).toThrow();
  });
});

describe.skipIf(!hasGit)('install', () => {
  it('writes into project and not home', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['hyperframes-animation'], ['hyperframes-core']);
    const project = tempDir();
    const home = tempDir();
    const result = await install({
      projectDir: project, version: '9.9.9', repoURL: url, expectCommit: commit, expectSkills: 2,
      env: { PATH, HOME: home }, output: new Sink(),
    });
    expect(result.installed).toHaveLength(2);
    for (const name of result.installed) expect(fs.existsSync(path.join(project, SkillsSubdir, name, manifestFile)), name).toBe(true);
    // 核心保证：用户 HOME 一个字节都没动。git 会读 ~/.gitconfig、写 ~/.gitcredentials，
    // 所以这条断言在换成 git 之后仍然承重，不是历史遗留。
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('leaves no temp directory behind', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['hyperframes-core'], []);
    // 只观察本次安装创建的目录，其他测试 worker 可能同时在系统临时目录里安装。
    const makeTemp = vi.spyOn(fs, 'mkdtempSync');
    try {
      await install({
        projectDir: tempDir(), version: '9.9.9', repoURL: url, expectCommit: commit, expectSkills: 1,
        env: { PATH }, output: new Sink(),
      });
      const created = makeTemp.mock.calls.flatMap(([prefix], index) =>
        String(prefix).endsWith('onset-hyperframes-') ? [makeTemp.mock.results[index].value as string] : []);
      expect(created).toHaveLength(1);
      for (const dir of created) expect(fs.existsSync(dir), dir).toBe(false);
    } finally {
      makeTemp.mockRestore();
    }
  });

  it('rejects missing version and toolchain', async () => {
    // 没有版本号应当报错。
    await expect(install({ projectDir: tempDir() })).rejects.toThrow();
    // 不是 GitHub 的仓库没法逐个文件下载：PATH 里没有 git 应当报错；退出码 127 靠这个前缀判定。
    // （GitHub 仓库没有 git 时改走 HTTP 下载，见 download.test.ts。）
    const err = await install({ projectDir: tempDir(), version: '9.9.9', repoURL: 'file:///nonexistent', env: { PATH: tempDir() }, output: new Sink() }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('缺少必需工具');
  });

  it('reports clone failure', async () => {
    const err = await install({
      projectDir: tempDir(), version: '9.9.9', repoURL: 'file://' + path.join(tempDir(), 'does-not-exist'),
      env: { PATH }, output: new Sink(),
    }).catch((e: Error) => e);
    // 克隆失败应当报错并点名 tag。
    expect((err as Error).message).toContain('v9.9.9');
  });

  // 守住上游技能的来源记录。PinnedVersion 固定的只是 CLI 二进制，这条记录把
  // "这个项目到底装到了哪一版技能"从无从查证变成可比对的事实。
  it('records upstream manifest', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['hyperframes-animation'], ['hyperframes-core']);
    const project = tempDir();
    await install({ projectDir: project, version: '9.9.9', repoURL: url, expectCommit: commit, expectSkills: 2, env: { PATH }, output: new Sink() });
    const m = readManifest(project);
    expect(m.cliVersion).toBe('9.9.9');
    for (const name of ['hyperframes-animation', 'hyperframes-core']) expect(m.skills[name], name).toBeTruthy();
    // 来源记录应当只覆盖上游技能。
    expect(Object.keys(m.skills)).toHaveLength(2);
  });

  // 记录里的哈希必须真的跟着内容走。只断言"字段非空"挡不住把常量字符串写进去这种实现。
  it('upstream manifest hash tracks content', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['hyperframes-core'], []);
    const project = tempDir();
    await install({ projectDir: project, version: '9.9.9', repoURL: url, expectCommit: commit, expectSkills: 1, env: { PATH }, output: new Sink() });
    const first = readManifest(project);
    const dir = path.join(project, SkillsSubdir, 'hyperframes-core');
    const skill = path.join(dir, manifestFile);
    const body = fs.readFileSync(skill);
    fs.writeFileSync(skill, Buffer.concat([body, Buffer.from('\n上游改了一行\n')]));
    // 技能内容改了，摘要必须变。
    expect(skillDigest(dir)).not.toBe(first.skills['hyperframes-core']);
    fs.writeFileSync(skill, body);
    // 内容还原后摘要回到原值。
    expect(skillDigest(dir)).toBe(first.skills['hyperframes-core']);
  });

  // 可复现安装的主用例：onset 自己按 tag 克隆，技能来源完全由 PinnedVersion + PinnedSkillsCommit 决定。
  it('clones pinned commit', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['alpha', 'beta'], ['gamma']);
    const project = tempDir();
    const result = await install({ projectDir: project, version: '9.9.9', repoURL: url, expectCommit: commit, expectSkills: 3, env: { PATH }, output: new Sink() });
    // 两处来源合并，非技能条目剔除。
    expect(result.installed.join(',')).toBe('alpha,beta,gamma');
    expect(readManifest(project).upstreamCommit).toBe(commit);
  });

  // tag 被 force-push 移动后按 tag 克隆会静默拿到另一份技能，commit 不符时必须硬失败。
  it('refuses moved tag', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['alpha'], []);
    const err = await install({
      projectDir: tempDir(), version: '9.9.9', repoURL: url, expectCommit: '0'.repeat(40), env: { PATH }, output: new Sink(),
    }).catch((e: Error) => e);
    // 错误信息应报出实际 commit 便于排查。
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(commit);
  });

  // 让"升级时顺手核对"这件事自己会响：技能数量对不上就拒装。
  it('refuses unexpected skill count', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['alpha', 'beta'], []);
    const err = await install({
      projectDir: tempDir(), version: '9.9.9', repoURL: url, expectCommit: commit, expectSkills: 26, env: { PATH }, output: new Sink(),
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('26');
  });

  // 进度只往前走，经过检出（不确定进度）和逐个拷贝，最后到 100。
  it('reports progress', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['hyperframes-animation'], ['hyperframes-core']);
    const reports: Progress[] = [];
    await install({
      projectDir: tempDir(), version: '9.9.9', repoURL: url, expectCommit: commit, expectSkills: 2,
      env: { PATH, HOME: tempDir() }, output: new Sink(), progress: (p) => reports.push(p),
    });
    let sawCheckout = false;
    let sawCopy = false;
    reports.forEach((p, i) => {
      if (i > 0) expect(p.percent, '进度倒退').toBeGreaterThanOrEqual(reports[i - 1].percent);
      sawCheckout ||= Boolean(p.indeterminate) && p.stage === '下载技能文件';
      sawCopy ||= p.stage === '拷进项目' && p.percent > copyStart;
    });
    expect(sawCheckout).toBe(true);
    expect(sawCopy).toBe(true);
    expect(reports[reports.length - 1].percent).toBe(100);
  });

  // 第一次安装把校验过的技能树存进本机缓存，第二次从缓存拷贝、不再联网：
  // 第二次把仓库地址换成不存在的路径，能装上就说明没有去克隆。
  it('uses local cache on second run', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['hyperframes-animation'], ['hyperframes-core']);
    const cache = tempDir();
    const opts: Options = { version: '9.9.9', repoURL: url, expectCommit: commit, expectSkills: 2, env: { PATH }, output: new Sink(), cacheDir: cache };
    await install({ ...opts, projectDir: tempDir() });
    // 第一次安装后应当有缓存。
    expect(fs.existsSync(path.join(cache, commit, cacheMarker))).toBe(true);
    const reports: Progress[] = [];
    const project = tempDir();
    const result = await install({
      ...opts, projectDir: project, repoURL: 'file:///nonexistent/hyperframes',
      env: { PATH: tempDir() }, // 连 git 都找不到
      progress: (p) => reports.push(p),
    });
    expect(result.installed).toHaveLength(2);
    // 进度应当说明来自缓存。
    expect(reports[0].stage).toBe('从本机缓存读取');
    expect(reports[reports.length - 1].percent).toBe(100);
    // 来源记录仍要写上游 commit。
    expect(fs.readFileSync(path.join(project, SkillsSubdir, ManifestFile), 'utf8')).toContain(commit);
  });

  // 缓存被动过（少了技能）时当作没有，重新下载并覆盖，而不是装出一棵残缺的技能树。
  it('ignores damaged cache', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['hyperframes-animation'], ['hyperframes-core']);
    const cache = tempDir();
    const opts: Options = { version: '9.9.9', repoURL: url, expectCommit: commit, expectSkills: 2, env: { PATH }, output: new Sink(), cacheDir: cache };
    await install({ ...opts, projectDir: tempDir() });
    fs.rmSync(path.join(cache, commit, 'skills', 'hyperframes-animation'), { recursive: true });
    const result = await install({ ...opts, projectDir: tempDir() });
    // 残缺缓存应当被重新下载替换。
    expect(result.installed).toHaveLength(2);
    // 重新下载后缓存应当恢复完整。
    expect(cachedTree(cache, commit, 2)).not.toBe('');
  });

  // 技能是前置资源：只拷缓存（cacheOnly）时缓存里没有就报缺前置资源、不联网；
  // onset setup 用 prepareSkills 下进缓存后，同样的安装就能从缓存装上。
  it('cache-only install needs prepareSkills', async () => {
    const { url, commit } = fixtureRepo('v9.9.9', ['hyperframes-animation'], ['hyperframes-core']);
    const cache = tempDir();
    const project = tempDir();
    const opts: Options = {
      projectDir: project, version: '9.9.9', repoURL: url, expectCommit: commit, expectSkills: 2,
      env: { PATH }, output: new Sink(), cacheDir: cache, cacheOnly: true,
    };
    const err = await install(opts).catch((e: unknown) => e);
    // 缓存里没有时应当报缺前置资源。
    expect(isMissing(err)).toBe(true);
    await prepareSkills({ ...opts, cacheOnly: false });
    // prepareSkills 只下进缓存，不该往项目里写。
    expect(fs.readdirSync(project)).toEqual([]);
    // 连 git 都没有也能装：只拷缓存。
    const result = await install({ ...opts, env: { PATH: tempDir() } });
    expect(result.installed).toHaveLength(2);
  });
});

// git 的 \r 分隔进度行换算成整体进度，原始输出照样转出。
it('git progress parses stages', () => {
  const got: Progress[] = [];
  const raw = new Sink();
  const g = new GitProgress((p) => got.push(p), raw);
  g.write("Cloning into '.'...\nremote: Counting objects:  50% (1/2)\rReceiving obj");
  g.write('ects:  50% (3/6)\rReceiving objects: 100% (6/6), done.\nResolving deltas:  10% (1/10)\rremote: Counting objects: 100% (2/2)\n');
  expect(got).toHaveLength(4);
  expect(got[0].stage).toBe('连接上游仓库');
  expect(got[1].percent).toBe(35);
  expect(got[2].percent).toBe(62);
  expect(got[3].stage).toBe('整理下载内容');
  // 原始输出要转给 next。
  expect(raw.text).toContain('Cloning into');
});

it('requireCLI only checks', () => {
  const dir = path.join(tempDir(), 'cli');
  let err: unknown;
  try {
    requireCLI({ [CLIDirEnv]: dir });
  } catch (e) {
    err = e;
  }
  // 没装时应当报缺前置资源。
  expect(isMissing(err)).toBe(true);
  // requireCLI 只检查，不该建目录或安装。
  expect(fs.existsSync(dir)).toBe(false);
});
