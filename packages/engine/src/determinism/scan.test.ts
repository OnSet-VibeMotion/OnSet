import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AllowMarker, problems, scan as scanDir, writeJSON } from './index';
import type { Finding, Report } from './index';

const here = path.dirname(fileURLToPath(import.meta.url));
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-determinism-'));
  temps.push(dir);
  return dir;
}

function writeTree(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

function scan(files: Record<string, string>): Report {
  return scanDir(writeTree(files));
}

function rules(findings: Finding[]): string[] {
  return findings.map((f) => f.file + ':' + f.rule);
}

const cleanComposition = `<!doctype html>
<html><head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>@font-face { font-family: "Noto"; src: url("fonts/noto.woff2"); }</style>
</head><body>
<div data-composition-id="root" data-duration="3"></div>
<script>
  // 不要用 Math.random()，也不要 Date.now()
  /* requestAnimationFrame 同样禁用 */
  const tl = gsap.timeline({ paused: true });
  tl.to(".a", { x: 100, repeat: 2 });
  const label = "fetch me";
  window.__timelines["root"] = tl;
</script>
</body></html>`;

describe('determinism scan', () => {
  // TestCleanCompositionPasses：固定版本的 CDN、注释里提到的禁用 API、
  // 本地字体都不是违规。误判会让人很快不再信任这道门。
  it('clean composition passes', () => {
    const report = scan({ 'index.html': cleanComposition, 'fonts/noto.woff2': 'x' });
    expect(report.ok && report.findings.length === 0, `干净的合成不应有发现：${JSON.stringify(report.findings)}`).toBe(true);
    expect(report.files.join(',')).toBe('index.html');
  });

  describe('script rules are detected with line numbers', () => {
    const cases: Array<[string, string, string]> = [
      ['clock', 'const t = Date.now();', 'clock'],
      ['perf', 'const t = performance.now();', 'clock'],
      ['new-date', 'const d = new Date();', 'clock'],
      ['random', 'const r = Math.random() * 10;', 'random'],
      ['raf', 'requestAnimationFrame(tick);', 'raf'],
      ['interval', 'setInterval(step, 16);', 'interval'],
      ['repeat', "tl.to('.a', { repeat: -1, yoyo: true });", 'infinite-repeat'],
      ['fetch-remote', "fetch('https://example.com/data.json');", 'network'],
      ['xhr', 'const x = new XMLHttpRequest();', 'network'],
    ];
    for (const [name, code, rule] of cases) {
      it(name, () => {
        const report = scan({ 'index.html': '<html>\n<body>\n<script>\n' + code + '\n</script>\n</body></html>' });
        expect(report.ok).toBe(false);
        expect(report.findings).toHaveLength(1);
        const got = report.findings[0];
        expect([got.rule, got.line, got.file]).toEqual([rule, 4, 'index.html']);
      });
    }
  });

  // TestLegitimateLookalikesAreNotFlagged：这些写法与禁用 API 形似但无害。
  it('legitimate lookalikes are not flagged', () => {
    for (const code of [
      'const d = new Date(2024, 0, 1);',
      "tl.to('.a', { repeat: -10 === x ? 1 : 2 });",
      "fetch('data/local.json');",
      'setTimeout(() => document.fonts.ready, 0);',
      'cancelAnimationFrame(id);',
      'const rng = mulberry32(42); rng();',
    ]) {
      const report = scan({ 'index.html': '<script>' + code + '</script>' });
      expect(report.ok, `${code} 不应被判违规：${JSON.stringify(report.findings)}`).toBe(true);
    }
  });

  // TestAllowMarkerMovesFindingToAllowed：viewer 引擎的交互路径合法使用
  // requestAnimationFrame，逐行豁免后不判失败，但仍留痕可审计。
  it('allow marker moves finding to allowed', () => {
    const report = scan({
      'index.html': '<script>\nraf = requestAnimationFrame(tick); // ' + AllowMarker + ': 预览播放\n</script>',
    });
    expect(report.ok).toBe(true);
    expect(report.allowed).toHaveLength(1);
    expect(report.allowed![0].rule).toBe('raf');
  });

  // TestOnlyReferencedFilesAreScanned：从入口沿引用展开；没被引用的草稿不参与判定。
  it('only referenced files are scanned', () => {
    const report = scan({
      'index.html': `<link rel="stylesheet" href="styles/main.css">
<script src="js/anim.js?v=1"></script>
<div data-composition-src="compositions/intro.html"></div>`,
      'js/anim.js': "import { seed } from './util.mjs';\nconst x = Math.random();",
      'js/util.mjs': 'export const seed = Date.now();',
      'compositions/intro.html': '<script>setInterval(f, 10)</script>',
      'styles/main.css': '/* url(https://evil.example/a.png) */ body { background: url(https://images.example/bg.png); }',
      'draft.js': 'Math.random(); Date.now();',
    });
    expect(rules(report.findings)).toEqual([
      'compositions/intro.html:interval',
      'js/anim.js:random',
      'js/util.mjs:clock',
      'styles/main.css:remote-asset',
    ]);
    expect(report.files).not.toContain('draft.js');
  });

  it('remote references', () => {
    const cases: Array<[string, string]> = [
      ['https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js', ''],
      ['https://unpkg.com/lottie-web@5.12.2/build/player/lottie.min.js', ''],
      ['https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js', ''],
      ['https://cdn.jsdelivr.net/npm/gsap/dist/gsap.min.js', 'unpinned-cdn'],
      ['https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js', 'unpinned-cdn'],
      ['https://cdn.jsdelivr.net/npm/gsap@latest/dist/gsap.min.js', 'unpinned-cdn'],
      ['https://cdnjs.cloudflare.com/ajax/libs/gsap/latest/gsap.min.js', 'unpinned-cdn'],
      ['https://fonts.googleapis.com/css2?family=Inter', 'remote-font'],
      ['//images.example.com/a.png', 'remote-asset'],
    ];
    for (const [ref, rule] of cases) {
      const report = scan({ 'index.html': `<script src="${ref}"></script>` });
      const got = report.findings.length > 0 ? report.findings[0].rule : '';
      expect(got, ref).toBe(rule);
    }
  });

  it('import map and style attribute', () => {
    const report = scan({
      'index.html': `<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three/build/three.module.js"}}</script>
<script type="application/json">{"note":"Math.random()"}</script>
<div style="background-image:url('https://images.example/x.png')"></div>`,
    });
    expect(rules(report.findings)).toEqual(['index.html:unpinned-cdn', 'index.html:remote-asset']);
  });

  // TestHTMLStringsInsideScriptsAreNotAttributes：脚本里拼 HTML 的字符串不是真实引用。
  it('HTML strings inside scripts are not attributes', () => {
    const report = scan({ 'index.html': `<script>el.innerHTML = '<img src="https://example.com/a.png">';</script>` });
    expect(report.ok, JSON.stringify(report.findings)).toBe(true);
  });

  it('missing entry is a hint not a failure', () => {
    const report = scan({ 'notes.md': 'x' });
    expect(report.ok).toBe(true);
    expect(report.hints).toHaveLength(1);
  });

  // TestNestedEntryIsFound：渲染器先 hyperframes init 出子项目时，入口在下一层。
  it('nested entry is found', () => {
    const report = scan({
      'project/index.html': '<script>Date.now()</script>',
      'attempts/attempt-01/index.html': '<script>Math.random()</script>',
    });
    expect(rules(report.findings).join(',')).toBe('project/index.html:clock');
  });

  it('duplicate on same line reported once', () => {
    const report = scan({ 'index.html': '<script>Math.random() + Math.random()</script>' });
    expect(report.findings).toHaveLength(1);
  });

  it('writeJSON and problems', () => {
    const report = scan({ 'index.html': '<script>Date.now()</script>' });
    const target = path.join(tempDir(), 'out', 'scan.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeJSON(report, target);
    const body = fs.readFileSync(target, 'utf8');
    expect(body).toContain('"rule": "clock"');
    const list = problems(report);
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('index.html:1 [clock]');
  });

  // TestEmbeddedViewerTemplatePasses：algorithmic-art 技能要求把 viewer 引擎整份
  // 放进镜头目录。它的交互路径逐行写了豁免，扫描必须放行，否则照技能做必挂。
  it('embedded viewer template passes', () => {
    const body = fs.readFileSync(
      path.join(here, '../../../../assets/shared/.agents/skills/algorithmic-art/templates/viewer.html'),
      'utf8',
    );
    const report = scan({ 'index.html': body });
    expect(report.ok, `viewer 模板不应被判违规：${JSON.stringify(report.findings)}`).toBe(true);
    expect((report.allowed ?? []).length, 'viewer 模板的交互路径应以豁免形式留痕').toBeGreaterThan(0);
  });

  // TestVendoredLibrariesAreSkipped：随镜头拷贝的第三方库内部用到 Math.random、
  // requestAnimationFrame 很常见，不在渲染路径上，判定它们只会误判。
  it('vendored libraries are skipped', () => {
    const library =
      'var a=Date.now||function(){return new Date().getTime()};function r(){return Math.random()*2};requestAnimationFrame(f)';
    const report = scan({
      'index.html': `<script src="vendor/gsap.js"></script><script src="gsap.min.js"></script><script src="anime.umd.js"></script><script src="three.js"></script>`,
      'vendor/gsap.js': library,
      'gsap.min.js': library,
      'anime.umd.js': library,
      'three.js': '/*! three.js | MIT license */\n' + library,
    });
    expect(report.ok, JSON.stringify(report.findings)).toBe(true);
    expect(report.skipped).toHaveLength(4);
  });

  // TestStringAndRegexLiteralsDoNotTrigger：审查报告给出的三个误判复现。
  it('string and regex literals do not trigger', () => {
    for (const code of [
      "const t='Date.now() is banned';",
      'const caption = `别用 Math.random()`;',
      'var re=/["\']/g; // Math.random() note',
      "var re=/`/g;\n// don't use Math.random()\nvar s=`x`;",
      'if (/requestAnimationFrame/.test(s)) {}',
    ]) {
      const report = scan({ 'index.html': '<script>' + code + '</script>' });
      expect(report.ok, `${code} 不应被判违规：${JSON.stringify(report.findings)}`).toBe(true);
    }
    // 除号不能被当成正则开头，否则后面的真违规会被吞掉。
    const report = scan({
      'index.html': '<script>const half = width / 2; const r = Math.random(); const q = a / b;</script>',
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].rule).toBe('random');
  });

  // TestNonFetchingHrefIsIgnored：<a> 与 canonical 链接渲染时不会被请求。
  it('non-fetching href is ignored', () => {
    const report = scan({
      'index.html': `<a href="https://example.com">x</a>
<link rel="canonical" href="https://example.com/page">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<svg><image href="https://images.example/a.png"/></svg>`,
    });
    expect(rules(report.findings)).toEqual(['index.html:remote-font', 'index.html:remote-asset']);
  });

  it('font-face checks', () => {
    const report = scan({
      'index.html': `<html><head><link rel="stylesheet" href="css/fonts.css"><style>
@font-face { font-family: "Noto Sans SC"; src: url("assets/fonts/noto-400.woff2"); font-display: block; }
@font-face { font-family: "Noto Sans SC"; font-weight: 700; src: url("assets/fonts/noto-700.woff2"); font-display: swap; }
@font-face { font-family: "Inter"; src: local("Inter"), url(assets/fonts/inter.woff2); }
</style></head><body></body></html>`,
      'css/fonts.css': "@font-face { font-family: Mono; src: url('../assets/fonts/mono.woff2'); font-display: optional; }\n",
      'assets/fonts/noto-400.woff2': 'x',
      'assets/fonts/noto-700.woff2': 'x',
      'assets/fonts/mono.woff2': 'x',
    });
    expect(rules(report.findings)).toEqual([
      'css/fonts.css:font-display',
      'index.html:font-display',
      'index.html:font-missing',
    ]);
    for (const f of report.findings) {
      if (f.rule === 'font-missing') {
        expect(f.line, '缺失字体应点名行号').toBe(4);
        expect(f.message, '缺失字体应点名路径').toContain('assets/fonts/inter.woff2');
      }
    }
  });

  // TestFontFaceWithoutDisplayPasses：没写 font-display 时 Chrome 按 block 处理，不判。
  it('font-face without display passes', () => {
    const report = scan({
      'index.html': `<style>@font-face { font-family: A; src: url(a.woff2); }</style>`,
      'a.woff2': 'x',
    });
    expect(report.ok, JSON.stringify(report.findings)).toBe(true);
  });
});
