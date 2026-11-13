// 移植自 internal/project/skilltree_test.go 中不依赖 scene 包的门禁。
// 依赖 scene.RegisteredSkills / scene.ResolveSkill 的几条在 skilltree.scene.test.ts（scene 移植前跳过）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as assets from '../assets';
import { initialize } from './init';
import { builtinSources, skillManifest, skillTreeRoot } from './testsupport';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-project-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** forEachSkillFile 遍历内置技能树里的每个文本文件（路径相对共享树根，与 Go 的 fs.WalkDir 一致）。 */
function forEachSkillFile(check: (file: string, text: string) => void): void {
  const tree = assets.shared().sub(skillTreeRoot);
  const visited = tree.walkFiles();
  for (const rel of visited) check(`${skillTreeRoot}/${rel}`, tree.readText(rel));
  if (visited.length === 0) throw new Error('技能树里一个文件都没遍历到，检查 embed 指令');
}

describe('skill tree', () => {
  // 校验技能树真的落到用户项目根，路径与 scene.resolveSkill 的项目级约定一致——两边任何一侧改路径都会让这里失败。
  it('initialize delivers skill tree', () => {
    const target = path.join(tempDir(), 'video');
    initialize(target, ...builtinSources());
    for (const name of [
      `${skillTreeRoot}/text-to-lottie/${skillManifest}`,
      `${skillTreeRoot}/text-to-lottie/LICENSE`,
      `${skillTreeRoot}/text-to-lottie/references/lottie-spec-map.md`,
      `${skillTreeRoot}/algorithmic-art/${skillManifest}`,
      `${skillTreeRoot}/scene-kit/${skillManifest}`,
      `${skillTreeRoot}/scene-kit/scene-kit.js`,
    ]) {
      expect(fs.existsSync(path.join(target, ...name.split('/'))), `项目里缺少 ${name}`).toBe(true);
    }
  });

  // 与提示词那条同源：用户项目里没有 ./am，技能文件写了它就是一条死路径。
  //
  // 不检查 "agent" 一词——技能树的路径本身叫 .agents/skills，上游英文原文也合法地
  // 提到 Agent Skills，这条只对下发给操作者的 PROMPT 文件成立。
  it('does not reference repo-local binary', () => {
    const problems: string[] = [];
    forEachSkillFile((file, text) => {
      if (text.includes('./am')) problems.push(`${file} 引用了 ./am，用户项目里没有这个二进制`);
    });
    expect(problems).toEqual([]);
  });

  // 守着 fork 的裁剪结果。
  //
  // text-to-lottie 的上游把场景绑死在它自己那个 Vite + Skia Skottie 播放器项目上
  // （public/projects/ 布局、dev server、GET /__context）。本项目的镜头是
  // HyperFrames 组合，由 am scene run 无头渲染，那套契约整体不适用。日后同步上游
  // 时很容易把这些描述带回来，带回来渲染器就会去起 dev server 或写错路径。
  //
  // 只扫 references/：那是会被上游整份覆盖的部分。SKILL.md 与 ATTRIBUTION.md 是
  // 本项目自己写的，它们**需要**点名这套契约来说明为什么不用它。
  it('forked skill carries no upstream player contract', () => {
    const banned = ['Skottie', 'CanvasKit', 'canvaskit', 'public/projects', '__context', 'npm run dev', 'degit'];
    let scanned = 0;
    const problems: string[] = [];
    forEachSkillFile((file, text) => {
      if (!file.includes('/references/')) return;
      scanned++;
      for (const token of banned) {
        if (text.includes(token)) problems.push(`${file} 含上游播放器契约残留 "${token}"，见技能目录的 ATTRIBUTION.md`);
      }
    });
    expect(scanned, '没扫到任何 references/ 文件，检查技能树结构').toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  // 防止只放了 references/ 却漏掉 SKILL.md——那样 resolveSkill 会判定未安装并静默降级。
  it('every skill directory has a manifest', () => {
    const shared = assets.shared();
    const entries = shared.readDir(skillTreeRoot);
    expect(entries.length, '技能树是空的').toBeGreaterThan(0);
    for (const entry of entries) {
      if (!entry.isDir) continue;
      expect(shared.exists(`${skillTreeRoot}/${entry.name}/${skillManifest}`), `技能 ${entry.name} 缺少 ${skillManifest}`).toBe(true);
    }
  });
});
