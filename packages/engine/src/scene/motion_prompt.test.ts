import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as flow from '../flow';
import { marshal } from '../gojson';
import {
  buildPrompt,
  fingerprint,
  load,
  MaxSceneMotionEffects,
  motionEffectsSection,
  newScene,
  parseMotionEffectsInput,
  parseTimingPlan,
  pluginSkillSection,
  resolveAllSkills,
  sceneToJSON,
  verifySceneMotionEffects,
} from './index';
import { frameWithCanvas, tempDir, testPlanSHA, writeScene } from './testsupport';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTemp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

describe('compactMotionMenu', () => {
  it('groups ~30-36 curated effects dynamically verified against catalog.json', () => {
    const menu = flow.compactMotionMenu();
    for (const heading of ['文字与数据', '图形与组件入场/强调', '空间与运镜', '画内转场']) {
      expect(menu).toContain(`**${heading}**`);
    }
    expect(menu).toContain('其余内置与插件动效可用 `motion_effect_list()` 检索');
    expect(menu).not.toContain('{{');
    const catalogIds = new Set(flow.bundledMotionCatalog().effects.map((e) => e.id));
    const mentioned = [...menu.matchAll(/\b(\d{3})\b/g)].map((m) => m[1]);
    expect(mentioned.length).toBeGreaterThanOrEqual(30);
    expect(mentioned.length).toBeLessThanOrEqual(36);
    for (const id of mentioned) expect(catalogIds.has(id), `catalog missing ${id}`).toBe(true);
    expect(menu.length).toBeLessThan(650);
  });
});

describe('PlanEntry & Scene motion_effects serialization and backward compatibility', () => {
  it('normalizes shorthand, deduplicates preserving order, and rejects illegal types in TimingPlan', () => {
    const legacy = parseTimingPlan(
      JSON.stringify({ schema: 1, scenes: [{ id: 'scene-001', dir: 'scenes/scene-001' }] }),
    );
    expect(legacy.scenes![0].motion_effects).toEqual([]);

    const plan = parseTimingPlan(
      JSON.stringify({
        schema: 1,
        scenes: [
          {
            id: 'scene-001',
            dir: 'scenes/scene-001',
            motion_effects: ['005', 'motion-prompt:005', '007', 'custom-pack:spark'],
          },
        ],
      }),
    );
    expect(plan.scenes![0].motion_effects).toEqual(['motion-prompt:005', 'motion-prompt:007', 'custom-pack:spark']);

    expect(() =>
      parseTimingPlan(
        JSON.stringify({ schema: 1, scenes: [{ id: 'scene-001', dir: 'scenes/scene-001', motion_effects: '005' }] }),
      ),
    ).toThrow();
    expect(() =>
      parseTimingPlan(
        JSON.stringify({ schema: 1, scenes: [{ id: 'scene-001', dir: 'scenes/scene-001', motion_effects: [5] }] }),
      ),
    ).toThrow();
    expect(() =>
      parseTimingPlan(
        JSON.stringify({
          schema: 1,
          scenes: [{ id: 'scene-001', dir: 'scenes/scene-001', motion_effects: ['bad ref!'] }],
        }),
      ),
    ).toThrow('格式不合法');
  });

  it('omits empty motion_effects in sceneToJSON and preserves legacy fingerprint byte-for-byte', () => {
    const legacyDir = writeScene(
      '{"id":"scene-001","duration_seconds":2,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}',
    );
    const s = load(legacyDir);
    expect(s.motion_effects).toEqual([]);
    expect(marshal(sceneToJSON(s))).not.toContain('motion_effects');
    expect(motionEffectsSection(s)).toBe('');

    const fp1 = fingerprint(s, 'claude', {});
    const withEmpty = newScene({ ...s, motion_effects: [] });
    const fp2 = fingerprint(withEmpty, 'claude', {});
    expect(fp2.fingerprint).toBe(fp1.fingerprint);
    expect(fp2.parts).toEqual(fp1.parts);
  });

  it('enforces max 3 motion effects per scene and catalog existence in verifySceneMotionEffects', () => {
    expect(parseMotionEffectsInput(undefined)).toEqual([]);
    expect(() => parseMotionEffectsInput('005')).toThrow('字符串数组');
    expect(() => parseMotionEffectsInput([123])).toThrow('必须是字符串');

    const hits = verifySceneMotionEffects(['005', '007', '005', '001']);
    expect(hits.map((h) => h.ref)).toEqual(['motion-prompt:005', 'motion-prompt:007', 'motion-prompt:001']);

    expect(() => verifySceneMotionEffects(['001', '002', '003', '004'])).toThrow(`最多 ${MaxSceneMotionEffects} 条`);
    expect(() => verifySceneMotionEffects(['motion-prompt:999'])).toThrow('找不到动效');
  });
});

describe('motionEffectsSection dynamic prompt injection & Prompt Cache invariance', () => {
  it('injects recipes only into the per-scene dynamic section while keeping v9 static prefix identical', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), '');
    flow.recordFlow(root, { id: 'speech', canvas: 'landscape-16x9', render_prompt: flow.RenderPromptVersion });
    fs.mkdirSync(path.join(root, 'scenes'));
    const mk = (id: string, extra: Record<string, unknown> = {}) => {
      const dir = path.join(root, 'scenes', id);
      fs.renameSync(
        writeScene(
          JSON.stringify({
            id,
            duration_seconds: 3,
            output: `${id}.mp4`,
            transcript: 'transcript.srt',
            text: `镜头 ${id} 文案`,
            timing: { fps: 30, start_frame: 0, end_frame_exclusive: 90, plan: testPlanSHA },
            ...extra,
          }),
        ),
        dir,
      );
      return load(dir);
    };

    const plain = mk('scene-001');
    const withMotion = mk('scene-002', { motion_effects: ['005', '007'] });
    const p1 = buildPrompt(plain, {});
    const p2 = buildPrompt(withMotion, {});

    const split1 = p1.indexOf('任务目标：\n');
    const split2 = p2.indexOf('任务目标：\n');
    expect(split1).toBeGreaterThan(1000);
    expect(split2).toBe(split1);
    // 跨镜共享静态前缀必须逐字节一致，零 Prompt Cache 损失。
    expect(p1.slice(0, split1)).toBe(p2.slice(0, split2));

    expect(p1).not.toContain('本镜头指定动效配方');
    const dynamic = p2.slice(split2);
    expect(dynamic).toContain('本镜头指定动效配方（强制参考）');
    expect(dynamic).toContain('遮罩显现');
    expect(dynamic).toContain('motion-prompt:005');
    expect(dynamic).toContain('数字递增');
    expect(dynamic).toContain('motion-prompt:007');
    expect(dynamic).toContain('SceneKit');
    expect(dynamic).toContain('scene_preview_check');
    expect(dynamic).toContain('不得退化为普通淡入');
  });
});

describe('resolveAllSkills plugin renderer_skill auto-linking', () => {
  it('automatically merges renderer_skill from matched third-party plugin motion_effects', () => {
    const stationsRoot = makeTemp('onset-motion-stations-');
    const pluginSrc = makeTemp('onset-motion-plugin-src-');
    fs.mkdirSync(path.join(pluginSrc, 'skills', 'spark-fx'), { recursive: true });
    fs.writeFileSync(path.join(pluginSrc, 'skills', 'spark-fx', 'SKILL.md'), '# Spark FX Skill\n');
    fs.writeFileSync(
      path.join(pluginSrc, 'onset-station.json'),
      JSON.stringify({
        id: 'spark-motion',
        name: 'Spark Motion',
        version: '1.0.0',
        renderer_skills: [{ name: 'spark-fx', dir: 'skills/spark-fx', summary: '火花粒子技能', scenes: 'opt-in' }],
        motion_effects: [
          {
            id: 'burst',
            name: '火花迸发',
            category: '粒子',
            summary: '中心点迸发金色火花颗粒',
            spec: ['Frame 0-12: emit 24 particles outward with snappyOut'],
            renderer_skill: 'spark-fx',
          },
        ],
      }),
    );

    const env = { ONSET_STATIONS_DIR: stationsRoot };
    flow.installStation(`link:${pluginSrc}`, env);

    const makeScene = (extra: Record<string, unknown> = {}) => {
      const dir = makeTemp('onset-motion-scene-');
      fs.writeFileSync(path.join(dir, 'frame.md'), frameWithCanvas(1080, 1440));
      fs.writeFileSync(path.join(dir, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
      fs.writeFileSync(
        path.join(dir, 'scene.json'),
        JSON.stringify({
          id: 'scene-001',
          duration_seconds: 1,
          output: 'out.mp4',
          transcript: 'voice.srt',
          text: 'hi',
          ...extra,
        }),
      );
      return load(dir);
    };

    const plain = makeScene();
    const plainResolved = resolveAllSkills('claude', plain.directory, env, plain);
    expect(plainResolved['plugin:spark-motion/spark-fx']).toBeUndefined();

    const withPluginMotion = makeScene({ motion_effects: ['spark-motion:burst'] });
    const resolved = resolveAllSkills('claude', withPluginMotion.directory, env, withPluginMotion);
    expect(resolved['plugin:spark-motion/spark-fx']).toBeTruthy();
    expect(pluginSkillSection(resolved)).toContain('spark-motion/spark-fx');

    // 显式同时写了 plugin_skills 时去重不报错。
    const dedup = makeScene({
      plugin_skills: ['spark-motion/spark-fx'],
      motion_effects: ['spark-motion:burst'],
    });
    expect(resolveAllSkills('claude', dedup.directory, env, dedup)['plugin:spark-motion/spark-fx']).toBeTruthy();

    // 动效配方展开、buildPrompt 与 fingerprint 均使用调用方环境解析第三方插件动效。
    const section = motionEffectsSection(withPluginMotion, env);
    expect(section).toContain('火花迸发');
    expect(section).toContain('spark-motion:burst');
    expect(section).toContain('emit 24 particles');
    expect(buildPrompt(withPluginMotion, resolved, false, env)).toContain('火花迸发');
    expect(fingerprint(withPluginMotion, 'claude', resolved, undefined, env).fingerprint).toBeTruthy();
  });
});
