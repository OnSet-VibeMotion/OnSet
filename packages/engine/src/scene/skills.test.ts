// 移植自 internal/scene/skills_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrompt, load } from './scene';
import {
  hyperFramesCLIPrompt,
  hyperFramesCommand,
  hyperFramesFormatFile,
  hyperFramesMotionFile,
  hyperFramesPrompt,
  HyperFramesSkillName,
  HyperFramesCLISkillName,
  CharacterRigSkillName,
  registeredSkills,
  rendererAccess,
  resolveAllSkills,
  resolveSkill,
  sceneKitLibraryFile,
  sceneKitPrompt,
  SkillsDirEnv,
  skillsEnvironment,
  SongExplainerSkillName,
  SourceUpstream,
  textToLottiePrompt,
  type SkillDescriptor,
} from './skills';
import { SceneDataFile } from './scenedata';
import { containsString, tempDir, writeScene } from './testsupport';

/** 入口技能的注册项。 */
function hyperFramesDescriptor(): SkillDescriptor {
  const desc = registeredSkills.find((d) => d.name === HyperFramesSkillName);
  if (!desc) throw new Error('入口技能不在注册表里');
  return desc;
}

/** 在 dir 下伪造一份任意技能的最小完整安装。 */
function installNamedSkill(dir: string, desc: SkillDescriptor): string {
  const skill = path.join(dir, desc.name);
  fs.mkdirSync(skill, { recursive: true });
  for (const name of desc.requiredFiles) {
    fs.mkdirSync(path.dirname(path.join(skill, name)), { recursive: true });
    fs.writeFileSync(path.join(skill, name), 'x');
  }
  return dir;
}

/** 在 dir 下伪造一份完整的 hyperframes 入口技能安装。 */
function installSkill(dir: string): string {
  return installNamedSkill(dir, hyperFramesDescriptor());
}

/**
 * 这组测试的入口：测的是 resolveSkill 的目录解析逻辑，用入口技能作为样本——它是唯一要求
 * SKILL.md 之外还有子目录文件（references/*.md）的技能，覆盖面最广。
 */
function resolveAnimationSkill(renderer: string, sceneDir: string, environ: Record<string, string>): string {
  return resolveSkill(renderer, sceneDir, environ, hyperFramesDescriptor());
}

describe('resolveSkill', () => {
  it('prefers the explicit environment', () => {
    const home = tempDir();
    installSkill(path.join(home, '.claude', 'skills'));
    const explicit = installSkill(path.join(tempDir(), 'custom'));
    expect(resolveAnimationSkill('claude', tempDir(), { HOME: home, [SkillsDirEnv]: explicit })).toBe(explicit);
  });

  it('rejects an invalid explicit environment', () => {
    const home = tempDir();
    installSkill(path.join(home, '.claude', 'skills'));
    // 显式配置错了必须报错，而不是悄悄回退到家目录里那份能用的安装。
    expect(() => resolveAnimationSkill('claude', tempDir(), { HOME: home, [SkillsDirEnv]: tempDir() })).toThrow(SkillsDirEnv);
  });

  it('finds the project scope by walking up', () => {
    const root = tempDir();
    const project = installSkill(path.join(root, '.claude', 'skills'));
    const sceneDir = path.join(root, 'episodes', 'episode-03', 'scenes', 'scene-002');
    fs.mkdirSync(sceneDir, { recursive: true });
    expect(resolveAnimationSkill('claude', sceneDir, { HOME: tempDir() })).toBe(project);
  });

  it('project scope beats home scope', () => {
    const home = tempDir();
    installSkill(path.join(home, '.claude', 'skills'));
    const root = tempDir();
    const project = installSkill(path.join(root, '.claude', 'skills'));
    expect(resolveAnimationSkill('claude', root, { HOME: home })).toBe(project);
  });

  it('per-renderer home location', () => {
    const cases: Record<string, string> = {
      claude: '.claude/skills',
      codex: '.codex/skills',
      qoder: '.qoder/skills',
      codebuddy: '.codebuddy/skills',
      opencode: '.config/opencode/skills',
    };
    for (const [renderer, relative] of Object.entries(cases)) {
      const home = tempDir();
      const want = installSkill(path.join(home, relative));
      // 另一个渲染器的目录也存在，确保按 renderer 而不是按存在性挑。
      installSkill(path.join(home, '.cursor', 'skills'));
      expect(resolveAnimationSkill(renderer, tempDir(), { HOME: home }), renderer).toBe(want);
    }
  });

  it('falls back to the portable location', () => {
    const home = tempDir();
    const want = installSkill(path.join(home, '.agents', 'skills'));
    expect(resolveAnimationSkill('codex', tempDir(), { HOME: home })).toBe(want);
  });

  it('prefers the renderer dir when the project sits inside home', () => {
    // 项目根在 $HOME 之下，且家目录同时装了通用的 .agents/skills。
    // 向上遍历必须不能在 $HOME 那一层先命中通用目录。
    const home = tempDir();
    installSkill(path.join(home, '.agents', 'skills'));
    const want = installSkill(path.join(home, '.config', 'opencode', 'skills'));
    const sceneDir = path.join(home, 'work', 'video', 'episodes', 'scene-002');
    fs.mkdirSync(sceneDir, { recursive: true });
    expect(resolveAnimationSkill('opencode', sceneDir, { HOME: home })).toBe(want);
  });

  it('ignores an incomplete install', () => {
    const home = tempDir();
    // 只有 SKILL.md 没有 references/：提示词引用的文件不存在，必须当作未找到。
    const partial = path.join(home, '.claude', 'skills', HyperFramesSkillName);
    fs.mkdirSync(partial, { recursive: true });
    fs.writeFileSync(path.join(partial, 'SKILL.md'), 'x');
    expect(resolveAnimationSkill('claude', tempDir(), { HOME: home })).toBe('');
  });

  it('returns empty when absent', () => {
    expect(resolveAnimationSkill('claude', tempDir(), { HOME: tempDir() })).toBe('');
  });

  it('unknown renderer still uses the portable location', () => {
    const home = tempDir();
    const want = installSkill(path.join(home, '.agents', 'skills'));
    expect(resolveAnimationSkill('some-future-tool', tempDir(), { HOME: home })).toBe(want);
  });
});

describe('skillsEnvironment', () => {
  it('prefers the process env over dotenv', () => {
    const base = { HOME: '/home/a', [SkillsDirEnv]: '/from/shell' };
    const overlay = { [SkillsDirEnv]: '/from/dotenv' };
    expect(skillsEnvironment(base, overlay)[SkillsDirEnv]).toBe('/from/shell');
  });

  it('falls back to dotenv', () => {
    const base: Record<string, string> = { HOME: '/home/a' };
    const overlay = { [SkillsDirEnv]: '/from/dotenv' };
    const merged = skillsEnvironment(base, overlay);
    expect(merged[SkillsDirEnv]).toBe('/from/dotenv');
    expect(Object.hasOwn(base, SkillsDirEnv), 'skillsEnvironment must not mutate its input').toBe(false);
  });
});

describe('skill prompts', () => {
  it('embeds the resolved skill path', () => {
    const dir = writeScene('{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
    const s = load(dir);
    const skills = installSkill(path.join(tempDir(), 'skills'));
    const prompt = buildPrompt(s, { [HyperFramesSkillName]: skills });
    for (const want of [
      path.join(skills, HyperFramesSkillName),
      hyperFramesFormatFile,
      hyperFramesMotionFile,
      '动效要求（强制）',
      'decorative',
      // 数量配额会让渲染器为了达标堆砌与文案无关的动效，改为要求每个动效说得出理由。
      '说得出',
      // 实测出现过最后 3 秒画面完全冻结，整画面冻结的上限必须保留。
      '完全冻结超过 3 秒',
      // 与 frame.md 的 ambient_per_scene_max 一致，不得反过来强制贯穿全镜的环境动效。
      '最多 1 条',
    ]) {
      expect(prompt).toContain(want);
    }
  });

  it('falls back to the skill name without a path', () => {
    const dir = writeScene('{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
    const prompt = buildPrompt(load(dir), null);
    expect(prompt).toContain(HyperFramesSkillName);
    expect(prompt).toContain(hyperFramesFormatFile);
    expect(prompt, 'fallback prompt must not claim a machine-local path').not.toContain('本机该技能目录为');
  });

  // 注册表里加了技能却忘了写提示词片段时会失败——注册但不注入等于白装。
  it('every registered skill contributes a prompt section', () => {
    for (const desc of registeredSkills) {
      expect(desc.promptSection, `${desc.name} 没有 promptSection`).toBeTypeOf('function');
      expect(desc.requiredFiles.length, `${desc.name} 的 requiredFiles 为空：resolveSkill 会把任何目录都判为已安装`).toBeGreaterThan(0);
      // 未解析时必须按技能名引用，且不得凭空造出一条本机路径。
      const unresolved = desc.promptSection('');
      expect(unresolved, `${desc.name} 未解析时的片段没提到技能名`).toContain(desc.name);
      expect(unresolved, `${desc.name} 未解析时不得写出本机路径`).not.toContain(path.sep + desc.name);
      // 解析后必须把本机绝对路径写进去，否则渲染器还得自己找。
      const resolved = desc.promptSection('/tmp/skills');
      expect(resolved, `${desc.name} 解析后的片段没有注入本机路径`).toContain(path.join('/tmp/skills', desc.name));
    }
  });

  // 部分安装的情形：装了的进结果，没装的缺席而不是报错。
  it('resolveAllSkills reports only installed skills', () => {
    const home = tempDir();
    installNamedSkill(path.join(home, '.claude', 'skills'), registeredSkills[0]);
    const resolved = resolveAllSkills('claude', tempDir(), { HOME: home });
    expect(Object.keys(resolved), `只装了一个技能，却解析出 ${JSON.stringify(resolved)}`).toHaveLength(1);
    expect(Object.hasOwn(resolved, registeredSkills[0].name)).toBe(true);
  });

  // Lottie 与动效技能同时在提示词里，必须明确 Lottie 不顶替动效预算。
  it('text-to-lottie prompt keeps Lottie out of the motion budget', () => {
    for (const dir of ['', '/tmp/skills']) {
      const section = textToLottiePrompt(dir);
      for (const want of ['默认不用', '不计入', '环境动效']) expect(section, `skillsDir=${dir}`).toContain(want);
    }
  });

  it('buildPrompt injects every installed skill', () => {
    const home = tempDir();
    const skills = path.join(home, '.claude', 'skills');
    const resolved: Record<string, string> = {};
    for (const desc of registeredSkills) {
      installNamedSkill(skills, desc);
      resolved[desc.name] = skills;
    }
    const dir = writeScene('{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
    const prompt = buildPrompt(load(dir), resolved);
    for (const desc of registeredSkills) {
      if (desc.name === SongExplainerSkillName) {
        expect(prompt, 'speech prompt includes song skill').not.toContain(desc.name);
        continue;
      }
      expect(prompt, `提示词里没有 ${desc.name} 的本机路径`).toContain(path.join(skills, desc.name));
    }
  });

  // 降级：一个技能都没装时提示词仍然成立，只是按技能名引用。
  it('buildPrompt degrades to skill names when nothing is installed', () => {
    const dir = writeScene('{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
    const prompt = buildPrompt(load(dir), null);
    for (const desc of registeredSkills) {
      if (desc.name === SongExplainerSkillName) {
        expect(prompt, 'speech prompt includes song skill').not.toContain(desc.name);
        continue;
      }
      expect(prompt, `降级后提示词里没有 ${desc.name}`).toContain(desc.name);
    }
  });

  // 远端渲染与改动已装技能的命令只在我们自己写的提示词片段里禁，上游不会替我们守。
  it('CLI prompt forbids remote and skill-mutating commands', () => {
    for (const dir of ['', '/proj/.agents/skills']) {
      const section = hyperFramesCLIPrompt(dir);
      for (const forbidden of [
        'cloud',
        'lambda',
        'publish',
        'skills',
        'upgrade',
        // 0.8.185 起 CLI 技能把这些交互、桌面应用与遥测命令列进了标准流程。
        'preview',
        'open',
        'catch-up',
        'history',
        'feedback',
        'usage',
      ]) {
        expect(section, `skillsDir=${dir} 时，CLI 提示词没有点名禁止的命令 ${forbidden}`).toContain(forbidden);
      }
      expect(section, `skillsDir=${dir} 时，CLI 提示词没有要求本机渲染`).toContain('本机渲染');
    }
  });

  // 入口技能的收窄范围：这几条禁令只存在于我们的提示词里。
  it('hyperframes prompt narrows the entry skill to one scene', () => {
    for (const dir of ['', '/proj/.agents/skills']) {
      const section = hyperFramesPrompt(dir);
      for (const want of [
        'STORYBOARD',
        'SCRIPT',
        'SPEC.md',
        'REVIEW.md',
        '子项目',
        '一个 composition',
        'story.md',
        'sound.md',
        'captions.md',
        '<audio>',
        'frame.md',
        '视觉自由度',
        'Video facts',
        'frame-presets',
        'local()',
        '1920×1080',
        'catalog',
        'media-use',
      ]) {
        expect(section, `skillsDir=${dir} 时，入口技能提示词缺少 ${want}`).toContain(want);
      }
    }
  });

  // 解析不到目录时必须退回按技能名引用。
  it('upstream skill prompts degrade gracefully', () => {
    for (const desc of registeredSkills) {
      if (desc.source !== SourceUpstream) continue;
      const fallback = desc.promptSection('');
      expect(fallback, `${desc.name} 的兜底片段没有点名技能`).toContain(desc.name);
      expect(fallback.includes('/') && fallback.includes('skills/'), `${desc.name} 的兜底片段里写死了路径`).toBe(false);
    }
  });

  // am 不进渲染器的白名单（HyperFrames 经工具服务调用）；技能目录去重排序，argv 才稳定可比。
  it('renderer access keeps am out and opens skill dirs', () => {
    const access = rendererAccess({
      [HyperFramesSkillName]: '/proj/.agents/skills',
      [HyperFramesCLISkillName]: '/proj/.agents/skills',
      [CharacterRigSkillName]: '/home/.claude/skills',
    });
    expect(access.commands).toEqual(['ls', 'ffprobe']);
    expect(access.readDirs).toEqual(['/home/.claude/skills', '/proj/.agents/skills']);
  });

  // scene-kit 的措辞一旦退成「可以用」，渲染器照旧手写字幕与安全区像素，库就白装了。
  it('scene-kit prompt makes captions and layout mandatory', () => {
    for (const dir of ['', '/proj/.agents/skills']) {
      const section = sceneKitPrompt(dir);
      for (const want of ['强制', 'SceneKit.captions', 'SceneKit.safeRect', sceneKitLibraryFile, '复制进本镜头目录', '不得手写字幕代码', '先加载镜头目录里的 ' + SceneDataFile]) {
        expect(section, `skillsDir=${dir}`).toContain(want);
      }
    }
  });

  // 两条动效手艺要求：落定状态与跟随关系。
  it('animation prompt directs end states and follow relations', () => {
    const section = hyperFramesPrompt('');
    for (const want of ['状态变化', '最终停在什么状态', '论点', '跟随关系', '指针落在它要按的控件上', '标签跟着它标注的对象走']) {
      expect(section).toContain(want);
    }
  });

  // 渲染器只经 am 工具服务的 hyperframes 工具调用 CLI：提示词要教会工具写法、长任务怎么等，并且不再教 am / npx 的命令行。
  it('CLI prompt teaches the hyperframes tool instead of a command line', () => {
    expect(containsString(rendererAccess(null).commands, hyperFramesCommand())).toBe(false);
    for (const dir of ['', '/tmp/skills']) {
      const section = hyperFramesCLIPrompt(dir);
      for (const want of ['`hyperframes` 工具', '"subcommand": "render"', 'job_wait', '不在 Bash 里跑 hyperframes、npx hyperframes 或 am', '--describe false']) {
        expect(section, `skillsDir=${dir}`).toContain(want);
      }
      expect(section).not.toContain(hyperFramesCommand() + ' ');
    }
  });
});
