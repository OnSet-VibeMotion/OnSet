import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QoderSkillsStage, stageRendererSkills, unstageRendererSkills } from './skills';

function project(): { skills: string; style: string; scene: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-stage-')));
  const skills = path.join(root, '.agents', 'skills');
  const style = path.join(root, '.agents', 'onset-film-styles', 'lemo-opuscar', 'blueprint');
  for (const dir of [path.join(skills, 'hyperframes'), path.join(skills, 'scene-kit'), path.join(skills, 'song-explainer'), style]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: x\n---\n');
  }
  const scene = path.join(root, 'scenes', 'scene-001');
  fs.mkdirSync(scene, { recursive: true });
  return { skills, style, scene };
}

// qoder 渲染器用自己的 Skill 工具加载镜头的技能：只链提示词里点名的，渲染完删干净。
describe('qoder renderer skills', () => {
  it('links exactly the skills the prompt names, and removes them afterwards', () => {
    const { skills, style, scene } = project();
    const resolved = { hyperframes: skills, 'scene-kit': skills, 'song-explainer': skills, 'film-style:own': style };
    const prompt = `读 ${skills}/hyperframes/SKILL.md、${skills}/scene-kit/SKILL.md，风格见 ${style}/STYLE.md`;
    const unstage = stageRendererSkills('qoder', scene, resolved, prompt);
    const stage = path.join(scene, QoderSkillsStage);
    const names = fs.readdirSync(stage).filter((n) => !n.startsWith('.')).sort();
    // 提示词没点名的 song-explainer 不链；整片风格的键换成文件名能用的写法。
    expect(names).toEqual(['film-style-own', 'hyperframes', 'scene-kit']);
    expect(fs.realpathSync(path.join(stage, 'hyperframes'))).toBe(path.join(skills, 'hyperframes'));
    expect(fs.realpathSync(path.join(stage, 'film-style-own'))).toBe(style);
    unstage();
    expect(fs.existsSync(path.join(scene, '.qoder'))).toBe(false);
    // 真的技能文件都还在。
    expect(fs.existsSync(path.join(skills, 'hyperframes', 'SKILL.md'))).toBe(true);
  });

  // 每家放在自己读项目技能的位置；换了渲染工具，上次那家的链接下次也清掉。
  it('stages into each renderer\'s own skill folder', () => {
    const { skills, scene } = project();
    const prompt = `${skills}/hyperframes`;
    for (const [tool, rel] of [['claude', '.claude/skills'], ['codex', '.codex/skills'], ['codebuddy', '.codebuddy/skills'], ['opencode', '.opencode/skills']] as const) {
      const unstage = stageRendererSkills(tool, scene, { hyperframes: skills }, prompt);
      expect(fs.lstatSync(path.join(scene, rel, 'hyperframes')).isSymbolicLink(), tool).toBe(true);
      unstage();
      expect(fs.existsSync(path.join(scene, rel.split('/')[0])), tool).toBe(false);
    }
    stageRendererSkills('claude', scene, { hyperframes: skills }, prompt);
    unstageRendererSkills(scene);
    expect(fs.existsSync(path.join(scene, '.claude'))).toBe(false);
    stageRendererSkills('director', scene, { hyperframes: skills }, prompt);
    expect(fs.readdirSync(scene)).toEqual([]);
  });

  it('leaves the user’s own .qoder files alone and clears leftovers from an interrupted render', () => {
    const { skills, scene } = project();
    const stage = path.join(scene, QoderSkillsStage);
    fs.mkdirSync(path.join(stage, 'mine'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'scene-kit'), { recursive: true });
    stageRendererSkills('qoder', scene, { hyperframes: skills, 'scene-kit': skills }, `${skills}/hyperframes ${skills}/scene-kit`);
    // 用户自己的同名目录不动，不换成链接。
    expect(fs.lstatSync(path.join(stage, 'scene-kit')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(stage, 'hyperframes')).isSymbolicLink()).toBe(true);
    // 渲染被打断没来得及删：下次解析技能前清掉，用户的目录照旧。
    unstageRendererSkills(scene);
    expect(fs.readdirSync(stage).sort()).toEqual(['mine', 'scene-kit']);
  });
});
