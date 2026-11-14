import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareBytes } from '../gojson';
import { DirectorySource } from './dirsource';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

function write(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

function list(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort(compareBytes);
}

/** 假风格库：一种 three.js 风格（用到一个模型与一张贴图）、一种纯 2D 风格，库根下共用的素材与 three.js。 */
function library(): string {
  const lib = temp('am-dirsource-lib-');
  write(lib, {
    'orbit/STYLE.md': '# 轨道\n',
    'orbit/index.html': `<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const PH = 'assets/polyhaven/';
load(PH + 'tea_set_01/tea_set_01.gltf');
texture('assets/textures/grain.png');
</script>`,
    'orbit/assets/local-note.txt': '风格自己的素材，源码里没提到',
    'flat/STYLE.md': '# 平面\n',
    'flat/main.js': "document.title = 'flat';\n",
    'assets/SOURCES.md': '许可与出处',
    'assets/polyhaven/tea_set_01/tea_set_01.gltf': '{}',
    'assets/polyhaven/tea_set_01/tea_set_01.bin': 'bin',
    'assets/polyhaven/chair_02/chair_02.gltf': '{}',
    'assets/textures/grain.png': 'png',
    'assets/textures/unused.png': 'png',
    'node_modules/three/LICENSE': 'MIT',
    'node_modules/three/package.json': '{"name":"three"}',
    'node_modules/three/build/three.module.js': 'export const REVISION = "1";\n',
    'node_modules/three/build/three.webgpu.js': 'export {};\n',
    'node_modules/three/examples/jsm/controls/OrbitControls.js': "import { EventDispatcher } from 'three';\nimport { helper } from '../utils/helper.js';\n",
    'node_modules/three/examples/jsm/utils/helper.js': 'export const helper = 1;\n',
    'node_modules/three/examples/jsm/loaders/GLTFLoader.js': "import { Loader } from 'three';\n",
  });
  return lib;
}

const source = (lib: string, onlyReferenced: boolean) => new DirectorySource({ id: 'x-test', name: '测试库', dir: lib, version: 'v1', origin: '测试', onlyReferenced });

describe('directory style library with only_referenced', () => {
  it('brings only the models, textures and three.js modules a style uses', () => {
    const lib = library();
    const src = source(lib, true);
    const orbit = src.catalog().find((s) => s.slug === 'orbit')!;
    const dir = temp('am-dirsource-out-');
    src.fill(dir, orbit);
    expect(list(dir)).toEqual([
      'SKILL.md',
      'STYLE.md',
      'assets/SOURCES.md',
      'assets/polyhaven/tea_set_01/tea_set_01.bin',
      'assets/polyhaven/tea_set_01/tea_set_01.gltf',
      'assets/textures/grain.png',
      'index.html',
      'node_modules/three/LICENSE',
      'node_modules/three/build/three.module.js',
      'node_modules/three/examples/jsm/controls/OrbitControls.js',
      'node_modules/three/examples/jsm/utils/helper.js',
      'node_modules/three/package.json',
    ]);
  });

  it('leaves three.js out of a style that does not import it', () => {
    const lib = library();
    const src = source(lib, true);
    const dir = temp('am-dirsource-out-');
    src.fill(dir, src.catalog().find((s) => s.slug === 'flat')!);
    expect(list(dir)).toEqual(['SKILL.md', 'STYLE.md', 'assets/SOURCES.md', 'main.js']);
  });

  it('copies the style directory as is without it', () => {
    const lib = library();
    const src = source(lib, false);
    const dir = temp('am-dirsource-out-');
    src.fill(dir, src.catalog().find((s) => s.slug === 'orbit')!);
    expect(list(dir)).toEqual(['SKILL.md', 'STYLE.md', 'assets/local-note.txt', 'index.html']);
  });
});
