// 移植自 internal/scene/filmstyle_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as filmstyle from '../filmstyle';
import { fingerprint, resetDigestCache } from './record';
import { buildPrompt, load } from './scene';
import { FilmStyleEnterKey, FilmStyleExitKey, FilmStyleOwnKey, filmStyleSection, rendererAccess, resolveAllSkills, resolveFilmStyle } from './skills';
import { newTiming, zeroHandoff, type Handoff } from './timing';
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

  // 一个项目装几种风格时：不写 film_style 的镜头照旧用默认风格（提示词与指纹逐字不变），
  // 点名的镜头用自己那一种；给项目添一种风格不影响没用到它的镜头。
  it('lets a scene pick another installed style', () => {
    const root = tempDir();
    const sceneDir = writeScene(root, 'scene-001', '');
    const env = { HOME: tempDir() };
    const defaultDir = writeStyle(path.join(root, '.agents', 'skills', filmstyle.SkillName), 'alpha/ink');
    const before = load(sceneDir);
    const beforePrint = fingerprint(before, 'claude', resolveAllSkills('claude', sceneDir, env, before));

    const extra = writeStyle(filmstyle.extraDir(root, 'beta/oil'), 'beta/oil');
    resetDigestCache();
    const after = fingerprint(before, 'claude', resolveAllSkills('claude', sceneDir, env, before));
    expect(after.fingerprint, '给项目添一种风格不该让用默认风格的镜头变 Stale').toBe(beforePrint.fingerprint);

    const picked = load(writeScene(root, 'scene-002', 'beta/oil'));
    const resolved = resolveAllSkills('claude', picked.directory, env, picked);
    expect(resolved[FilmStyleOwnKey]).toBe(extra);
    expect(resolved[filmstyle.SkillName], '点名别的风格时不该再带默认风格段').toBeUndefined();
    const prompt = buildPrompt(picked, resolved);
    expect(prompt).toContain('本镜头画成下面这种风格');
    expect(prompt).toContain(extra);
    expect(prompt).not.toContain(defaultDir);
    expect(containsString(rendererAccess(resolved).readDirs, extra), '安全模式应当放行读取点名的风格').toBe(true);
    expect(fingerprint(picked, 'claude', resolved).parts!['skill:' + FilmStyleOwnKey]).toBeTruthy();

    const none = load(writeScene(root, 'scene-003', 'none'));
    const nonePrompt = buildPrompt(none, resolveAllSkills('claude', none.directory, env, none));
    expect(nonePrompt).toContain('视觉自由度（强制）');
    expect(nonePrompt).not.toContain('整片风格（强制）');

    const missing = load(writeScene(root, 'scene-004', 'beta/watercolor'));
    expect(() => resolveAllSkills('claude', missing.directory, env, missing)).toThrow('film_style_add({"style": "beta/watercolor"})');
  });

  // 风格交界：两侧各拿到同一份约定、对方风格的路径，以及自己负责的那一段。
  it('tells each side of a style boundary what to do', () => {
    const root = tempDir();
    const env = { HOME: tempDir() };
    const ink = writeStyle(path.join(root, '.agents', 'skills', filmstyle.SkillName), 'alpha/ink');
    const oil = writeStyle(filmstyle.extraDir(root, 'beta/oil'), 'beta/oil');
    const handoff = (peer: string, peerStyle: string, shift: string): Handoff => ({
      ...zeroHandoff(),
      peer,
      device: 'carry',
      bridge: '一片树叶停在画面中央',
      style_shift: shift,
      peer_film_style: peerStyle,
    });

    const first = load(writeScene(root, 'scene-001', ''));
    first.timing = newTiming({ fps: 30, start_frame: 0, end_frame_exclusive: 30, plan: 'a'.repeat(64), exit: handoff('scene-002', 'beta/oil', 'morph') });
    const firstResolved = resolveAllSkills('claude', first.directory, env, first);
    expect(firstResolved[FilmStyleExitKey]).toBe(oil);
    const exitPrompt = buildPrompt(first, firstResolved);
    expect(exitPrompt).toContain('风格切换（强制');
    expect(exitPrompt).toContain('材质转化');
    expect(exitPrompt).toContain(oil);
    expect(exitPrompt, '出场一侧只负责把交界帧画对').toContain('不要提前换画法');
    expect(exitPrompt).toContain('不得用整画面叠化');

    const second = load(writeScene(root, 'scene-002', 'beta/oil'));
    second.timing = newTiming({ fps: 30, start_frame: 30, end_frame_exclusive: 60, plan: 'a'.repeat(64), enter: handoff('scene-001', '', 'morph') });
    const secondResolved = resolveAllSkills('claude', second.directory, env, second);
    expect(secondResolved[FilmStyleEnterKey], '上一镜头不写 film_style，就是默认风格').toBe(ink);
    const enterPrompt = buildPrompt(second, secondResolved);
    expect(enterPrompt, '入场一侧负责换画法').toContain('第 0 帧按上一镜头的风格画交接物件');
    expect(enterPrompt).toContain(ink);
    expect(containsString(rendererAccess(secondResolved).readDirs, ink), '要按对方风格画，就要能读它').toBe(true);

    // 对方镜头不用整片风格：没有路径，以交界帧为准。
    second.timing.enter = handoff('scene-001', 'none', 'morph');
    const fromNone = buildPrompt(second, resolveAllSkills('claude', second.directory, env, second));
    expect(fromNone).toContain('上一镜头的风格：没有整片风格');

    // 两侧解析到同一种风格（比如默认风格后来换成了 beta/oil）：不出风格切换段。
    second.timing.enter = handoff('scene-001', 'beta/oil', 'morph');
    expect(buildPrompt(second, resolveAllSkills('claude', second.directory, env, second))).not.toContain('风格切换（强制');
  });
});

function writeScene(root: string, id: string, filmStyle: string): string {
  const dir = path.join(root, 'scenes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\ntest\n');
  const scene: Record<string, unknown> = { id, duration_seconds: 1, output: 'out.mp4', transcript: 'transcript.srt', text: 'hello' };
  if (filmStyle !== '') scene.film_style = filmStyle;
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(scene));
  return dir;
}

/** 按整片风格契约写一份风格目录（STYLE.md、SKILL.md、来源记录）。 */
function writeStyle(dir: string, key: string): string {
  const [source, slug] = key.split('/');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filmstyle.StyleFile), '# ' + key + '\n');
  fs.writeFileSync(path.join(dir, filmstyle.GuideFile), '# guide\n');
  fs.writeFileSync(path.join(dir, filmstyle.ManifestFile), JSON.stringify({ source, slug, cn: slug, en: slug, version: 'v1', digest: 'x', installed_at: '' }));
  return dir;
}
