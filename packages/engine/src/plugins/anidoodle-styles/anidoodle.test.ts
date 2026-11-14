import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as determinism from '../../determinism';
import * as filmstyle from '../../filmstyle';
import { isMissing } from '../../prereq';
import {
  BuildMarker,
  CompilerVersion,
  EngineSrc,
  LibraryEnv,
  ModulesDir,
  PinnedStyleCount,
  RuntimeFile,
  SkillRoot,
  SourceID,
  allModules,
  buildDir,
  catalog,
  catalogFile,
  compileModule,
  entryStyle,
  fill,
  libraryStages,
  moduleImports,
  prepareLibrary,
  requireLibrary,
  rewriteSpecifiers,
  slugOf,
  type Catalog,
  type LibraryOptions,
} from './index';

function has(tool: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;
}
const hasGit = has('git');
const hasFFmpeg = has('ffmpeg');

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-anidoodle-'));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function gitRun(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

describe('anidoodle catalog', () => {
  // 目录是从固定 commit 生成的；条数对不上说明升级时只改了 PinnedCommit 没重跑生成器。
  it('matches the pinned commit', () => {
    const list = catalog();
    expect(list.length).toBe(PinnedStyleCount);
    const slugs = new Set<string>();
    const cells = new Set<number>();
    for (const style of list) {
      expect(style.cn !== '' && style.en !== '' && style.category_cn !== '' && style.hero_cn !== '' && style.uses.length > 0, style.slug).toBe(true);
      // 与目录式风格库同一条目录名规则：小写字母、数字与连字符。
      expect(style.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(style.slug).toBe(slugOf(style.id));
      expect(style.modules).toContain('canvas-core/core.ts');
      expect(style.modules).toContain('canvas-core/film.ts');
      expect(style.modules).toContain(style.module);
      expect(style.modules).toContain(style.draw_film);
      slugs.add(style.slug);
      cells.add(style.cell);
    }
    expect(slugs.size).toBe(list.length);
    expect([...cells].sort((a, b) => a - b)).toEqual(list.map((_, i) => i));
  });

  it('is registered in the film-style catalog', () => {
    expect(filmstyle.sourceByID(SourceID)).toBeDefined();
    for (const name of ['anidoodle/woodcut', '浮世绘木版', 'ukiyo-e colour woodblock']) {
      expect(filmstyle.styleKey(filmstyle.lookup(name)), name).toBe('anidoodle/woodcut');
    }
    expect(entryStyle(catalog().find((s) => s.id === 'sumiE')!).slug).toBe('sumi-e');
  });

  // 中文名、目录名、英文名在两个来源之间撞了，只写名字就得写全；中文名刻意避开了 lemo 的。
  it('does not share a Chinese name with another source', () => {
    const others = filmstyle
      .sources()
      .filter((s) => s.id() !== SourceID)
      .flatMap((s) => s.catalog().map((style) => style.cn));
    for (const style of catalog()) expect(others, style.cn).not.toContain(style.cn);
  });

  it('downloads only what the styles use', () => {
    const stages = libraryStages(catalogFile());
    const last = stages[stages.length - 1]!;
    for (const rel of allModules()) expect(last).toContain(`/${EngineSrc}/${rel}`);
    expect(last.some((p) => p.includes('/music/') || p.includes('/tools/') || p.includes('assets/audio'))).toBe(false);
    // 每段只在上一段后面追加。
    for (let i = 1; i < stages.length; i++) expect(stages[i]!.slice(0, stages[i - 1]!.length)).toEqual(stages[i - 1]);
  });

  it('reports a missing library as a prerequisite', () => {
    const env = { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tempDir(), HOME: tempDir() };
    let err: unknown;
    try {
      requireLibrary({ env });
    } catch (e) {
      err = e;
    }
    expect(isMissing(err)).toBe(true);
  });
});

describe('compileModule', () => {
  it('strips types the way the upstream engine writes them and makes imports browser paths', () => {
    const js = compileModule(
      [
        'import { rng, type P } from "./core";',
        'import type { Film } from "./film";',
        'export { mark } from "../kit/marks.ts";',
        'class Layer { constructor(public w: number, private h = 2) {} }',
        'export const n = <number>(1 as number);',
        'export const film: Film | null = null;',
        'export const lazy = () => import("./lazy");',
        'export const L = new Layer(rng(1)() as unknown as number);',
      ].join('\n'),
      'x.ts',
    );
    expect(moduleImports(js)).toEqual(['./core.js', '../kit/marks.js', './lazy.js']);
    expect(js).not.toContain('./film');
    expect(js).not.toMatch(/: number|as number|<number>/);
    expect(js).toContain('this.w = w');
  });

  // 上游把类型与值写在同一条 import 里、类型不带 type：只去类型的话浏览器报「没有导出 P」。
  it('drops imports that are not used as values, like tsc does', () => {
    const js = compileModule(
      [
        'import { P, rng, Ctx } from "./core";',
        'import { Film } from "./film";',
        'import Pal, { hue } from "./palette";',
        'import { spread } from "./more";',
        'export const pts: P[] = [];',
        'export const draw = (c: Ctx) => c.P + rng(1)() + hue;',
        'export const all = [...spread];',
        'const label = "P and Film";',
        'const glyphs = { O: 1, P: { l: [] }, Film: 2 };',
      ].join('\n'),
      'x.ts',
    );
    expect(js).toContain('import { rng } from "./core.js";');
    expect(js).not.toContain('./film');
    expect(js).toContain('import { hue } from "./palette.js";');
    expect(js).toContain('import { spread } from "./more.js";');
  });

  it('leaves packages and other files alone', () => {
    expect(rewriteSpecifiers('import a from "three"; import b from "./font.ttf"; import c from \'./c\';')).toBe(
      'import a from "three"; import b from "./font.ttf"; import c from \'./c.js\';',
    );
  });
});

/** 夹具：两种风格（一种有说明、一种没有）、几个不该下载的文件与一张 2×1 的图鉴。 */
function fixture(): { url: string; commit: string; catalog: Catalog } {
  const repo = tempDir();
  gitRun(repo, 'init', '-q', '-b', 'main');
  gitRun(repo, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  gitRun(repo, 'config', 'uploadpack.allowFilter', 'true');
  const cc = `${EngineSrc}/canvas-core`;
  writeFiles(repo, {
    LICENSE: 'Apache\n',
    NOTICE: 'notice\n',
    'README.md': 'readme\n',
    'assets/audio/piano.mp3': 'mp3',
    [`${SkillRoot}/SKILL.md`]: '# skill\n',
    [`${SkillRoot}/references/styles.md`]: '# styles\n',
    [`${SkillRoot}/references/craft-bar.md`]: '# craft\n',
    [`${SkillRoot}/references/styles/foo.md`]: '# Foo (`foo.ts`)\n\n**Medium.** ink.\n',
    [`${SkillRoot}/references/music/compose.md`]: '# music\n',
    [`${SkillRoot}/engine/styles.gen.json`]: '[]',
    [`${SkillRoot}/engine/tools/render.mjs`]: '// render\n',
    [`${cc}/core.ts`]: 'export type P = [number, number];\nexport const rng = (seed: number) => () => seed / 7;\n',
    [`${cc}/film.ts`]: 'import type { P } from "./core";\nexport const renderFrame = (film: unknown, ctx: unknown, frame: number, env: unknown): string | null => null;\n',
    [`${cc}/foo.ts`]: 'import { rng } from "./core";\nimport { mark } from "./fooKit";\nexport const foo = { meta: { W: mark(rng(1)()) } };\n',
    [`${cc}/fooKit.ts`]: 'export class Pen { constructor(public w: number) {} }\nexport const mark = (n: number): number => <number>n;\n',
    [`${cc}/bar.ts`]: '// the bar plate\nimport { rng } from "./core";\nexport const bar = rng(2);\n',
    [`${cc}/music/score.ts`]: 'export const score = 1;\n',
  });
  const sheet = path.join(repo, SkillRoot, 'assets', 'styles.jpg');
  fs.mkdirSync(path.dirname(sheet), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=200x100', '-frames:v', '1', sheet]);
  gitRun(repo, 'add', '-A');
  gitRun(repo, 'commit', '-qm', 'fixture');
  const commit = gitRun(repo, 'rev-parse', 'HEAD');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(sheet)).digest('hex');
  const base = { family: 'ink', category_cn: '墨', medium: 'ink on paper', hero: 'a thing', hero_cn: '一样东西', uses: ['科普'] };
  return {
    url: 'file://' + repo,
    commit,
    catalog: {
      commit,
      sheet: { path: `${SkillRoot}/assets/styles.jpg`, sha256, cols: 2, pitch_x: 100, pitch_y: 100, inset: 2, size: 90 },
      references: [`${SkillRoot}/references/styles.md`, `${SkillRoot}/references/craft-bar.md`],
      styles: [
        { ...base, slug: 'foo', id: 'foo', num: '01', en: 'Foo', cn: '甲', doc: `${SkillRoot}/references/styles/foo.md`, module: 'canvas-core/foo.ts', draw_film: 'canvas-core/foo.ts', modules: ['canvas-core/core.ts', 'canvas-core/film.ts', 'canvas-core/foo.ts', 'canvas-core/fooKit.ts'], cell: 1 },
        { ...base, slug: 'bar-baz', id: 'barBaz', num: '02', en: 'Bar', cn: '乙', doc: '', module: 'canvas-core/bar.ts', draw_film: 'canvas-core/bar.ts', modules: ['canvas-core/bar.ts', 'canvas-core/core.ts', 'canvas-core/film.ts'], cell: 0 },
      ],
    },
  };
}

describe.skipIf(!hasGit || !hasFFmpeg)('anidoodle library', () => {
  it('downloads, builds and fills a style', async () => {
    const f = fixture();
    const opts: LibraryOptions = { env: { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tempDir(), HOME: process.env.HOME ?? '' }, repoURL: f.url, commit: f.commit, catalog: f.catalog };
    const stages: string[] = [];
    const lib = await prepareLibrary({ ...opts, progress: (p) => stages.push(`${p.step}/${p.steps} ${p.stage}`) });
    expect(stages).toEqual(['1/3 下载 anidoodle（风格说明与绘图模块）', '2/3 把 TypeScript 转成浏览器模块', '3/3 从图鉴里裁出风格海报']);
    expect(lib.managed).toBe(true);
    expect(lib.commit).toBe(f.commit);
    // 只取了要用的：配乐、工具、README 与不在目录里的模块都没下载。
    for (const rel of ['README.md', 'assets/audio/piano.mp3', `${SkillRoot}/references/music/compose.md`, `${SkillRoot}/engine/tools/render.mjs`, `${EngineSrc}/canvas-core/music/score.ts`]) {
      expect(fs.existsSync(path.join(lib.dir, rel)), rel).toBe(false);
    }
    const build = buildDir(lib, opts.env);
    expect(fs.readFileSync(path.join(build, BuildMarker), 'utf8')).toBe(`${f.commit} ${CompilerVersion}\n`);
    expect(fs.readFileSync(path.join(build, ModulesDir, 'canvas-core', 'foo.js'), 'utf8')).toContain('from "./fooKit.js"');
    // 图鉴里第 1 格（右边那一格）裁成 foo 的海报。
    const poster = path.join(build, 'posters', 'foo.jpg');
    expect(fs.statSync(poster).size).toBeGreaterThan(0);
    // 再跑一次什么都不做。
    const again = await prepareLibrary(opts);
    expect(again.dir).toBe(lib.dir);

    const dir = tempDir();
    fill(dir, f.catalog.styles[0]!, { ...lib, build }, f.catalog);
    const files = (d: string, rel = ''): string[] =>
      fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(d, path.join(rel, e.name)) : [path.join(rel, e.name)]));
    expect(files(dir).sort()).toEqual(
      [
        'ATTRIBUTION.md',
        'LICENSE',
        'NOTICE',
        'SKILL.md',
        'STYLE.md',
        'poster.jpg',
        'anidoodle/onset-anidoodle.js',
        'anidoodle/canvas-core/core.js',
        'anidoodle/canvas-core/film.js',
        'anidoodle/canvas-core/foo.js',
        'anidoodle/canvas-core/fooKit.js',
        'references/craft-bar.md',
        'references/styles.md',
        'source/canvas-core/core.ts',
        'source/canvas-core/film.ts',
        'source/canvas-core/foo.ts',
        'source/canvas-core/fooKit.ts',
      ].sort(),
    );
    const style = fs.readFileSync(path.join(dir, 'STYLE.md'), 'utf8');
    expect(style).toContain('# 甲 · Foo');
    expect(style).toContain('**Medium.** ink.');
    const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(skill).toContain('`anidoodle/canvas-core/fooKit.js`（原文 `source/canvas-core/fooKit.ts`）：笔触工具');
    expect(skill).not.toContain('<no value>');
    expect(fs.readFileSync(path.join(dir, ModulesDir, RuntimeFile), 'utf8')).toContain("from './canvas-core/film.js'");
    expect(fs.readFileSync(path.join(dir, 'ATTRIBUTION.md'), 'utf8')).toContain(f.commit);
    // 硬链接进项目：与构建目录是同一个文件。
    expect(fs.statSync(path.join(dir, 'anidoodle/canvas-core/foo.js')).ino).toBe(fs.statSync(path.join(build, ModulesDir, 'canvas-core/foo.js')).ino);

    // 没有说明的风格从源码文件头读。
    const bare = tempDir();
    fill(bare, f.catalog.styles[1]!, { ...lib, build }, f.catalog);
    expect(fs.readFileSync(path.join(bare, 'STYLE.md'), 'utf8')).toContain('source/canvas-core/bar.ts');
  });

  it('builds a checkout of your own outside it, and refuses another commit', async () => {
    const f = fixture();
    const own = tempDir();
    gitRun(own, 'clone', '-q', f.url.replace('file://', ''), '.');
    const env = { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tempDir(), HOME: process.env.HOME ?? '', [LibraryEnv]: own };
    const lib = await prepareLibrary({ env, commit: f.commit, catalog: f.catalog });
    expect(lib.managed).toBe(false);
    expect(buildDir(lib, env).startsWith(own)).toBe(false);
    expect(fs.existsSync(path.join(own, '.onset-build'))).toBe(false);
    expect(gitRun(own, 'status', '--porcelain')).toBe('');
    await expect(prepareLibrary({ env, commit: 'f'.repeat(40), catalog: f.catalog })).rejects.toThrow('请在你的检出里切到这个 commit');
  });
});

// 真实上游：设 ONSET_ANIDOODLE_SRC=<固定 commit 的检出> 时，把 32 种风格全部转换、装进镜头目录，
// 用镜头产物校验同一套确定性扫描过一遍（接头 + 风格模块不能被判成不确定）。
const realSrc = process.env.ONSET_ANIDOODLE_SRC ?? '';
describe.skipIf(realSrc === '' || !hasFFmpeg)('anidoodle against the pinned upstream', () => {
  it('builds every style and passes the determinism scan', async () => {
    const env = { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tempDir(), HOME: process.env.HOME ?? '', [LibraryEnv]: realSrc };
    const lib = await prepareLibrary({ env });
    const build = buildDir(lib, env);
    for (const entry of catalog()) {
      const scene = tempDir();
      const style = path.join(scene, 'style');
      fs.mkdirSync(style);
      fill(style, entry, { ...lib, build });
      fs.cpSync(path.join(style, ModulesDir), path.join(scene, ModulesDir), { recursive: true });
      const kit = entry.modules.find((m) => /Kit\.ts$/.test(m)) ?? entry.module;
      fs.writeFileSync(
        path.join(scene, 'index.html'),
        `<canvas id="c"></canvas><script type="module">\nimport { play } from './anidoodle/onset-anidoodle.js';\nimport * as kit from './anidoodle/${kit.replace(/\.ts$/, '.js')}';\nimport * as plate from './anidoodle/${entry.draw_film.replace(/\.ts$/, '.js')}';\n</script>\n`,
      );
      fs.rmSync(style, { recursive: true });
      const report = determinism.scan(scene);
      expect(report.findings, entry.slug).toEqual([]);
      expect(report.files.length, entry.slug).toBeGreaterThanOrEqual(entry.modules.length);
    }
  }, 120_000);
});
