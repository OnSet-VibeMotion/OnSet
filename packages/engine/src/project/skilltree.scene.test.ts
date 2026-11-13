// 移植自 internal/project/skilltree_test.go 中依赖 scene 包（RegisteredSkills、ResolveSkill）的门禁。
// TODO(scene): enable when src/scene is ported
//
// 启用时：把下面的 `scene` 换成 `import * as scene from '../scene'`，去掉 describe.skip。
// 断言照 Go 版写好了，只差 scene 的 API（registeredSkills、SourceEmbedded、SourceUpstream、resolveSkill）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as assets from '../assets';
import { initialize } from './init';
import { RulesTemplate } from './rules';
import { builtinSources, skillTreeRoot } from './testsupport';

interface SkillDescriptor {
  name: string;
  source: string;
  requiredFiles: string[];
  promptSection: ((dir: string) => string) | null;
}

// scene 尚未移植：占位，describe.skip 下不会被调用。
const scene = {
  registeredSkills: [] as SkillDescriptor[],
  SourceEmbedded: 'embedded',
  SourceUpstream: 'upstream',
  resolveSkill(_tool: string, _sceneDir: string, _env: Record<string, string>, _desc: SkillDescriptor): string {
    throw new Error('scene 尚未移植');
  },
};

describe.skip('skill tree gates that need scene', () => {
  // 防静默失败的门：漏了 .agents 入口时整棵技能树从发行物里消失，resolveSkill 找不到技能时按设计
  // 不报错、只降级——一路静默到成片动效变差才可能被发现。这个测试让它在 CI 就炸。
  it('every registered skill is embedded', () => {
    const shared = assets.shared();
    for (const desc of scene.registeredSkills) {
      if (desc.source !== scene.SourceEmbedded) continue; // 上游技能由 am init 安装，不随二进制下发
      for (const required of desc.requiredFiles) {
        const file = `${skillTreeRoot}/${desc.name}/${required}`;
        expect(shared.exists(file), `内置技能树缺少 ${file}`).toBe(true);
      }
    }
  });

  // 把内置技能与下发给渲染工具的项目规则绑在一起。
  it('builtin skills are documented in project rules', () => {
    const rules = assets.shared().readText(RulesTemplate);
    for (const desc of scene.registeredSkills) {
      if (desc.source !== scene.SourceEmbedded) continue;
      expect(rules.includes(desc.name), `${RulesTemplate} 没有提到内置技能 ${desc.name}：新增内置技能必须同步这份下发规则`).toBe(true);
    }
    // 锁定文件的读取例外必须点名技能树路径，否则「只在本镜头目录内工作」会把它挡在外面。
    expect(rules.includes(skillTreeRoot), `${RulesTemplate} 没有点名 ${skillTreeRoot}，镜头锁定文件会挡掉技能读取`).toBe(true);
  });

  // 把下发与发现两端接起来：从一个真实深度的镜头目录出发，resolveSkill 必须命中项目级技能树。
  it('delivered skill tree is discoverable from scene directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-project-'));
    try {
      const target = path.join(tmp, 'video');
      initialize(target, ...builtinSources());
      const sceneDir = path.join(target, 'scenes', 'scene-001');
      fs.mkdirSync(sceneDir, { recursive: true });
      // HOME 指向一个没装任何技能的空目录，确保命中的是项目级而非家目录级。
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'am-project-home-'));
      const environ = { HOME: home };
      for (const desc of scene.registeredSkills) {
        if (desc.source !== scene.SourceEmbedded) continue;
        const dir = scene.resolveSkill('claude', sceneDir, environ, desc);
        expect(dir, desc.name).toBe(path.join(target, ...skillTreeRoot.split('/')));
      }
      fs.rmSync(home, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // 上一条的反面门禁：上游技能只能由 am init 安装，不得进 assets/。
  it('upstream skills are not vendored into the embedded tree', () => {
    const shared = assets.shared();
    let checked = 0;
    for (const desc of scene.registeredSkills) {
      if (desc.source !== scene.SourceUpstream) continue;
      checked++;
      const file = `${skillTreeRoot}/${desc.name}`;
      expect(shared.exists(file), `上游技能 ${desc.name} 被拷进了嵌入树（${file}）：它不参与升级流程，会与上游悄悄分叉`).toBe(false);
    }
    expect(checked, '没有任何上游来源的注册技能，这条门禁形同虚设').toBeGreaterThan(0);
  });

  // 注册了却不注入提示词等于没注册——技能装进项目，渲染器却不知道它存在。
  it('every skill has a prompt section', () => {
    for (const desc of scene.registeredSkills) {
      expect(desc.promptSection, `技能 ${desc.name} 缺少 PromptSection`).not.toBeNull();
      const resolved = desc.promptSection!('/tmp/skills');
      expect(resolved.includes(desc.name), `技能 ${desc.name} 的提示词片段没有点名自己：${resolved}`).toBe(true);
      // 解析不到目录时必须退回按名字引用，不能写死本机路径或直接空掉。
      const fallback = desc.promptSection!('');
      expect(fallback.trim(), `技能 ${desc.name} 在未解析到目录时产出空片段`).not.toBe('');
      expect(fallback.includes('/tmp/skills'), `技能 ${desc.name} 的兜底片段里泄漏了路径`).toBe(false);
    }
  });
});
