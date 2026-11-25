import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as filmstyle from '../filmstyle';
import '../plugin';
import { verifyOutput } from '../scene/run';
import { load, outputPath } from '../scene/scene';
import { fakeFfprobe, frameWithCanvas } from '../scene/testsupport';
import { VerificationError } from '../scene/verification';
import { checkEngineContract, formatEngineContractIssue } from './engine_contract';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-engine-contract-'));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function setupProjectScene(opts: {
  styleKey?: string;
  sceneFilmStyle?: string;
  files: Record<string, string>;
  extraSceneJson?: Record<string, unknown>;
}): { projectDir: string; sceneDir: string } {
  const projectDir = tempDir();
  fs.writeFileSync(path.join(projectDir, 'onset.conf'), '');
  if (opts.styleKey) {
    filmstyle.install({ projectDir, style: filmstyle.lookup(opts.styleKey) });
  }
  const sceneDir = path.join(projectDir, 'scenes', 'scene-001');
  fs.mkdirSync(sceneDir, { recursive: true });
  fs.writeFileSync(path.join(sceneDir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  fs.writeFileSync(path.join(sceneDir, 'frame.md'), frameWithCanvas(1080, 1440));
  const sceneObj: Record<string, unknown> = {
    id: 'scene-001',
    duration_seconds: 1,
    output: 'out.mp4',
    transcript: 'transcript.srt',
    text: 'hello',
    ...(opts.sceneFilmStyle !== undefined ? { film_style: opts.sceneFilmStyle } : {}),
    ...(opts.extraSceneJson ?? {}),
  };
  fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify(sceneObj));
  for (const [rel, body] of Object.entries(opts.files)) {
    const file = path.join(sceneDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
  return { projectDir, sceneDir };
}

describe('engine contract gate', () => {
  it('blocks CSS pseudo-3D disguise and missing Three.js for threejs styles', () => {
    const { sceneDir } = setupProjectScene({
      styleKey: 'mg-styles/03-isometric',
      files: {
        'index.html': `<style>.cube { transform-style: preserve-3d; perspective: 800px; transform: rotateX(35deg) rotateY(45deg); }</style>
<div class="cube"></div>
<script>// THREE.Scene is only in a comment and must not pass</script>`,
      },
    });
    const report = checkEngineContract(sceneDir);
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].engine).toBe('threejs');
    expect(report.errors[0].disguise?.length).toBeGreaterThan(0);
    expect(formatEngineContractIssue(report.errors[0])).toContain('CSS 伪 3D');
  });

  it('passes authentic Three.js imports and global THREE API usage', () => {
    const byImport = setupProjectScene({
      styleKey: 'mg-styles/10-synthwave',
      files: {
        'index.html': `<script type="module" src="main.js"></script>`,
        'main.js': `import * as THREE from 'three';\nconst scene = new THREE.Scene();\nconst cam = new THREE.PerspectiveCamera(55, 1, 0.1, 100);`,
      },
    });
    const r1 = checkEngineContract(byImport.sceneDir);
    expect(r1.ok).toBe(true);
    expect(r1.errors).toEqual([]);
    expect(r1.warnings).toEqual([]);

    const byScript = setupProjectScene({
      styleKey: 'mg-styles/22-hud',
      files: {
        'index.html': `<script src="./vendor/three.min.js"></script><script>const g = new THREE.EdgesGeometry();</script>`,
      },
    });
    const r2 = checkEngineContract(byScript.sceneDir);
    expect(r2.ok).toBe(true);
    expect(r2.errors).toEqual([]);
  });

  it('blocks CSS backdrop-filter/blur disguise for webgl2 styles and passes real WebGL2', () => {
    const fake = setupProjectScene({
      styleKey: 'mg-styles/12-aurora-glass',
      files: {
        'index.html': `<style>.glass { backdrop-filter: blur(24px); filter: blur(8px); }</style><div class="glass"></div>`,
      },
    });
    const bad = checkEngineContract(fake.sceneDir);
    expect(bad.ok).toBe(false);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0].engine).toBe('webgl2');
    expect(bad.errors[0].disguise?.length).toBeGreaterThan(0);
    expect(bad.errors[0].message).toContain('CSS 滤镜伪装');

    const real = setupProjectScene({
      styleKey: 'mg-styles/07-liquid',
      files: {
        'index.html': `<canvas id="gl"></canvas><script>
const gl = document.getElementById('gl').getContext('webgl2');
const sh = gl.createShader(gl.FRAGMENT_SHADER);
gl.compileShader(sh);
</script>`,
      },
    });
    const good = checkEngineContract(real.sceneDir);
    expect(good.ok).toBe(true);
    expect(good.errors).toEqual([]);
  });

  it('downgrades error to warning with recorded reason when explicit deviation is declared', () => {
    const byComment = setupProjectScene({
      styleKey: 'mg-styles/03-isometric',
      files: {
        'index.html': `<script>
// onset-engine-deviation: threejs -> canvas2d | reason: 本镜为 1 秒纯章节过渡字幕卡，无需 3D 场景
const ctx = document.createElement('canvas').getContext('2d');
</script>`,
      },
    });
    const r1 = checkEngineContract(byComment.sceneDir);
    expect(r1.ok).toBe(true);
    expect(r1.errors).toEqual([]);
    expect(r1.warnings).toHaveLength(1);
    expect(r1.warnings[0].deviation).toMatchObject({
      engine: 'threejs',
      replacement: 'canvas2d',
      reason: '本镜为 1 秒纯章节过渡字幕卡，无需 3D 场景',
    });

    // 缺少 reason 不予豁免
    const noReason = setupProjectScene({
      styleKey: 'mg-styles/03-isometric',
      files: {
        'index.html': `<script>// onset-engine-deviation: threejs -> canvas2d | reason:   </script>`,
      },
    });
    expect(checkEngineContract(noReason.sceneDir).ok).toBe(false);

    // 镜头配置字段（engine-deviation.json / scene.json engine_deviation）豁免
    const bySidecar = setupProjectScene({
      styleKey: 'mg-styles/20-pixel',
      files: {
        'index.html': `<style>.crt { filter: blur(2px); }</style>`,
        'engine-deviation.json': JSON.stringify({
          engine: 'webgl2',
          replacement: 'canvas2d',
          reason: '单帧像素图标由 Canvas2D 整数缩放直出',
        }),
      },
    });
    const r2 = checkEngineContract(bySidecar.sceneDir);
    expect(r2.ok).toBe(true);
    expect(r2.warnings).toHaveLength(1);
    expect(r2.warnings[0].deviation?.source).toBe('engine-deviation.json');

    const bySceneField = setupProjectScene({
      styleKey: 'mg-styles/07-liquid',
      files: { 'index.html': `<div>title</div>` },
      extraSceneJson: { engine_deviation: 'webgl2 -> canvas2d | reason: 纯黑底引语过渡镜' },
    });
    const r3 = checkEngineContract(bySceneField.sceneDir);
    expect(r3.ok).toBe(true);
    expect(r3.warnings).toHaveLength(1);
    expect(r3.warnings[0].deviation?.source).toBe('scene.json');
  });

  it('emits non-blocking warning when canvas2d style omits getContext("2d")', () => {
    const missing = setupProjectScene({
      styleKey: 'mg-styles/01-flat-vector',
      files: { 'index.html': `<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>` },
    });
    const r1 = checkEngineContract(missing.sceneDir);
    expect(r1.ok).toBe(true);
    expect(r1.errors).toEqual([]);
    expect(r1.warnings).toHaveLength(1);
    expect(r1.warnings[0].engine).toBe('canvas2d');

    const present = setupProjectScene({
      styleKey: 'mg-styles/01-flat-vector',
      files: { 'index.html': `<canvas id="c"></canvas><script>const ctx = c.getContext('2d');</script>` },
    });
    const r2 = checkEngineContract(present.sceneDir);
    expect(r2.ok).toBe(true);
    expect(r2.warnings).toEqual([]);
  });

  it('has zero impact on legacy styles without engine_contract or film_style="none"', () => {
    const legacy = setupProjectScene({
      files: { 'index.html': `<div style="backdrop-filter: blur(10px); transform: rotateY(30deg);"></div>` },
    });
    // 手写一份不含 engine_contract 的老风格目录
    const legacyDir = filmstyle.skillDir(legacy.projectDir);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, filmstyle.StyleFile), '# Legacy\n');
    fs.writeFileSync(path.join(legacyDir, filmstyle.GuideFile), '# Guide\n');
    fs.writeFileSync(
      path.join(legacyDir, filmstyle.ManifestFile),
      JSON.stringify({
        source: 'lemo-opuscar',
        slug: 'impasto',
        cn: '油画厚涂',
        en: 'Impasto',
        version: 'v1',
        digest: 'd',
        installed_at: '2026-01-01T00:00:00Z',
      }),
    );
    const rLegacy = checkEngineContract(legacy.sceneDir);
    expect(rLegacy.ok).toBe(true);
    expect(rLegacy.contract).toBeNull();
    expect(rLegacy.errors).toEqual([]);
    expect(rLegacy.warnings).toEqual([]);

    const none = setupProjectScene({
      styleKey: 'mg-styles/03-isometric',
      sceneFilmStyle: 'none',
      files: { 'index.html': `<div style="transform: rotateX(45deg);"></div>` },
    });
    const rNone = checkEngineContract(none.sceneDir);
    expect(rNone.ok).toBe(true);
    expect(rNone.contract).toBeNull();
  });

  it('hooks into verifyOutput and throws VerificationError with aligned checks on violation', () => {
    const { sceneDir } = setupProjectScene({
      styleKey: 'mg-styles/03-isometric',
      files: {
        'index.html': `<style>.box { transform-style: preserve-3d; transform: rotateY(40deg); }</style><div class="box"></div>`,
      },
    });
    const s = load(sceneDir);
    fs.writeFileSync(outputPath(s), 'video');
    const bin = tempDir();
    fakeFfprobe(bin, {});
    const env = { PATH: bin, HOME: tempDir() };

    let err: unknown = null;
    try {
      verifyOutput(s, env, 0.15);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VerificationError);
    const v = err as VerificationError;
    expect(v.checks?.length).toBe(v.problems.length);
    expect(v.message).toContain('engine-contract.threejs');

    // 加显式偏离声明后 verifyOutput 放行
    fs.writeFileSync(
      path.join(sceneDir, 'index.html'),
      `<!-- onset-engine-deviation: threejs -> canvas2d | reason: 测试豁免放行 -->\n<div>ok</div>`,
    );
    expect(() => verifyOutput(s, env, 0.15)).not.toThrow();
  });
});
