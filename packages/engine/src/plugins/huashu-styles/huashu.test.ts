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
  BuildVersion,
  EngineDir,
  LibraryEnv,
  PinnedStyleCount,
  RecipesDir,
  SourceID,
  buildDir,
  catalog,
  catalogFile,
  entryStyle,
  fill,
  fontsScript,
  libraryStages,
  patchEngine,
  prepareLibrary,
  requireLibrary,
  sceneOutline,
  templateHTML,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-huashu-'));
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

const upstreamEngine = [
  '(() => {',
  'window.__total = 1;',
  'function boot() { window.__ready = true; }',
  '// ---------- 预览 UI ----------',
  'function loop() { const t = performance.now(); requestAnimationFrame(loop); }',
  "boot().catch(err => { window.__bootFailed = String(err); });",
  '})();',
  '',
].join('\n');

const upstreamFonts = [
  'window.FONT_FACES = [',
  "  {family:'Cinzel-700', url:'lib/fonts/Cinzel-700.woff'},",
  "  {family:'Kalam-700', url:'lib/fonts/Kalam-700.woff'},",
  "  {family:'LXGWWenKai-500', url:'lib/fonts/LXGWWenKai-500.woff'},",
  "  {family:'Inter', url:'lib/fonts/Inter-var.woff', desc:{weight:'100 900'}},",
  '];',
  '',
].join('\n');

describe('huashu catalog', () => {
  // 目录是从固定 commit 生成的；条数对不上说明升级时只改了 PinnedCommit 没重跑生成器。
  it('matches the pinned commit', () => {
    const file = catalogFile();
    const list = file.styles;
    expect(list.length).toBe(PinnedStyleCount);
    const slugs = new Set<string>();
    const cells = new Set<number>();
    for (const style of list) {
      expect(style.cn !== '' && style.en !== '' && style.category_cn !== '' && style.technique !== '' && style.uses.length > 0, style.slug).toBe(true);
      expect(style.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(['材料层', '时代标本']).toContain(style.layer);
      expect(style.quality).toMatch(/^★★★?/);
      expect(style.scene).toBe(`${EngineDir}/scenes/${style.id}.js`);
      expect(style.card).toBe(`${RecipesDir}/${style.id}.md`);
      expect(style.fonts.map((f) => f.family)).toContain(style.cjk);
      slugs.add(style.slug);
      cells.add(style.cell);
    }
    expect(slugs.size).toBe(list.length);
    expect(cells.size).toBe(list.length);
    expect(file.libs[0]).toBe('lib/util.js');
  });

  // 上游许可写明花叔本人的卡通形象不随 MIT 授权；点名具体作品形象的风格不接。
  it('carries no likeness of the author and no named franchises', () => {
    const file = catalogFile();
    expect(file.libs).not.toContain('lib/rig_huashu.js');
    expect(file.libs).not.toContain('lib/three.min.js');
    const ids = file.styles.map((s) => s.id);
    for (const id of ['25_ghibli', '27_kirby', '35_shinkai', '37_rick_morty', '52_south_park', '53_pixar', '32_rembrandt']) expect(ids).not.toContain(id);
    for (const stage of libraryStages(file)) {
      expect(stage.some((p) => /rig_huashu|three\.min|demos\/|showcase|角色|\.gif|\.mp4/.test(p)), stage.join(' ')).toBe(false);
    }
  });

  it('is registered in the film-style catalog', () => {
    expect(filmstyle.sourceByID(SourceID)).toBeDefined();
    for (const name of ['huashu/van-gogh', '梵高旋涡笔触', 'Van Gogh post-impressionism', 'van-gogh']) {
      expect(filmstyle.styleKey(filmstyle.lookup(name)), name).toBe('huashu/van-gogh');
    }
    expect(entryStyle(catalog().find((s) => s.id === '02_egypt')!).slug).toBe('egyptian-tomb');
  });

  // 中文名在来源之间撞了，只写名字就得写全；中文名刻意避开了 lemo 与 anidoodle 的。
  it('does not share a Chinese name or a directory name with another source', () => {
    const others = filmstyle.sources().filter((s) => s.id() !== SourceID).flatMap((s) => s.catalog());
    for (const style of catalog()) {
      expect(others.map((o) => o.cn), style.cn).not.toContain(style.cn);
      expect(others.map((o) => o.slug), style.slug).not.toContain(style.slug);
    }
  });

  it('downloads only what the styles use, a stage at a time', () => {
    const stages = libraryStages(catalogFile());
    const last = stages[stages.length - 1]!;
    for (const s of catalog()) {
      expect(last).toContain('/' + s.scene);
      expect(last).toContain('/' + s.card);
      for (const f of s.fonts) expect(last).toContain(`/${EngineDir}/lib/fonts/${f.file}`);
    }
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

describe('huashu build steps', () => {
  it('takes the preview player out of the engine and nothing else', () => {
    const out = patchEngine(upstreamEngine);
    expect(out).not.toContain('performance.now');
    expect(out).not.toContain('requestAnimationFrame');
    expect(out).toContain('function boot()');
    expect(out).toContain('boot().catch(');
    // 上游改了写法时直接报错，不悄悄留下播放器或删多了。
    expect(() => patchEngine(upstreamEngine.replace('// ---------- 预览 UI ----------', ''))).toThrow('上游写法已变');
    expect(() => patchEngine(upstreamEngine + 'boot().catch(e => e);\n')).toThrow('恰好出现一次');
  });

  it('lists only the fonts a style carries, with paths inside the shot', () => {
    const js = fontsScript(upstreamFonts, [
      { family: 'Inter', file: 'Inter-var.woff' },
      { family: 'LXGWWenKai-500', file: 'LXGWWenKai-500.woff' },
    ]);
    expect(js).toContain("{family:'Inter', url:'huashu/lib/fonts/Inter-var.woff', desc:{weight:'100 900'}},");
    expect(js).toContain("{family:'LXGWWenKai-500', url:'huashu/lib/fonts/LXGWWenKai-500.woff'},");
    expect(js).not.toContain('Kalam');
    expect(() => fontsScript(upstreamFonts, [{ family: 'Nope-400', file: 'Nope-400.woff' }])).toThrow('没有字体 Nope-400');
    expect(() => fontsScript(upstreamFonts, [{ family: 'Kalam-700', file: 'Other.woff' }])).toThrow('重跑生成器');
  });

  // 场景在库与 STAGE 之后、引擎之前加载：场景模块初始化时就读 STAGE（试作时竖屏读到 1920×1080）。
  it('loads the scene after the stage is set and before the engine', () => {
    const html = templateHTML({ libs: ['lib/util.js', 'lib/paint.js'] });
    const order = ['huashu/onset-huashu-pre.js', 'huashu/lib/fonts.js', 'huashu/lib/util.js', 'huashu/lib/paint.js', 'U.setStage(__W__, __H__)', 'scene.js', "OnsetHuashu.use('scene', __DUR__)", 'huashu/engine.js', 'huashu/onset-huashu.js'];
    let at = -1;
    for (const needle of order) {
      const next = html.indexOf(needle, at + 1);
      expect(next, needle).toBeGreaterThan(at);
      at = next;
    }
    expect(html).toContain('data-no-timeline');
    expect(html).not.toContain('scenes/index.js');
    // 占位符只出现在要换的地方：整份替换不会把注释改坏。
    expect(html.split('\n').filter((l) => l.includes('__W__')).every((l) => !l.includes('<!--') && !l.trimStart().startsWith('场景'))).toBe(true);
  });

  it('outlines the first-level parts of a scene', () => {
    const src = "SCENES['x'] = (() => {\n  const W = 1920;\n  function wall(g) {\n    const inner = 1;\n  }\n  let n = 0;\n  return {\n    draw(c, lt, t) {},\n  };\n})();\n";
    expect(sceneOutline(src)).toBe('- `W`（第 2 行）\n- `wall`（第 3 行）\n- `n`（第 6 行）\n- `draw`（第 8 行）：每一帧的画法顺序都在这里，先读它');
    expect(sceneOutline(src.replace('const inner = 1;', 'const t0 = performance.now();'))).toContain('注意：第 4 行读了时钟');
  });
});

/** 夹具：两种风格、几个不该下载的文件与一张 2×1 的总览图。 */
function fixture(): { url: string; commit: string; catalog: Catalog } {
  const repo = tempDir();
  gitRun(repo, 'init', '-q', '-b', 'main');
  gitRun(repo, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  gitRun(repo, 'config', 'uploadpack.allowFilter', 'true');
  const e = (rel: string) => `${EngineDir}/${rel}`;
  writeFiles(repo, {
    LICENSE: 'MIT\n',
    'README.md': 'readme\n',
    'assets/showcase/hero.gif': 'gif',
    'references/04-纯代码绘制.md': '# 04\n',
    [`${RecipesDir}/02_egypt.md`]: '# 02_egypt\n\n## 踩到的坑\n- 坑\n',
    [`${RecipesDir}/09_postimp.md`]: '# 09_postimp\n',
    [`${RecipesDir}/27_kirby.md`]: '# kirby\n',
    [e('engine.js')]: upstreamEngine,
    [e('transitions.js')]: 'window.TRANSITIONS = {};\n',
    [e('lib/util.js')]: 'window.U = {};\n',
    [e('lib/rig_huashu.js')]: 'window.HUASHU = {};\n',
    [e('lib/fonts.js')]: upstreamFonts,
    [e('lib/fonts/LICENSES.md')]: 'ofl\n',
    [e('lib/fonts/OFL.txt')]: 'ofl\n',
    [e('lib/fonts/Kalam-700.woff')]: 'kalam',
    [e('lib/fonts/Cinzel-700.woff')]: 'cinzel',
    [e('lib/fonts/LXGWWenKai-500.woff')]: 'kai',
    [e('scenes/02_egypt.js')]: "SCENES['02_egypt'] = (() => {\n  const wall = () => 1;\n  return { draw() {} };\n})();\n",
    [e('scenes/09_postimp.js')]: "SCENES['09_postimp'] = (() => {\n  return { draw() {} };\n})();\n",
    [e('scenes/27_kirby.js')]: "SCENES['27_kirby'] = {};\n",
  });
  const sheet = path.join(repo, 'assets', '全风格总览.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=200x100', '-frames:v', '1', sheet]);
  gitRun(repo, 'add', '-A');
  gitRun(repo, 'commit', '-qm', 'fixture');
  const commit = gitRun(repo, 'rev-parse', 'HEAD');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(sheet)).digest('hex');
  const base = { category_cn: '古代', category_en: 'Ancient', uses: ['科普'], layer: '时代标本', quality: '★★★', weakness: '端杯肘偏僵', technique: '平涂细勾线', motifs: '圣甲虫推日' };
  return {
    url: 'file://' + repo,
    commit,
    catalog: {
      commit,
      sheet: { path: 'assets/全风格总览.jpg', sha256, cols: 2, x0: 2, y0: 2, pitch_x: 100, pitch_y: 100, w: 90, h: 60 },
      libs: ['lib/util.js'],
      references: ['references/04-纯代码绘制.md'],
      styles: [
        { ...base, slug: 'egyptian-tomb', id: '02_egypt', num: '01', en: 'Egypt', cn: '甲', scene: e('scenes/02_egypt.js'), card: `${RecipesDir}/02_egypt.md`, fonts: [{ family: 'LXGWWenKai-500', file: 'LXGWWenKai-500.woff' }], cjk: 'LXGWWenKai-500', cell: 1 },
        { ...base, layer: '材料层', weakness: '', slug: 'van-gogh', id: '09_postimp', num: '02', en: 'Gogh', cn: '乙', scene: e('scenes/09_postimp.js'), card: `${RecipesDir}/09_postimp.md`, fonts: [{ family: 'Kalam-700', file: 'Kalam-700.woff' }, { family: 'LXGWWenKai-500', file: 'LXGWWenKai-500.woff' }], cjk: 'LXGWWenKai-500', cell: 0 },
      ],
    },
  };
}

function files(d: string, rel = ''): string[] {
  return fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(d, path.join(rel, e.name)) : [path.join(rel, e.name)]));
}

describe.skipIf(!hasGit || !hasFFmpeg)('huashu library', () => {
  it('downloads, builds and fills a style', async () => {
    const f = fixture();
    const opts: LibraryOptions = { env: { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tempDir(), HOME: process.env.HOME ?? '' }, repoURL: f.url, commit: f.commit, catalog: f.catalog };
    const stages: string[] = [];
    const lib = await prepareLibrary({ ...opts, progress: (p) => stages.push(`${p.step}/${p.steps} ${p.stage}`) });
    expect(stages).toEqual(['1/3 下载花叔艺术动画（引擎、风格配方与字体）', '2/3 改写引擎与字体表', '3/3 从总览图里裁出风格海报']);
    expect(lib.managed).toBe(true);
    expect(lib.commit).toBe(f.commit);
    // 只取了要用的：示范片、花叔的骨架、没接入的风格与没用到的字体都没下载。
    for (const rel of ['README.md', 'assets/showcase/hero.gif', `${EngineDir}/lib/rig_huashu.js`, `${EngineDir}/scenes/27_kirby.js`, `${RecipesDir}/27_kirby.md`, `${EngineDir}/lib/fonts/Cinzel-700.woff`]) {
      expect(fs.existsSync(path.join(lib.dir, rel)), rel).toBe(false);
    }
    const build = buildDir(lib, opts.env);
    expect(fs.readFileSync(path.join(build, BuildMarker), 'utf8')).toBe(`${f.commit} ${BuildVersion}\n`);
    expect(fs.statSync(path.join(build, 'posters', 'van-gogh.jpg')).size).toBeGreaterThan(0);
    // 再跑一次什么都不做。
    expect((await prepareLibrary(opts)).dir).toBe(lib.dir);

    const dir = tempDir();
    fill(dir, f.catalog.styles[0]!, { ...lib, build }, f.catalog);
    expect(files(dir).sort()).toEqual(
      [
        'ATTRIBUTION.md',
        'LICENSE',
        'SKILL.md',
        'STYLE.md',
        'poster.jpg',
        'huashu/onset-huashu-pre.js',
        'huashu/onset-huashu.js',
        'huashu/engine.js',
        'huashu/template.html',
        'huashu/transitions.js',
        'huashu/lib/util.js',
        'huashu/lib/fonts.js',
        'huashu/lib/fonts/LICENSES.md',
        'huashu/lib/fonts/LXGWWenKai-500.woff',
        'huashu/lib/fonts/OFL.txt',
        'references/04-纯代码绘制.md',
        'source/02_egypt.js',
      ].sort(),
    );
    const style = fs.readFileSync(path.join(dir, 'STYLE.md'), 'utf8');
    expect(style).toContain('# 甲 · Egypt');
    expect(style).toContain('## 踩到的坑');
    expect(style).toContain('时代标本');
    expect(style).toContain('当前短板：端杯肘偏僵');
    expect(style).toContain('- `wall`（第 2 行）');
    expect(style).toContain('`LXGWWenKai-500`');
    const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(skill).toContain('source/02_egypt.js');
    expect(skill).toContain('`__W__`');
    for (const text of [style, skill]) {
      expect(text).not.toContain('<no value>');
      expect(text).not.toContain('{{');
    }
    expect(fs.readFileSync(path.join(dir, 'huashu/engine.js'), 'utf8')).not.toContain('performance.now');
    expect(fs.readFileSync(path.join(dir, 'huashu/lib/fonts.js'), 'utf8')).toContain("url:'huashu/lib/fonts/LXGWWenKai-500.woff'");
    expect(fs.readFileSync(path.join(dir, 'ATTRIBUTION.md'), 'utf8')).toContain(f.commit);
    // 硬链接进项目：与检出是同一个文件。
    expect(fs.statSync(path.join(dir, 'source/02_egypt.js')).ino).toBe(fs.statSync(path.join(lib.dir, EngineDir, 'scenes/02_egypt.js')).ino);

    // 材料层的风格说明不写「时代标本」那段，没有短板就不写短板。
    const gogh = tempDir();
    fill(gogh, f.catalog.styles[1]!, { ...lib, build }, f.catalog);
    const gStyle = fs.readFileSync(path.join(gogh, 'STYLE.md'), 'utf8');
    expect(gStyle).toContain('可以盖在任何题材上');
    expect(gStyle).not.toContain('当前短板');
    expect(fs.existsSync(path.join(gogh, 'huashu/lib/fonts/Kalam-700.woff'))).toBe(true);
  });

  it('builds a checkout of your own outside it, and refuses another commit', async () => {
    const f = fixture();
    const own = tempDir();
    gitRun(own, 'clone', '-q', f.url.replace('file://', ''), '.');
    const env = { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tempDir(), HOME: process.env.HOME ?? '', [LibraryEnv]: own };
    const lib = await prepareLibrary({ env, commit: f.commit, catalog: f.catalog });
    expect(lib.managed).toBe(false);
    expect(buildDir(lib, env).startsWith(own)).toBe(false);
    expect(gitRun(own, 'status', '--porcelain')).toBe('');
    await expect(prepareLibrary({ env, commit: 'f'.repeat(40), catalog: f.catalog })).rejects.toThrow('请在你的检出里切到这个 commit');
  });
});

// 真实上游：设 ONSET_HUASHU_SRC=<固定 commit 的检出> 时，把全部风格构建、装进镜头目录（场景用上游原文），
// 用镜头产物校验同一套确定性扫描过一遍：接头、引擎与库不能被判成不确定；上游场景里已知的命中（测耗时读的时钟）
// 必须在 STYLE.md 的源码导览里点名，渲染器照抄时才知道为什么被拦。
const knownSceneFindings: Record<string, string[]> = { 'roman-mosaic': ['clock:301', 'clock:448'] };
const realSrc = process.env.ONSET_HUASHU_SRC ?? '';
describe.skipIf(realSrc === '' || !hasFFmpeg)('huashu against the pinned upstream', () => {
  it('builds every style and passes the determinism scan', async () => {
    const env = { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tempDir(), HOME: process.env.HOME ?? '', [LibraryEnv]: realSrc };
    const lib = await prepareLibrary({ env });
    const build = buildDir(lib, env);
    for (const entry of catalog()) {
      const scene = tempDir();
      const style = path.join(scene, 'style');
      fs.mkdirSync(style);
      fill(style, entry, { ...lib, build });
      fs.cpSync(path.join(style, 'huashu'), path.join(scene, 'huashu'), { recursive: true });
      const html = fs.readFileSync(path.join(scene, 'huashu', 'template.html'), 'utf8').replaceAll('__W__', '1920').replaceAll('__H__', '1080').replaceAll('__DUR__', '4');
      fs.writeFileSync(path.join(scene, 'index.html'), html.replace("OnsetHuashu.use('scene'", `OnsetHuashu.use('${entry.id}'`));
      fs.copyFileSync(path.join(style, 'source', entry.id + '.js'), path.join(scene, 'scene.js'));
      const report = determinism.scan(scene);
      expect(report.findings.filter((f) => f.file !== 'scene.js'), entry.slug).toEqual([]);
      const own = report.findings.filter((f) => f.file === 'scene.js');
      expect(own.map((f) => `${f.rule}:${f.line}`), entry.slug).toEqual(knownSceneFindings[entry.slug] ?? []);
      const styleText = fs.readFileSync(path.join(style, 'STYLE.md'), 'utf8');
      for (const f of own) expect(styleText, entry.slug).toContain(`第 ${f.line} 行`);
      fs.rmSync(style, { recursive: true });
      expect(report.files.length, entry.slug).toBeGreaterThanOrEqual(catalogFile().libs.length + 4);
    }
  }, 300_000);
});
