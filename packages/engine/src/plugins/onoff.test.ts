/**
 * 逐个内置插件：项目关掉它，它登记的东西都不在（操作、渲染技能、镜头提示词里那一段、路线上的站）；打开时都在。
 * 正在用（歌曲讲解的 song.yaml、多角色对话的 cast.yaml）时不许关。工具列表那一侧见 cli 的 toolsmcp.test.ts。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as flow from '../flow';
import * as plugin from '../plugin';
import * as scene from '../scene';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 一个项目：内置技能都装在 .agents/skills，一个最普通的镜头。 */
function project(): { root: string; dir: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-onoff-')));
  temps.push(root);
  for (const desc of scene.allSkills()) {
    const skill = path.join(root, '.agents', 'skills', desc.name);
    for (const file of desc.requiredFiles) {
      fs.mkdirSync(path.dirname(path.join(skill, file)), { recursive: true });
      fs.writeFileSync(path.join(skill, file), 'x');
    }
  }
  const dir = path.join(root, 'scenes', 'scene-001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify({ id: 'scene-001', duration_seconds: 1, output: 'out.mp4', transcript: 'voice.srt', text: 'hello' }));
  return { root, dir };
}

const owned = <T>(list: plugin.Owned<T>[], id: string) => list.filter((x) => x.owner === id).map((x) => x.value);

/** 每个插件在镜头提示词里那一段的标志（song-explainer 只在歌曲镜头里出现，没有通用的段）。 */
const promptMarks: Record<string, string> = {
  cast: '角色驱动（按需）',
  'algorithmic-art': '生成式艺术参考',
  'text-to-lottie': 'Lottie 图层（可选）',
};

describe('each builtin plugin', () => {
  for (const id of ['song', 'cast', 'algorithmic-art', 'text-to-lottie', 'publishing']) {
    it(`${id}: everything it registered goes away when the project turns it off`, () => {
      const { root, dir } = project();
      const ops = owned(plugin.pluginOps(), id).map((o) => o.name);
      const skills = owned(plugin.pluginSkills(), id).map((d) => d.name);
      const nodes = owned(plugin.pluginStations(), id).flatMap((s) => s.nodes.map((n) => n.id));
      const s = scene.load(dir);

      // 打开：操作在、技能解析得到、提示词里有它那一段、路线上有它的站点。
      const on = scene.resolveAllSkills('claude', dir, {}, s);
      for (const name of skills) expect(on[name], name).toBe(path.join(root, '.agents', 'skills'));
      expect([...flow.disabledPluginOps(root)].filter((n) => ops.includes(n))).toEqual([]);
      const onPrompt = scene.buildPrompt(s, on);
      if (promptMarks[id]) expect(onPrompt).toContain(promptMarks[id]);
      const onRoute = flow.route('speech', flow.projectExtras(root)).map((r) => r.node.id);
      for (const n of nodes) expect(onRoute).toContain(n);

      flow.setBuiltinEnabled(root, id, false);
      const off = scene.resolveAllSkills('claude', dir, {}, s);
      for (const name of skills) expect(off[name], name).toBeUndefined();
      expect(Object.keys(off).filter((k) => k.startsWith('off:'))).toEqual([]);
      for (const name of ops) expect(flow.disabledPluginOps(root).has(name), name).toBe(true);
      if (promptMarks[id]) expect(scene.buildPrompt(s, off)).not.toContain(promptMarks[id]);
      const offRoute = flow.route('speech', flow.projectExtras(root)).map((r) => r.node.id);
      for (const n of nodes) expect(offRoute).not.toContain(n);

      flow.setBuiltinEnabled(root, id, true);
      expect(scene.buildPrompt(s, scene.resolveAllSkills('claude', dir, {}, s))).toBe(onPrompt);
    });
  }

  it('registers what the plugin is about', () => {
    expect(owned(plugin.pluginOps(), 'song').map((o) => o.name).sort()).toEqual([
      'song_configure',
      'song_cues',
      'song_doctor',
      'song_generate',
      'song_handoff',
      'song_import',
      'song_init',
      'song_mux',
      'song_prepare',
      'song_providers',
      'song_receive',
      'song_select',
      'validate_song',
    ]);
    expect(owned(plugin.pluginOps(), 'cast').map((o) => o.name).sort()).toEqual(['cast_add', 'cast_new', 'cast_preview', 'cast_validate', 'dialogue_assemble', 'dialogue_beats', 'validate_cast']);
    expect(owned(plugin.pluginSkills(), 'song').map((d) => d.name)).toEqual(['song-explainer']);
    expect(owned(plugin.pluginSkills(), 'cast').map((d) => d.name)).toEqual(['character-rig']);
    expect(owned(plugin.pluginSkills(), 'algorithmic-art').map((d) => d.name)).toEqual(['algorithmic-art']);
    expect(owned(plugin.pluginSkills(), 'text-to-lottie').map((d) => d.name)).toEqual(['text-to-lottie']);
    expect(owned(plugin.pluginSceneBlocks(), 'song').map((b) => b.key)).toEqual(['song']);
    expect(owned(plugin.pluginSceneBlocks(), 'cast').map((b) => b.key)).toEqual(['cast']);
    // 宿主自己的技能表里没有任何一个插件的技能。
    expect(scene.registeredSkills.map((d) => d.name)).toEqual(['hyperframes', 'hyperframes-cli', 'scene-kit']);
  });

  it('cannot be turned off while the project uses it', () => {
    const { root } = project();
    fs.writeFileSync(path.join(root, 'song.yaml'), 'provider: none\n');
    expect(() => flow.setBuiltinEnabled(root, 'song', false)).toThrow('正在用「歌曲讲解」（有 song.yaml）');
    fs.writeFileSync(path.join(root, 'cast.yaml'), 'schema: cast/v1\npacks: []\n');
    expect(() => flow.setBuiltinEnabled(root, 'cast', false)).toThrow('正在用「多角色对话」（有 cast.yaml）');
    expect(() => flow.setBuiltinEnabled(root, 'algorithmic-art', false)).not.toThrow();
  });
});
