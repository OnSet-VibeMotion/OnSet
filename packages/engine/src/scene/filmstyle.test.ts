// 移植自 internal/scene/filmstyle_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as filmstyle from '../filmstyle';
import { fingerprint, resetDigestCache } from './record';
import { buildPrompt, load } from './scene';
import { filmStyleSection, rendererAccess, resolveAllSkills, resolveFilmStyle } from './skills';
import { containsString, tempDir } from './testsupport';

describe('film style', () => {
  // 整片风格只从项目里找：装在项目根的 .agents/skills 下就能被镜头目录发现，
  // 进 resolved（指纹、安全模式读取），提示词把「视觉自由度」换成「整片风格」。
  it('replaces visual freedom', () => {
    const root = tempDir();
    const sceneDir = path.join(root, 'scenes', 'scene-001');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\ntest\n');
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
    const s = load(sceneDir);
    const env = { HOME: tempDir() };

    const plainSkills = resolveAllSkills('claude', sceneDir, env);
    expect(Object.hasOwn(plainSkills, filmstyle.SkillName), '没装整片风格时不该解析到它').toBe(false);
    const plain = buildPrompt(s, plainSkills);
    expect(plain.includes('视觉自由度（强制）') && !plain.includes('整片风格（强制）'), '没装整片风格时应当保持视觉自由度，提示词不变').toBe(true);
    const base = fingerprint(s, 'claude', plainSkills);

    // 家目录里的一份不算：整片风格是一个项目的选择。
    const homeSkill = path.join(env.HOME, '.agents', 'skills', filmstyle.SkillName);
    fs.mkdirSync(homeSkill, { recursive: true });
    fs.writeFileSync(path.join(homeSkill, 'SKILL.md'), 'x');
    fs.writeFileSync(path.join(homeSkill, 'STYLE.md'), 'x');
    expect(resolveAllSkills('claude', sceneDir, env)[filmstyle.SkillName] ?? '', '不该从家目录解析整片风格').toBe('');

    const skill = path.join(root, '.agents', 'skills', filmstyle.SkillName);
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '# skill\n');
    fs.writeFileSync(path.join(skill, 'STYLE.md'), '# style v1\n');
    const resolved = resolveAllSkills('claude', sceneDir, env);
    expect(resolved[filmstyle.SkillName], '应当解析到项目里的整片风格').toBe(path.join(root, '.agents', 'skills'));
    const prompt = buildPrompt(s, resolved);
    for (const want of ['整片风格（强制）', skill, 'STYLE.md', 'SKILL.md', '不照搬风格自带的示例', '无音轨']) {
      expect(prompt, `整片风格段缺少 ${want}`).toContain(want);
    }
    expect(prompt, '装了整片风格后不该再让镜头自主定视觉').not.toContain('本镜头的配色、字体、版式、材质与动效由你根据文案和素材自主决定');
    expect(containsString(rendererAccess(resolved).readDirs, path.join(root, '.agents', 'skills')), '安全模式应当放行读取整片风格目录').toBe(true);
    const withStyle = fingerprint(s, 'claude', resolved);
    expect(withStyle.fingerprint, '装整片风格应当改变指纹').not.toBe(base.fingerprint);
    expect(withStyle.parts!['skill:' + filmstyle.SkillName], '整片风格应当单列一项').toBeTruthy();
    fs.writeFileSync(path.join(skill, 'STYLE.md'), '# style v2\n');
    resetDigestCache();
    const changed = fingerprint(s, 'claude', resolved);
    expect(changed.parts!['skill:' + filmstyle.SkillName], 'STYLE.md 变了，整片风格那一项应当跟着变').not.toBe(withStyle.parts!['skill:' + filmstyle.SkillName]);
  });

  // 只有一个来源时装出的旧目录（lemo-film-style）照样认，提示词指向它。
  it('resolves the legacy directory', () => {
    const root = tempDir();
    const sceneDir = path.join(root, 'scenes', 'scene-001');
    fs.mkdirSync(sceneDir, { recursive: true });
    const legacy = path.join(root, '.agents', 'skills', filmstyle.LegacySkillName);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'x');
    fs.writeFileSync(path.join(legacy, 'STYLE.md'), 'x');
    const skills = resolveFilmStyle(sceneDir);
    expect(skills, '应当认得旧目录').toBe(path.join(root, '.agents', 'skills'));
    expect(filmStyleSection(skills, false), '提示词应当指向旧目录').toContain(legacy);
  });
});
