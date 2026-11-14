import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isMissing } from '../../prereq';
import * as filmstyle from '../../filmstyle';
import {
  LibraryEnv,
  PinnedStyleCount,
  SourceID,
  catalog,
  defaultLibraryDir,
  ensureLibrary,
  entryStyle,
  fill,
  find,
  libraryDir,
  openLibrary,
  prepareLibrary,
  requireLibrary,
  requireStyle,
  type Entry,
  type Library,
  type LibraryOptions,
  type PrepareProgress,
} from './index';

function has(tool: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;
}
const hasGit = has('git');
const hasNpm = has('npm');

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-lemo-'));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return undefined;
}

function entry(slug: string): Entry {
  const e = find(slug);
  if (!e) throw new Error(`目录里没有 ${slug}`);
  return e;
}

function gitRun(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

/**
 * 造一个本地风格库仓库：两种风格、core/ 与各种不该进项目的产物。
 * 用 file:// 走与真实下载相同的代码路径，完全离线。
 */
function fixtureLibrary(): { url: string; commit: string } {
  const repo = tempDir();
  gitRun(repo, 'init', '-q', '-b', 'main');
  gitRun(repo, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  gitRun(repo, 'config', 'uploadpack.allowFilter', 'true');
  writeFiles(repo, {
    LICENSE: 'MIT\n',
    'package.json': '{"name":"fixture","version":"1.0.0","private":true}',
    'package-lock.json':
      '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0"}}}',
    'AGENTS.md': 'agents\n',
    'core/lib.js': 'export const mulberry = () => 0;\n',
    'core/three/post.js': '// post\n',
    'core/post/crt.js': '// crt\n',
    'core/fonts/fonts.css': '/* fonts */\n',
    'core/render/video.mjs': '// render\n',
    'docs/cover.jpg': 'jpg',
    'styleboard/index.html': '<html>',
    'styles/_template/STYLE.md': '# template\n',
    'styles/impasto/STYLE.md': '# Impasto\n## 7. Sound palette\n',
    'styles/impasto/style.json': '{"slug":"impasto"}',
    'styles/impasto/DEMO.md': '# demo\n',
    'styles/impasto/poster.jpg': 'poster',
    'styles/impasto/demo/index.html': '<script type="module" src="main.js"></script>',
    'styles/impasto/demo/main.js': "import '/core/lib.js';\n",
    'styles/impasto/demo/engine/paint.js': '// engine\n',
    'styles/impasto/demo/stills/t_1.jpg': 'still',
    'styles/impasto/demo/out/video.mp4': 'video',
    'styles/impasto/demo/music/score.py': '# score\n',
    'styles/impasto/demo/music/score.wav': 'wav',
    'styles/swiss-motion/STYLE.md': '# Swiss\n',
    'styles/swiss-motion/style.json': '{"slug":"swiss-motion"}',
    'styles/swiss-motion/demo/index.html': '<html>',
    'styles/swiss-motion/demo/film.js': '// film\n',
    'core/assets/polyhaven/lamp.gltf': '{}',
    'core/assets/polyhaven/SOURCES.md': 'CC0\n',
    'core/assets/polyhaven/unused.jpg': 'jpg',
    'core/assets/polyhaven/tea_set_01/tea_set_01.gltf': '{}',
    'core/assets/polyhaven/tea_set_01/textures/diff.jpg': 'jpg',
    'styles/brick-toy/STYLE.md': '# Brick\n',
    'styles/brick-toy/style.json': '{"slug":"brick-toy"}',
    'styles/brick-toy/demo/index.html': '<html>',
    'styles/brick-toy/demo/set.js': "const PH = '/core/assets/polyhaven/';\nload(PH + 'lamp.gltf'); load(PH + 'tea_set_01/tea_set_01.gltf');\n",
  });
  gitRun(repo, 'add', '-A');
  gitRun(repo, 'commit', '-qm', 'fixture');
  return { url: 'file://' + repo, commit: gitRun(repo, 'rev-parse', 'HEAD') };
}

function fixtureOptions(url: string, commit: string): LibraryOptions {
  return {
    // HOME 用真实的：asdf / nvm / volta 的 npm shim 靠 HOME 找 node，换成临时目录就报
    // unknown command。风格库落在 XDG_DATA_HOME（临时目录），不写真实家目录。
    env: { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tempDir(), HOME: process.env.HOME ?? '' },
    repoURL: url,
    commit,
  };
}

/** 用 am setup 的路径把夹具风格库完整准备好（含 npm ci，要 npm）。 */
async function prepared(opts: LibraryOptions): Promise<Library> {
  return prepareLibrary(opts);
}

function withLibrary(env: Record<string, string>, dir: string): Record<string, string> {
  return { ...env, [LibraryEnv]: dir };
}

/**
 * 走通用的 filmstyle.install：夹具风格库钉在夹具 commit 上，用 LibraryEnv
 * 把来源指过去（标记文件还在，仍按 am 管理的风格库对待）。
 */
async function installWith(project: string, style: Entry, replace: boolean, opts: LibraryOptions): Promise<filmstyle.InstallResult> {
  const lib = await prepared(opts);
  return filmstyle.install({ projectDir: project, style: entryStyle(style), env: withLibrary(opts.env, lib.dir), replace });
}

function exists(file: string): boolean {
  return fs.existsSync(file);
}

describe('lemo catalog', () => {
  // 目录清单是从固定 commit 生成的；条数对不上说明升级时只改了 PinnedCommit 没重跑生成器。
  it('matches the pinned commit', () => {
    const list = catalog();
    expect(list.length, `catalog.json 有 ${list.length} 种风格，PinnedStyleCount 是 ${PinnedStyleCount}`).toBe(PinnedStyleCount);
    const seen = new Set<string>();
    for (const style of list) {
      expect(style.slug !== '' && style.cn !== '' && style.en !== '' && style.category_cn !== '', `风格条目缺字段：${style.slug}`).toBe(true);
      expect(style.slug.startsWith('_'), `上游样板 ${style.slug} 混进了目录`).toBe(false);
      expect(seen.has(style.slug), `目录名重复：${style.slug}`).toBe(false);
      seen.add(style.slug);
    }
    expect(filmstyle.categories(SourceID).length).toBeGreaterThanOrEqual(2);
  });

  // 来源登记进 filmstyle 后，通用查找认得它的风格：标识、目录名、中文名、英文名都行。
  it('is registered in the film-style catalog', () => {
    expect(filmstyle.sourceByID(SourceID)).toBeDefined();
    for (const name of ['lemo-opuscar/impasto', 'impasto', '油画厚涂', 'impasto oil painting', ' Impasto ']) {
      expect(filmstyle.styleKey(filmstyle.lookup(name)), name).toBe('lemo-opuscar/impasto');
    }
    expect(entryStyle(entry('brick-toy')).tags).toEqual(['three.js']);
  });
});

describe.skipIf(!hasGit)('lemo library', () => {
  it('clones the pinned commit sparsely', async () => {
    const { url, commit } = fixtureLibrary();
    const opts = fixtureOptions(url, commit);
    const lib = await ensureLibrary(opts);
    expect(lib.managed).toBe(true);
    expect(lib.commit).toBe(commit);
    expect(lib.dir).toBe(defaultLibraryDir(opts.env, commit));
    for (const rel of ['core/lib.js', 'styles/impasto/STYLE.md', 'LICENSE']) {
      expect(exists(path.join(lib.dir, rel)), `风格库缺少 ${rel}`).toBe(true);
    }
    // 与上游 setup.sh 同一套稀疏规则：demo、海报、图鉴不在首次检出里。
    for (const rel of ['styles/impasto/demo', 'styles/impasto/poster.jpg', 'docs', 'styleboard']) {
      expect(exists(path.join(lib.dir, rel)), `首次检出不该有 ${rel}`).toBe(false);
    }
    const again = await ensureLibrary(opts);
    expect(again.dir).toBe(lib.dir);
  });

  it.skipIf(!hasNpm)('builds the project skill and is idempotent', async () => {
    const { url, commit } = fixtureLibrary();
    const opts = fixtureOptions(url, commit);
    const project = tempDir();
    const impasto = entry('impasto');
    const result = await installWith(project, impasto, false, opts);
    const skill = filmstyle.skillDir(project);
    for (const rel of [
      'SKILL.md',
      'STYLE.md',
      'DEMO.md',
      'poster.jpg',
      'LICENSE',
      'ATTRIBUTION.md',
      filmstyle.ManifestFile,
      'demo/index.html',
      'demo/engine/paint.js',
      'demo/music/score.py',
      'core/lib.js',
      'core/three/post.js',
      'core/post/crt.js',
      'core/fonts/fonts.css',
    ]) {
      expect(exists(path.join(skill, rel)), `技能目录缺少 ${rel}`).toBe(true);
    }
    // 审片截图、渲染产物、音频与渲染工具不是技法，不进项目。
    for (const rel of ['demo/stills', 'demo/out', 'demo/music/score.wav', 'core/render']) {
      expect(exists(path.join(skill, rel)), `技能目录不该有 ${rel}`).toBe(false);
    }
    const { manifest, ok } = filmstyle.installed(project);
    expect(ok).toBe(true);
    expect(manifest.slug).toBe('impasto');
    expect(manifest.version).toBe(commit);
    expect(manifest).toEqual(result.manifest);
    const skillText = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
    for (const want of ['油画厚涂', 'Impasto Oil Painting', 'STYLE.md', 'hf-seek', '/core/lib.js', '不照搬 demo', '无音轨']) {
      expect(skillText, `SKILL.md 缺少 ${want}`).toContain(want);
    }
    expect(skillText).not.toContain('node_modules/three');

    const again = await installWith(project, impasto, false, opts);
    expect(again.unchanged).toBe(true);

    const swiss = entry('swiss-motion');
    const err = await rejectionOf(installWith(project, swiss, false, opts));
    expect((err as Error)?.message).toContain('--replace');
    expect(exists(path.join(skill, 'STYLE.md')), '拒绝换风格时不得动原来的技能目录').toBe(true);
    const replaced = await installWith(project, swiss, true, opts);
    expect(replaced.replaced).toBe('lemo-opuscar/impasto');
    expect(exists(path.join(skill, 'DEMO.md')), '换风格后旧风格的文件不该残留').toBe(false);
    expect(filmstyle.remove(project).had).toBe(true);
    expect(filmstyle.installed(project).ok).toBe(false);
  });

  it.skipIf(!hasNpm)('requires three for three.js styles', async () => {
    const { url, commit } = fixtureLibrary();
    const opts = fixtureOptions(url, commit);
    const lib = await prepared(opts);
    const style = { ...entry('impasto'), three_js: true }; // 夹具里没有真正的 three.js 风格，借 impasto 的 demo 演一个
    expect(isMissing(errorOf(() => requireStyle(lib, style)))).toBe(true);
    writeFiles(path.join(lib.dir, 'node_modules', 'three'), {
      'build/three.module.js': '// three\n',
      'build/three.webgpu.js': '// webgpu\n',
      'examples/jsm/postprocessing/EffectComposer.js': "import { Pass } from './Pass.js';\nimport * as T from 'three';\n",
      'examples/jsm/postprocessing/Pass.js': '// pass\n',
      'examples/jsm/controls/x.js': '// x\n',
      LICENSE: 'MIT\n',
      'src/huge.js': '// src\n',
    });
    writeFiles(path.join(lib.dir, 'styles', 'impasto', 'demo'), {
      'three-scene.js': "import * as THREE from 'three';\nimport { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';\n",
    });
    const skill = tempDir();
    requireStyle(lib, style);
    fill(skill, style, lib);
    expect(exists(path.join(skill, 'node_modules', 'three', 'build', 'three.module.js'))).toBe(true);
    for (const rel of ['src', 'build/three.webgpu.js', 'examples/jsm/controls/x.js']) {
      expect(exists(path.join(skill, 'node_modules', 'three', rel)), `demo 没用到的 ${rel} 不该进项目`).toBe(false);
    }
    // import 的模块，以及它相对引用的模块，都要带上。
    for (const rel of ['examples/jsm/postprocessing/EffectComposer.js', 'examples/jsm/postprocessing/Pass.js', 'LICENSE']) {
      expect(exists(path.join(skill, 'node_modules', 'three', rel)), `用到的 ${rel} 应当带上`).toBe(true);
    }
    expect(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toContain('node_modules/three');
  });

  // 用户自己的检出（没有 am 的标记）只读不改：缺 demo 时报错，不去改它的稀疏规则。
  it('does not modify a user library', async () => {
    const dir = tempDir();
    writeFiles(dir, { 'core/lib.js': '//', 'styles/impasto/STYLE.md': '# x' });
    const opts: LibraryOptions = { env: { PATH: process.env.PATH ?? '', [LibraryEnv]: dir } };
    const lib = await ensureLibrary(opts);
    expect(lib.managed).toBe(false);
    expect(isMissing(errorOf(() => requireStyle(lib, entry('impasto'))))).toBe(true);
    expect(await rejectionOf(prepareLibrary(opts))).toBeDefined();
    const bad = tempDir();
    writeFiles(bad, { 'README.md': 'not a library' });
    expect(await rejectionOf(ensureLibrary({ env: { [LibraryEnv]: bad } }))).toBeDefined();
  });

  // 下载中途断开后，<目录>.partial 里已经取到的东西要沿用：这里造一份只做完 fetch、
  // 还没检出的半成品，在 .git 里放一个记号，完成后记号还在就说明没有从头再来。
  it('resumes a partial download', async () => {
    const { url, commit } = fixtureLibrary();
    const opts = fixtureOptions(url, commit);
    const dir = libraryDir(opts);
    const partial = dir + '.partial';
    fs.mkdirSync(partial, { recursive: true });
    gitRun(partial, 'init', '-q');
    gitRun(partial, 'remote', 'add', 'origin', url);
    gitRun(partial, 'fetch', '-q', '--depth', '1', 'origin', commit);
    writeFiles(partial, { '.git/resume-sentinel': 'x' });
    const lib = await ensureLibrary(opts);
    expect(exists(path.join(lib.dir, '.git', 'resume-sentinel')), '应当在已有的半成品上接着下载，而不是删掉重来').toBe(true);
    expect(exists(partial), '完成后不该留下 .partial').toBe(false);
    expect(exists(path.join(lib.dir, 'styles', 'impasto', 'STYLE.md'))).toBe(true);
  });

  // am setup 一次下全：基础部分之外的 demo、海报、core/assets 都在，写完成记录；
  // 只有基础部分时算不完整，其余命令报缺前置资源。再跑一次不重下。
  it('prepareLibrary downloads everything', async ({ skip }) => {
    const { url, commit } = fixtureLibrary();
    const opts = fixtureOptions(url, commit);
    await ensureLibrary(opts);
    expect(isMissing(errorOf(() => requireLibrary(opts)))).toBe(true);
    const installErr = errorOf(() => filmstyle.install({ projectDir: tempDir(), style: entryStyle(entry('impasto')), env: opts.env }));
    expect(isMissing(installErr), `风格库不完整时装风格应当报缺前置资源，而不是去下载：${String(installErr)}`).toBe(true);
    if (!hasNpm) skip('没有 npm');
    let steps: PrepareProgress[] = [];
    const lib = await prepareLibrary({ ...opts, progress: (p) => steps.push(p) });
    for (const rel of ['styles/impasto/demo/engine/paint.js', 'styles/swiss-motion/demo/film.js', 'styles/impasto/poster.jpg', 'core/assets/polyhaven/lamp.gltf']) {
      expect(exists(path.join(lib.dir, rel)), `完整准备后应当有 ${rel}`).toBe(true);
    }
    expect(exists(path.join(lib.dir, 'styleboard')), '图鉴页不是前置资源，不该下载').toBe(false);
    requireLibrary(opts);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[steps.length - 1]!.step).toBe(steps[steps.length - 1]!.steps);
    steps = [];
    await prepareLibrary({ ...opts, progress: (p) => steps.push(p) });
    expect(steps).toEqual([]);
  });

  // core/assets/ 只有个别风格用：基础检出不带它，am setup 才取；装风格时只带被引用的文件。
  it.skipIf(!hasNpm)('fetches core/assets only for styles that use them', async () => {
    const { url, commit } = fixtureLibrary();
    const opts = fixtureOptions(url, commit);
    const lib = await ensureLibrary(opts);
    expect(exists(path.join(lib.dir, 'core', 'assets')), '首次检出不该带 core/assets/').toBe(false);
    const project = tempDir();
    await installWith(project, entry('impasto'), false, opts);
    expect(exists(path.join(filmstyle.skillDir(project), 'core', 'assets'))).toBe(false);
    // brick-toy 是 three.js 风格：夹具里放一份假的 three，让它装得上。
    writeFiles(path.join(lib.dir, 'node_modules', 'three'), { 'build/three.module.js': '// three\n' });
    await installWith(project, entry('brick-toy'), true, opts);
    const assets = path.join(filmstyle.skillDir(project), 'core', 'assets', 'polyhaven');
    for (const rel of ['lamp.gltf', 'SOURCES.md', 'tea_set_01/tea_set_01.gltf', 'tea_set_01/textures/diff.jpg']) {
      expect(exists(path.join(assets, rel)), `引用到的 ${rel}（含模型目录整体与许可说明）应当带上`).toBe(true);
    }
    expect(exists(path.join(assets, 'unused.jpg')), '没被引用的资源不该带进项目').toBe(false);
  });

  // am 管理的风格库：放进项目的文件是硬链接（不占第二份磁盘），可写（见 copyPath）。
  // 用户自己的检出：复制，不改它文件的权限。
  it.skipIf(!hasNpm)('links managed library files and copies user checkouts', async () => {
    const { url, commit } = fixtureLibrary();
    const opts = fixtureOptions(url, commit);
    const project = tempDir();
    await installWith(project, entry('impasto'), false, opts);
    const lib = openLibrary(opts);
    const a = fs.statSync(path.join(filmstyle.skillDir(project), 'STYLE.md'));
    const b = fs.statSync(path.join(lib.dir, 'styles', 'impasto', 'STYLE.md'));
    expect(a.ino === b.ino && a.dev === b.dev, 'am 管理的风格库应当硬链接进项目').toBe(true);
    // 不设只读：渲染器 cp 出来的副本会继承只读，而安全模式不放行 chmod。
    expect(a.mode & 0o200).not.toBe(0);

    const user = tempDir();
    // 用户自己的检出看第一种风格的 demo 与海报判断完整，这里补上它们。
    const first = catalog()[0]!.slug;
    writeFiles(user, {
      'core/lib.js': '//',
      'styles/impasto/STYLE.md': '# x',
      'styles/impasto/demo/index.html': '<html>',
      [`styles/${first}/demo/index.html`]: '<html>',
      [`styles/${first}/poster.jpg`]: 'jpg',
    });
    const userEnv = { PATH: process.env.PATH ?? '', [LibraryEnv]: user };
    const other = tempDir();
    filmstyle.install({ projectDir: other, style: entryStyle(entry('impasto')), env: userEnv });
    const c = fs.statSync(path.join(filmstyle.skillDir(other), 'STYLE.md'));
    const d = fs.statSync(path.join(user, 'styles', 'impasto', 'STYLE.md'));
    expect(c.ino === d.ino && c.dev === d.dev, '用户自己的检出应当复制，不该硬链接').toBe(false);
    expect(d.mode & 0o200, '不该改用户检出里文件的权限').not.toBe(0);
  });
});
