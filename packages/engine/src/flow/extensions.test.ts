import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as filmstyle from '../filmstyle';
import { runPrompt } from '../project/runprompt';
import { resolveAllSkills, pluginSkillSection } from '../scene/skills';
import {
  builtinStations,
  detectFlow,
  extraPrompt,
  composeFlowPrompt,
  installStation,
  recordFlow,
  loadStations,
  MissingPluginFlowError,
  parseManifest,
  pluginSkillsFor,
  removeStation,
  route,
  stageTitles,
  stationExtras,
} from './index';

const fake = path.join(__dirname, 'testdata', 'fake-publisher');
const templates = path.join(__dirname, '..', '..', '..', '..', 'assets', 'prompts');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 一个新建的项目（新建时记下流程与画幅）。插件装在用户级，与项目无关。 */
function bare(flowID = 'speech'): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-ext-')));
  temps.push(root);
  recordFlow(root, { id: flowID, canvas: 'vertical-3x4' });
  fs.writeFileSync(path.join(root, 'onset.conf'), '');
  return root;
}

/** 装上假发布插件，再建一个口播项目。 */
function project(): string {
  installStation(`link:${fake}`);
  return bare();
}

const base = () =>
  ({ id: 'my-step', version: '1', name: '我的一站', ops: [{ name: 'go', summary: 's', command: ['bin/x'] }] }) as Record<string, unknown>;

describe('manifest extensions', () => {
  it('reads every extension of the fake publisher', () => {
    const m = parseManifest(fs.readFileSync(path.join(fake, 'onset-station.json'), 'utf8'));
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
      [{ film_styles: { name: 'n', dir: 'styles', only_referenced: 'yes' } }, 'true 或 false'],
    ];
    expect(parseManifest(JSON.stringify({ ...base(), film_styles: { name: 'n', dir: 'styles', only_referenced: true } })).film_styles).toEqual({ name: 'n', dir: 'styles', only_referenced: true });
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
    project();
    const stations = loadStations().stations.map((st) =>
      st.builtin ? st : { ...st, manifest: { ...st.manifest, inserts: st.manifest.inserts.map((ins) => ({ ...ins, stage: 'voice' })) } },
    );
    const out = composeFlowPrompt({ flow: 'beat', stations, canvas: (t) => t.replaceAll('{{CANVAS}}', '1080×1440').replaceAll('{{ORIENTATION}}', '竖屏') });
    expect(out).toContain('对「TTS 和断句校对」阶段的补充');
    expect(out.indexOf('对「TTS 和断句校对」阶段的补充')).toBeGreaterThan(out.indexOf('## 第十阶段'));
  });
});

describe('plugin flows', () => {
  it('uses the flow a project was created with', () => {
    installStation(`link:${fake}`);
    const root = bare('x:fake-publisher');
    const extras = stationExtras();
    expect(detectFlow(root, extras)).toBe('x:fake-publisher');
    expect(route('x:fake-publisher', extras).map((r) => r.node.id)).toEqual(['intake', 'render', 'assemble', 'review', 'gate-final', 'auto-publish']);
    expect(extras.find((x) => x.station.id === 'fake-publisher')?.flow?.first_page).toBe('x:fake-publisher:dashboard');
    const text = runPrompt(root, '').prompt.toString('utf8');
    // onset 的公共约定照旧在前，各阶段换成这套流程的。
    expect(text.startsWith('# 完成一次从稿件到成片的')).toBe(true);
    expect(text).toContain('## 工作边界');
    expect(text).toContain('### 渲染器配置');
    expect(text).toContain('## 这部片子的流程：快剪');
    expect(text).toContain('## 第二步：直接出镜头');
    expect(text).not.toContain('## 第六阶段');
    // 别的项目照旧是自己的流程。
    expect(detectFlow(bare(), extras)).toBe('speech');
  });

  it('says which plugin is missing when the recorded flow comes from one that is not installed', () => {
    const root = bare('x:fake-publisher');
    expect(() => detectFlow(root, stationExtras())).toThrow(MissingPluginFlowError);
    expect(() => runPrompt(root, '')).toThrow('插件「fake-publisher」带来的做法，这台电脑上没有装这个插件');
    installStation(`link:${fake}`);
    expect(detectFlow(root, stationExtras())).toBe('x:fake-publisher');
    removeStation('fake-publisher');
    expect(() => runPrompt(root, '')).toThrow('没有装这个插件');
  });
});

describe('a plugin flow stays in its own flow', () => {
  /** 假发布的一份拷贝，只带整套流程：不写 after、不顶替。 */
  function flowOnly(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-ext-flow-only-'));
    temps.push(dir);
    fs.cpSync(fake, dir, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'onset-station.json'), 'utf8')) as Record<string, unknown>;
    delete m.after;
    fs.writeFileSync(path.join(dir, 'onset-station.json'), JSON.stringify(m));
    return dir;
  }
  const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

  it('leaves the routes and prompts of other flows exactly as without it', () => {
    const speech = bare();
    const beat = bare('beat');
    const before = [speech, beat].map((root) => {
      const id = detectFlow(root, stationExtras());
      return { route: route(id, stationExtras()).map((r) => r.node.id), prompt: sha(runPrompt(root, '').prompt.toString('utf8')) };
    });
    installStation(`link:${flowOnly()}`);
    const after = [speech, beat].map((root) => {
      const id = detectFlow(root, stationExtras());
      return { route: route(id, stationExtras()).map((r) => r.node.id), prompt: sha(runPrompt(root, '').prompt.toString('utf8')) };
    });
    expect(after).toEqual(before);
    // 它自己的流程照常有它的站点、说明与阶段补充。
    const own = bare('x:fake-publisher');
    expect(route('x:fake-publisher', stationExtras()).map((r) => r.node.id)).toContain('auto-publish');
    const text = runPrompt(own, '').prompt.toString('utf8');
    expect(text).toContain('## 第三方站：假发布');
    expect(text).toContain('### 第三方站「假发布」的补充');
  });

  it('when it cannot be read, only stops projects of its own flow', () => {
    const dir = flowOnly();
    installStation(`link:${dir}`);
    const own = bare('x:fake-publisher');
    const speech = bare();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => runPrompt(own, '')).toThrow('它现在读不出来');
    expect(runPrompt(speech, '').warnings).toHaveLength(1);
  });

  it('still joins other flows when it says where (after or replaces)', () => {
    // 假发布本身写了 after: publish。
    installStation(`link:${fake}`);
    expect(route('speech', stationExtras()).some((r) => r.node.id === 'auto-publish')).toBe(true);
  });
});

describe('installed once, every project', () => {
  it('gives two projects the same stations, tools, pages and styles, and takes them away together', () => {
    installStation(`link:${fake}`);
    const a = bare();
    const b = bare('beat');
    for (const root of [a, b]) {
      const id = detectFlow(root, stationExtras());
      expect(route(id, stationExtras()).some((r) => r.node.id === 'auto-publish'), root).toBe(true);
    }
    const third = loadStations().stations.find((s) => s.manifest.id === 'fake-publisher')!;
    expect(third.manifest.pages.map((pg) => pg.id)).toContain('dashboard');
    expect(runPrompt(a, '').prompt.toString('utf8')).toContain('## 第三方站：假发布');
    expect(runPrompt(b, '').prompt.toString('utf8')).toContain('## 第三方站：假发布');
    expect(filmstyle.sourceByID('x-fake-publisher')).toBeDefined();
    removeStation('fake-publisher');
    for (const root of [a, b]) {
      const id = detectFlow(root, stationExtras());
      expect(route(id, stationExtras()).some((r) => r.node.id === 'auto-publish')).toBe(false);
      expect(runPrompt(root, '').prompt.toString('utf8')).not.toContain('假发布');
    }
    expect(filmstyle.sourceByID('x-fake-publisher')).toBeUndefined();
  });

  it('a plugin that cannot be read only stops the projects it takes part in', () => {
    // 一份拷贝装上（git 来源的做法：记摘要），之后改它的内容：摘要对不上，读不出来。
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-ext-broken-'));
    temps.push(copy);
    fs.cpSync(fake, copy, { recursive: true });
    const got = installStation(`link:${copy}`);
    const installed = path.join(process.env.ONSET_STATIONS_DIR!, 'installed.json');
    const list = JSON.parse(fs.readFileSync(installed, 'utf8')) as { version: 1; plugins: { digest: string }[] };
    list.plugins[0].digest = 'sha256:not-this-one';
    fs.writeFileSync(installed, JSON.stringify(list));
    expect(got.entry.role).toEqual({ flow: true, replaces: '', after: 'publish', nodes: true });
    expect(loadStations().problems.map((p) => p.id)).toEqual(['fake-publisher']);
    // 它接在「发布」后面：口播项目的路线里有发布，开工报错。
    expect(() => runPrompt(bare(), '')).toThrow('第三方插件 fake-publisher：内容和添加时不一样了');
    // 用它的流程新建的项目：说清楚是哪个插件读不出来。
    expect(() => runPrompt(bare('x:fake-publisher'), '')).toThrow('插件「fake-publisher」带来的做法，但它现在读不出来');
  });

  it('a broken plugin that does not touch this flow is only a warning', () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-ext-broken-'));
    temps.push(copy);
    // 只带操作、不进路线的插件。
    fs.writeFileSync(
      path.join(copy, 'onset-station.json'),
      JSON.stringify({ id: 'side-tool', version: '1.0.0', name: '小工具', ops: [{ name: 'go', summary: '做一件事', command: ['bin/go'] }] }),
    );
    fs.mkdirSync(path.join(copy, 'bin'));
    fs.writeFileSync(path.join(copy, 'bin', 'go'), '#!/bin/sh\n', { mode: 0o755 });
    installStation(`link:${copy}`);
    fs.rmSync(copy, { recursive: true, force: true });
    const out = runPrompt(bare(), '');
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('第三方插件 side-tool：本机没有这个插件了');
  });
});

describe('plugin providers, skills and styles', () => {
  it('tells the orchestrator how to use the plugin voice and skills', () => {
    project();
    const text = extraPrompt(loadStations().stations);
    expect(text).toContain('TTS_PROVIDER 是 `x:fake-publisher` 时，用 `x_fake_publisher_speak` 合成配音');
    expect(text).toContain('plugin_skills 里加 "fake-publisher/caption-kit"');
  });

  it('resolves opt-in renderer skills per scene and refuses unknown ones', () => {
    const root = project();
    const scene = path.join(root, 'scenes', 'scene-001');
    fs.mkdirSync(scene, { recursive: true });
    expect(pluginSkillsFor([])).toEqual({});
    expect(pluginSkillsFor(['fake-publisher/caption-kit'])).toEqual({ 'plugin:fake-publisher/caption-kit': path.join(fake, 'skills/caption-kit') });
    expect(() => pluginSkillsFor(['fake-publisher/nope'])).toThrow('不在这台电脑装的插件里');
    const resolved = resolveAllSkills('claude', scene, { ONSET_STATIONS_DIR: process.env.ONSET_STATIONS_DIR! }, { film_style: '', timing: null, plugin_skills: ['fake-publisher/caption-kit'] });
    expect(resolved['plugin:fake-publisher/caption-kit']).toBe(path.join(fake, 'skills/caption-kit'));
    expect(pluginSkillSection(resolved)).toContain(`fake-publisher/caption-kit：动手前读 ${path.join(fake, 'skills/caption-kit', 'SKILL.md')}`);
    expect(pluginSkillSection({})).toBe('');
  });

  it('adds the plugin style library as a film style source for every project and the home page', () => {
    const root = project();
    const source = filmstyle.sourceByID('x-fake-publisher');
    expect(source?.name()).toBe('假风格库（插件）');
    expect(source!.catalog()).toEqual([
      { source: 'x-fake-publisher', slug: 'ink', order: 'ink', cn: '水墨', en: 'Ink', category_cn: '国风', category_en: 'Plugin', uses: null, summary: '测试用的插件风格' },
    ]);
    expect(filmstyle.styleKey(filmstyle.lookup('水墨'))).toBe('x-fake-publisher/ink');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-ext-style-'));
    temps.push(dir);
    expect(source!.fill(dir, source!.catalog()[0], {})).toBe('fake-publisher@0.1.0');
    expect(fs.readFileSync(path.join(dir, 'STYLE.md'), 'utf8')).toContain('水墨');
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('第三方插件「假发布」');
    // 走装进项目的同一份契约：装成默认风格，镜头就能用。
    const installed = filmstyle.install({ projectDir: root, style: filmstyle.lookup('x-fake-publisher/ink'), now: new Date('2026-11-11T00:00:00Z') });
    expect(installed.manifest).toMatchObject({ source: 'x-fake-publisher', slug: 'ink', cn: '水墨', version: 'fake-publisher@0.1.0' });
    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'onset-film-style', 'STYLE.md'))).toBe(true);
    removeStation('fake-publisher');
    expect(filmstyle.sourceByID('x-fake-publisher')).toBeUndefined();
  });
});
