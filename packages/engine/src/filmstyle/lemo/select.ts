// 移植自 internal/filmstyle/lemo/select.go。
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../../gojson';
import { goClean, goDir, goExt, goJoin } from '../../gofmt';
import { sortedEntries } from './library';

/**
 * 读出技能目录里 demo/ 与 core/ 下的脚本和页面（相对路径 → 内容），
 * 作为挑 three.js 模块与 core/assets 文件的依据。
 */
export function sourceTexts(skillDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const entry of sortedEntries(dir)) {
      const file = path.join(dir, entry.name);
      const childRel = rel + '/' + entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || (entry.name === 'assets' && rel === 'core')) continue;
        walk(file, childRel);
        continue;
      }
      switch (goExt(entry.name).toLowerCase()) {
        case '.js':
        case '.mjs':
        case '.html':
        case '.json':
          break;
        default:
          continue;
      }
      out.set(childRel, fs.readFileSync(file, 'utf8'));
    }
  };
  for (const sub of ['demo', 'core']) {
    const root = path.join(skillDir, sub);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      continue;
    }
    // 根是文件时 WalkDir 只看它自己，而 demo / core 没有扩展名，不会被收进来。
    if (!stat.isDirectory()) continue;
    walk(root, sub);
  }
  return out;
}

/**
 * ES 模块的导入说明符：import … from '…'、export … from '…'、import '…' 与 import('…')。
 * RE2 的 \s 只认 ASCII 空白，这里写成 [\t\n\f\r ]；不加 u 标志，\b 保持 ASCII 语义。
 */
const specifierPattern = /(?:\bfrom[\t\n\f\r ]*|\bimport[\t\n\f\r ]*\([\t\n\f\r ]*|\bimport[\t\n\f\r ]+)['"]([^'"]+)['"]/g;

function specifiers(text: string): string[] {
  return [...text.matchAll(specifierPattern)].map((match) => match[1]!);
}

function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * sources 用到的 three.js 文件（相对 three 包根），连同它们
 * 自己相对引用的文件。说明符按 demo 的 importmap 解析：`three` → build/three.module.js，
 * `three/addons/…` 与 `three/examples/jsm/…` → examples/jsm/…，`/node_modules/three/…`
 * 原样取包内路径。至少带上 build/three.module.js。
 */
export function threeClosure(threeRoot: string, sources: Map<string, string>): string[] {
  const picked = new Set<string>();
  const queue: string[] = [];
  const add = (rel: string) => {
    rel = goClean(rel);
    if (rel === '.' || rel.startsWith('../') || picked.has(rel)) return;
    if (!isRegularFile(path.join(threeRoot, rel))) return;
    picked.add(rel);
    queue.push(rel);
  };
  const resolve = (spec: string, from: string) => {
    if (spec === 'three') add('build/three.module.js');
    else if (spec === 'three/webgpu') add('build/three.webgpu.js');
    else if (spec.startsWith('three/addons/')) add('examples/jsm/' + spec.slice('three/addons/'.length));
    else if (spec.startsWith('three/examples/jsm/')) add(spec.slice('three/'.length));
    else if (spec.startsWith('/node_modules/three/')) add(spec.slice('/node_modules/three/'.length));
    else if (from !== '' && (spec.startsWith('./') || spec.startsWith('../'))) add(goJoin(goDir(from), spec));
  };
  add('build/three.module.js');
  for (const text of sources.values()) {
    for (const spec of specifiers(text)) resolve(spec, '');
  }
  while (queue.length > 0) {
    const rel = queue.shift()!;
    const body = fs.readFileSync(path.join(threeRoot, rel), 'utf8');
    for (const spec of specifiers(body)) resolve(spec, rel);
  }
  return [...picked].sort(compareBytes);
}

/**
 * sources 引用到的 core/assets 文件（相对 assets 根）。
 *
 * 不能只认完整路径：demo 常把目录前缀放进变量再拼文件名（`PH + 'tea_set_01/…'`）。
 * 所以按名字认：一个模型目录（assets 下第二层的目录，如 polyhaven/tea_set_01）的
 * 目录名出现在源码里就整个带上；其余文件的文件名或去掉扩展名的名字出现就带上。
 * 各来源目录的 SOURCES.md（许可与出处）总是带上。
 */
export function referencedAssets(assetsRoot: string, sources: Map<string, string>): string[] {
  let text = '';
  for (const body of sources.values()) text += body + '\n';
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of sortedEntries(dir)) {
      const file = path.join(dir, entry.name);
      const childRel = rel === '' ? entry.name : rel + '/' + entry.name;
      if (entry.isDirectory()) {
        if (childRel.split('/').length - 1 === 1 && text.includes(entry.name)) addTree(file, childRel, out);
        else walk(file, childRel);
        continue;
      }
      const name = entry.name;
      const stem = name.slice(0, name.length - goExt(name).length);
      if (name === 'SOURCES.md' || text.includes(name) || (Buffer.byteLength(stem) >= 4 && text.includes(stem))) {
        if (entry.isFile()) out.push(childRel);
      }
    }
  };
  walk(assetsRoot, '');
  return out.sort(compareBytes);
}

/** 目录下全部普通文件加进 out。 */
function addTree(dir: string, rel: string, out: string[]): void {
  for (const entry of sortedEntries(dir)) {
    if (entry.isDirectory()) addTree(path.join(dir, entry.name), rel + '/' + entry.name, out);
    else if (entry.isFile() && entry.name !== '.DS_Store') out.push(rel + '/' + entry.name);
  }
}
