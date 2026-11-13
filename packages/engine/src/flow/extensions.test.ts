import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as filmstyle from '../filmstyle';
import { runPrompt } from '../project/runprompt';
import { resolveAllSkills, pluginSkillSection } from '../scene/skills';
import {
  addToProject,
  builtinStations,
  detectFlow,
  extraPrompt,
  fetchStation,
  composeFlowPrompt,
  recordFlow,
  loadProjectStations,
  parseManifest,
  pluginSkillsFor,
  projectExtras,
  removeFromProject,
  route,
  setProjectFlow,
  stageTitles,
  syncStyleSources,
} from './index';

const fake = path.join(__dirname, 'testdata', 'fake-publisher');
const templates = path.join(__dirname, '..', '..', '..', '..', 'assets', 'prompts');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  syncStyleSources('');
});

/** 一个加了假发布插件的口播项目（新建时记下流程与画幅）。 */
function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-ext-')));
  temps.push(root);
  recordFlow(root, { id: 'speech', canvas: 'vertical-3x4' });
  fs.writeFileSync(path.join(root, 'article-to-motion.conf'), '');
  addToProject(root, fetchStation(`link:${fake}`, process.env).entry);
  return root;
}

const base = () =>
  ({ id: 'my-step', version: '1', name: '我的一站', ops: [{ name: 'go', summary: 's', command: ['bin/x'] }] }) as Record<string, unknown>;

describe('manifest extensions', () => {
  it('reads every extension of the fake publisher', () => {
    const m = parseManifest(fs.readFileSync(path.join(fake, 'am-station.json'), 'utf8'));
    expect(m.provides.tts).toEqual({ name: '假配音', op: 'speak', timestamps: 'none' });
    expect(m.renderer_skills).toEqual([{ name: 'caption-kit', dir: 'skills/caption-kit', summary: '字幕卡片的写法', scenes: 'opt-in' }]);
    expect(m.film_styles).toEqual({ name: '假风格库', dir: 'styles' });
    expect(m.inserts).toEqual([{ stage: 'render', file: 'prompts/render.md' }]);
    expect(m.schedules).toEqual([{ every_minutes: 30, op: 'on_event' }]);
    expect(m.flow).toEqual({ name: '快剪', stations: ['intake', 'render', 'assemble', 'review', 'fake-publisher'], first_page: 'dashboard', prompt: 'prompts/flow.md' });
  });

  it('rejects bad extensions', () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ schedules: [{ every_minutes: 1, op: 'go' }] }, '5–1440'],
      [{ inserts: [{ stage: 'nope', file: 'a.md' }] }, 'inserts[0].stage'],
      [{ flow: { name: 'f', stations: ['nope'], first_page: 'script', prompt: 'f.md' } }, '没有站 nope'],
      [{ flow: { name: 'f', stations: ['render'], first_page: 'mars', prompt: 'f.md' } }, 'first_page'],
      [{ provides: { tts: { name: 't', op: 'nope' } } }, '没有操作 nope'],
      [{ provides: { tts: { name: 't', op: 'go', timestamps: 'phoneme' } } }, 'timestamps'],
      [{ renderer_skills: [{ name: 'k', dir: '../k', summary: 's' }] }, '站目录里的相对路径'],
      [{ renderer_skills: [{ name: 'k', dir: 'k', summary: 's', scenes: 'some' }] }, 'all 或 opt-in'],
      [{ film_styles: { name: 'n', dir: '/abs' } }, '站目录里的相对路径'],
    ];
    for (const [over, msg] of bad) expect(() => parseManifest(JSON.stringify({ ...base(), ...over })), msg).toThrow(msg);
  });

  it('keeps the stage titles in step with the templates', () => {
    for (const [stage, title] of Object.entries(stageTitles)) {
      const owner = builtinStations.find((st) => st.prompt.some((sec) => sec.stage === stage))!;
      const file = `${owner.id}/${owner.prompt.find((sec) => sec.stage === stage)!.id}.md`;
      expect(fs.readFileSync(path.join(templates, file), 'utf8').split('\n')[0], stage).toBe(`## {{STAGE:${stage}}}：${title}`);
    }
  });
});

describe('stage inserts', () => {
  it('puts the plugin note at the end of the named stage', () => {
    const root = project();
    const text = runPrompt(root, '').prompt.toString('utf8');
    const render = text.indexOf('## 第六阶段');
    const insert = text.indexOf('### 第三方站「假发布」的补充');
    const next = text.indexOf('## 第七阶段');
    expect(render).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(render);
    expect(insert).toBeLessThan(next);
    expect(text.slice(insert, next)).toContain('字幕卡片没有越过安全区');
  });

  it('appends notes for stages the flow does not have', () => {
    // 卡点流程没有配音阶段：插进配音阶段的补充接在最后，并注明原本要插在哪。
    const stations = loadProjectStations(project()).stations.map((st) =>
      st.builtin ? st : { ...st, manifest: { ...st.manifest, inserts: st.manifest.inserts.map((ins) => ({ ...ins, stage: 'voice' })) } },
    );
    const out = composeFlowPrompt({ flow: 'beat', stations, disabled: new Set(), canvas: (t) => t.replaceAll('{{CANVAS}}', '1080×1440').replaceAll('{{ORIENTATION}}', '竖屏') });
    expect(out).toContain('对「TTS 和断句校对」阶段的补充');
    expect(out.indexOf('对「TTS 和断句校对」阶段的补充')).toBeGreaterThan(out.indexOf('## 第十阶段'));
  });
});

describe('plugin flows', () => {
  it('switches the route, first page and production prompt when the project picks the flow', () => {
    const root = project();
    const extras = projectExtras(root);
    expect(detectFlow(root, extras)).toBe('speech');
    setProjectFlow(root, 'fake-publisher');
    expect(detectFlow(root, extras)).toBe('x:fake-publisher');
    expect(route('x:fake-publisher', extras).map((r) => r.node.id)).toEqual(['intake', 'render', 'assemble', 'review', 'gate-final', 'auto-publish']);
    expect(extras.find((x) => x.station.id === 'fake-publisher')?.flow?.first_page).toBe('x:fake-publisher:dashboard');
    const text = runPrompt(root, '').prompt.toString('utf8');
    // am 的公共约定照旧在前，各阶段换成这套流程的。
    expect(text.startsWith('# 完成一次从稿件到成片的')).toBe(true);
    expect(text).toContain('## 工作边界');
    expect(text).toContain('### 渲染器配置');
    expect(text).toContain('## 这部片子的流程：快剪');
    expect(text).toContain('## 第二步：直接出镜头');
    expect(text).not.toContain('## 第六阶段');
    // 去掉这个站就回到自带的流程。
    removeFromProject(root, 'fake-publisher');
    expect(detectFlow(root, projectExtras(root))).toBe('speech');
  });

  it('refuses a station without a flow', () => {
    const root = project();
    expect(() => setProjectFlow(root, 'nope')).toThrow('没有加第三方站 nope');
  });
});

describe('plugin providers, skills and styles', () => {
  it('tells the orchestrator how to use the plugin voice and skills', () => {
    const text = extraPrompt(loadProjectStations(project()).stations);
    expect(text).toContain('TTS_PROVIDER 是 `x:fake-publisher` 时，用 `x_fake_publisher_speak` 合成配音');
    expect(text).toContain('plugin_skills 里加 "fake-publisher/caption-kit"');
  });

  it('resolves opt-in renderer skills per scene and refuses unknown ones', () => {
    const root = project();
    const scene = path.join(root, 'scenes', 'scene-001');
    fs.mkdirSync(scene, { recursive: true });
    expect(pluginSkillsFor(scene, [])).toEqual({});
    expect(pluginSkillsFor(scene, ['fake-publisher/caption-kit'])).toEqual({ 'plugin:fake-publisher/caption-kit': path.join(fake, 'skills/caption-kit') });
    expect(() => pluginSkillsFor(scene, ['fake-publisher/nope'])).toThrow('不在这个项目加的第三方站里');
    const resolved = resolveAllSkills('claude', scene, {}, { film_style: '', timing: null, plugin_skills: ['fake-publisher/caption-kit'] });
    expect(resolved['plugin:fake-publisher/caption-kit']).toBe(path.join(fake, 'skills/caption-kit'));
    expect(pluginSkillSection(resolved)).toContain(`fake-publisher/caption-kit：动手前读 ${path.join(fake, 'skills/caption-kit', 'SKILL.md')}`);
    expect(pluginSkillSection({})).toBe('');
  });

  it('adds the plugin style library as a film style source for this project only', () => {
    const root = project();
    syncStyleSources(root);
    const source = filmstyle.sourceByID('x-fake-publisher');
    expect(source?.name()).toBe('假风格库（插件）');
    expect(source!.catalog()).toEqual([
      { source: 'x-fake-publisher', slug: 'ink', order: 'ink', cn: '水墨', en: 'Ink', category_cn: '国风', category_en: 'Plugin', uses: null, summary: '测试用的插件风格' },
    ]);
    expect(filmstyle.styleKey(filmstyle.lookup('水墨'))).toBe('x-fake-publisher/ink');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ext-style-'));
    temps.push(dir);
    expect(source!.fill(dir, source!.catalog()[0], {})).toBe('fake-publisher@0.1.0');
    expect(fs.readFileSync(path.join(dir, 'STYLE.md'), 'utf8')).toContain('水墨');
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('第三方插件「假发布」');
    // 走装进项目的同一份契约：装成默认风格，镜头就能用。
    const installed = filmstyle.install({ projectDir: root, style: filmstyle.lookup('x-fake-publisher/ink'), now: new Date('2026-11-11T00:00:00Z') });
    expect(installed.manifest).toMatchObject({ source: 'x-fake-publisher', slug: 'ink', cn: '水墨', version: 'fake-publisher@0.1.0' });
    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'am-film-style', 'STYLE.md'))).toBe(true);
    syncStyleSources('');
    expect(filmstyle.sourceByID('x-fake-publisher')).toBeUndefined();
  });
});
