// 移植自 internal/project/scenekit_test.go。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as assets from '../assets';
import { problems, scan } from '../determinism';
import { skillTreeRoot } from './testsupport';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** exampleFontFiles 读出示例 @font-face 引用的 assets/fonts/ 下的文件名。 */
function exampleFontFiles(shared: assets.AssetTree, file: string): string[] {
  const body = shared.readText(file);
  return [...body.matchAll(/assets\/fonts\/([\w.-]+\.woff2)/g)].map((m) => m[1]);
}

describe('scene-kit', () => {
  // 把 scene-kit 放进一个照技能说明搭起来的镜头目录，跑一遍 am 自己的确定性源码扫描。
  //
  // 技能要求渲染器把 scene-kit.js 复制进每个镜头目录，所以它会被每个镜头的
  // 扫描读到。库里一旦混进时钟、未播种随机数或定时器，所有用它的镜头都会被
  // 判失败——必须在这里先炸，而不是在用户的渲染里。example.html 是 SKILL.md
  // 指定的写法参考，照着抄的镜头也必须能过同一道门。
  it('passes determinism scan', () => {
    const shared = assets.shared();
    const skill = `${skillTreeRoot}/scene-kit/`;
    const sceneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-project-'));
    temps.push(sceneDir);
    const copies: Record<string, string> = {
      [skill + 'scene-kit.js']: 'scene-kit.js',
      [skill + 'example.html']: 'index.html',
    };
    for (const [from, to] of Object.entries(copies)) fs.writeFileSync(path.join(sceneDir, to), shared.readFile(from));
    // 示例引用的字体按技能说明随镜头目录提供；缺了它，扫描会如实报字体文件缺失。
    const fonts = path.join(sceneDir, 'assets', 'fonts');
    fs.mkdirSync(fonts, { recursive: true });
    for (const name of exampleFontFiles(shared, skill + 'example.html')) fs.writeFileSync(path.join(fonts, name), 'woff2');
    // am-scene.js 由 am 在渲染前生成，这里只放一个占位，让引用能解析到本地文件。
    fs.writeFileSync(path.join(sceneDir, 'am-scene.js'), 'window.AM_SCENE = {schema: 1};\n');

    const report = scan(sceneDir);
    expect(report.ok, `scene-kit 没通过确定性扫描：\n${problems(report).join('\n')}`).toBe(true);
    expect(
      report.files.includes('scene-kit.js'),
      `扫描没有读到 scene-kit.js（可能被当成第三方库跳过）：files=${report.files} skipped=${report.skipped ?? []}`,
    ).toBe(true);
    expect(report.allowed ?? [], 'scene-kit 不应依赖逐行豁免').toEqual([]);
  });
});
