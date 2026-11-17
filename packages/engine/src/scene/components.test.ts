import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../plugin';
import { VerificationError } from './verification';
import { componentSection, promoteComponent, verifyComponentNames } from './components';
import { fingerprint } from './record';
import { prepareResources, resourceFiles } from './resources';
import { buildPrompt, load } from './scene';
import { tempDir, writeScene } from './testsupport';

/** 项目根加两个镜头：one 做出组件，two 引用它。 */
function project(components = '') {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'onset.conf'), '');
  fs.mkdirSync(path.join(root, 'scenes'));
  const dirs: string[] = [];
  for (const id of ['one', 'two']) {
    const extra = id === 'two' && components !== '' ? `,"components":${components}` : '';
    const dir = path.join(root, 'scenes', id);
    fs.renameSync(writeScene(`{"id":"${id}","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"${extra}}`), dir);
    dirs.push(dir);
  }
  return { root, one: dirs[0]!, two: dirs[1]! };
}

function exportBadge(sceneDir: string, js = 'export function badge() {}') {
  const dir = path.join(sceneDir, 'export', 'cube-badge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# cube-badge\nimport { badge } from "./badge.js"\n');
  fs.writeFileSync(path.join(dir, 'badge.js'), js);
  return dir;
}

describe('shared components', () => {
  it('checks component names', () => {
    expect(() => verifyComponentNames(['cube-badge', 'chart2'])).not.toThrow();
    expect(() => verifyComponentNames(['Cube'])).toThrow('组件名');
    expect(() => verifyComponentNames(['../x'])).toThrow('组件名');
    expect(() => verifyComponentNames(['a', 'a'])).toThrow('重复');
    const f = project('["Bad"]');
    expect(() => load(f.two)).toThrow('组件名');
  });

  // 渲染器做出组件、onset 登记：只收镜头目录里的普通文件，要有说明与代码；内容不同要 replace。
  it('promotes what the renderer exported', () => {
    const f = project();
    expect(() => promoteComponent(f.root, f.one, 'cube-badge', '', false)).toThrow('组件目录要在镜头目录里');
    const dir = exportBadge(f.one);
    const first = promoteComponent(f.root, f.one, 'cube-badge', '', false);
    expect(first).toMatchObject({ dir: path.join('production', 'shared', 'cube-badge'), files: 2, replaced: false, unchanged: false });
    expect(fs.readFileSync(path.join(f.root, 'production/shared/cube-badge/badge.js'), 'utf8')).toBe('export function badge() {}');
    expect(promoteComponent(f.root, f.one, 'cube-badge', '', false).unchanged).toBe(true);
    fs.writeFileSync(path.join(dir, 'badge.js'), 'export function badge() { return 2 }');
    expect(() => promoteComponent(f.root, f.one, 'cube-badge', '', false)).toThrow('replace');
    expect(promoteComponent(f.root, f.one, 'cube-badge', '', true).replaced).toBe(true);
    expect(fs.readFileSync(path.join(f.root, 'production/shared/cube-badge/badge.js'), 'utf8')).toContain('return 2');
    expect(fs.readdirSync(path.join(f.root, 'production/shared'))).toEqual(['cube-badge']);

    fs.rmSync(path.join(dir, 'README.md'));
    expect(() => promoteComponent(f.root, f.one, 'cube-badge', '', true)).toThrow('README.md');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    fs.symlinkSync(f.two, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => promoteComponent(f.root, f.one, 'cube-badge', '', true)).toThrow('符号链接');
    expect(() => promoteComponent(f.root, f.one, 'cube-badge', '../two', true)).toThrow('组件目录要在镜头目录里');
  });

  // 引用组件的镜头：渲染前挂进 shared/<名字>/、提示词要求直接引用、组件内容进指纹；没登记就报错。不引用的镜头提示词不变。
  it('mounts components into the scenes that name them', () => {
    const f = project('["cube-badge"]');
    const two = load(f.two);
    expect(two.components).toEqual(['cube-badge']);
    expect(() => resourceFiles(two, {})).toThrow(VerificationError);
    const one = load(f.one);
    const before = buildPrompt(one, {});
    exportBadge(f.one);
    promoteComponent(f.root, f.one, 'cube-badge', '', false);
    expect(resourceFiles(two, {}).map((r) => r.path)).toEqual(expect.arrayContaining(['shared/cube-badge/README.md', 'shared/cube-badge/badge.js']));
    prepareResources(two, {});
    expect(fs.readFileSync(path.join(f.two, 'shared/cube-badge/badge.js'), 'utf8')).toBe('export function badge() {}');
    expect(buildPrompt(two, {})).toContain(componentSection(['cube-badge']));
    expect(buildPrompt(two, {})).toContain('不要自己重画');
    expect(buildPrompt(one, {})).toBe(before);
    expect(componentSection([])).toBe('');

    const parts = fingerprint(two, 'claude', {}).parts!;
    expect(parts['asset:shared/cube-badge/badge.js']).toBeDefined();
    exportBadge(f.one, 'export function badge() { return 3 }');
    promoteComponent(f.root, f.one, 'cube-badge', '', true);
    prepareResources(two, {});
    expect(fingerprint(two, 'claude', {}).parts!['asset:shared/cube-badge/badge.js'], '组件换了，引用它的镜头要变 Stale').not.toBe(parts['asset:shared/cube-badge/badge.js']);
  });
});


it.each(['production', 'production/shared', 'production/shared/cube-badge'])('rejects a linked promotion destination: %s', rel => {
  const f = project(), outside = tempDir();
  exportBadge(f.one);
  fs.mkdirSync(path.dirname(path.join(f.root, rel)), { recursive: true });
  fs.symlinkSync(outside, path.join(f.root, rel), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => promoteComponent(f.root, f.one, 'cube-badge', '', false)).toThrow('符号链接');
  expect(fs.readdirSync(outside)).toEqual([]);
});
